import { BadRequestException, Body, ConflictException, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';

const CreateEntry = z.object({
  id: z.string().uuid().optional(), // client-generated → idempotent retries
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weather: z.enum(['clear', 'cloudy', 'rain', 'storm', 'wind', 'extreme_heat']).optional(),
  workforceCount: z.number().int().min(0).max(100000).optional(),
  workCompleted: z.string().max(20000).default(''),
  delays: z.string().max(20000).default(''),
  safetyNotes: z.string().max(20000).default(''),
});
type CreateEntry = z.infer<typeof CreateEntry>;

/**
 * Site diary for the web app (online). Field devices use the edge-sync
 * service, which writes the same table; both paths are idempotent on `id`.
 */
@Controller('projects/:projectId/diary')
@RequiresModule('mod_field')
export class DiaryController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  list(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string) {
    const d = schema.siteDiaryEntries;
    return this.db.forTenant(p.tenantId, (tx) =>
      tx
        .select()
        .from(d)
        .where(and(eq(d.projectId, projectId)))
        .orderBy(desc(d.entryDate), desc(d.createdAt))
        .limit(200),
    );
  }

  @Post()
  @Roles('owner', 'admin', 'project_manager', 'site_foreman')
  async create(
    @CurrentUser() p: Principal,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body(new ZodBodyPipe(CreateEntry)) body: CreateEntry,
  ) {
    const id = body.id ?? randomUUID();
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inserted = await tx
          .insert(schema.siteDiaryEntries)
          .values({ ...body, id, projectId, tenantId: p.tenantId, createdBy: p.userId, deviceId: 'web' })
          .onConflictDoNothing({ target: schema.siteDiaryEntries.id })
          .returning();
        if (inserted.length === 0) {
          // Retry of an entry we already have: return it unchanged.
          const [existing] = await tx
            .select()
            .from(schema.siteDiaryEntries)
            .where(eq(schema.siteDiaryEntries.id, id));
          if (!existing) throw new ConflictException('Entry id already used');
          return existing;
        }
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'diary.created',
          entityType: 'site_diary_entry',
          entityId: id,
          payload: { projectId, entryDate: body.entryDate, source: 'web' },
        });
        return inserted[0];
      });
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === '23503') {
        throw new BadRequestException('Unknown project');
      }
      throw err;
    }
  }
}
