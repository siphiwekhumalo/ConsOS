import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';

const CreateProjectBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  contractForm: z
    .enum(['FIDIC_RED', 'FIDIC_YELLOW', 'FIDIC_SILVER', 'NEC4_ECC', 'JBCC_PBA', 'GCC_2015'])
    .optional(),
  // Money as a decimal string, never a float.
  contractValue: z
    .string()
    .regex(/^\d{1,16}(\.\d{1,2})?$/, 'Use a decimal string, e.g. "1250000.00"')
    .optional(),
});
type CreateProjectBody = z.infer<typeof CreateProjectBody>;

const pct = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'percentage as a decimal string, e.g. "5.00"');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const UpdateProjectBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    status: z.enum(['tender', 'awarded', 'active', 'practical_completion', 'final_account', 'closed']),
    contractForm: CreateProjectBody.shape.contractForm.unwrap().nullable(),
    contractValue: CreateProjectBody.shape.contractValue.unwrap().nullable(),
    retentionPct: pct,
    retentionLimitPct: pct,
    startDate: isoDate.nullable(),
    plannedCompletion: isoDate.nullable(),
  })
  .partial();
type UpdateProjectBody = z.infer<typeof UpdateProjectBody>;

/** Projects are core (not a paid module): every tenant has them. */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  list(@CurrentUser() principal: Principal) {
    return this.db.forTenant(principal.tenantId, (tx) =>
      tx.select().from(schema.projects).orderBy(asc(schema.projects.code)),
    );
  }

  @Post()
  @Roles('owner', 'admin', 'project_manager')
  async create(
    @CurrentUser() principal: Principal,
    @Body(new ZodBodyPipe(CreateProjectBody)) body: CreateProjectBody,
  ) {
    try {
      return await this.db.forTenant(principal.tenantId, async (tx) => {
        const [created] = await tx
          .insert(schema.projects)
          // tenantId always comes from the token, never from the request body.
          .values({ ...body, tenantId: principal.tenantId })
          .returning();
        // Same transaction: the project and its audit record commit together.
        await appendAudit(tx, {
          tenantId: principal.tenantId,
          actorUserId: principal.userId,
          action: 'project.created',
          entityType: 'project',
          entityId: created!.id,
          payload: body,
        });
        return created;
      });
    } catch (err) {
      // Drizzle wraps driver errors; the Postgres code is on `cause`.
      const e = err as { code?: string; cause?: { code?: string } };
      if (e.code === '23505' || e.cause?.code === '23505') {
        throw new ConflictException(`Project code ${body.code} already exists`);
      }
      throw err;
    }
  }

  @Patch(':id')
  @Roles('owner', 'admin', 'project_manager')
  async update(
    @CurrentUser() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(UpdateProjectBody)) body: UpdateProjectBody,
  ) {
    if (Object.keys(body).length === 0) throw new BadRequestException('Nothing to change');
    try {
      return await this.db.forTenant(principal.tenantId, async (tx) => {
        const [before] = await tx.select().from(schema.projects).where(eq(schema.projects.id, id));
        if (!before) throw new NotFoundException('Project not found');
        const [updated] = await tx.update(schema.projects).set(body).where(eq(schema.projects.id, id)).returning();
        const changes = Object.fromEntries(
          Object.keys(body).map((k) => [k, { from: before[k as keyof typeof before] ?? null, to: body[k as keyof UpdateProjectBody] ?? null }]),
        );
        await appendAudit(tx, {
          tenantId: principal.tenantId,
          actorUserId: principal.userId,
          action: body.status && body.status !== before.status ? 'project.status_changed' : 'project.updated',
          entityType: 'project',
          entityId: id,
          payload: { code: before.code, changes },
        });
        return updated;
      });
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      if (e.code === '23514' || e.cause?.code === '23514') {
        throw new BadRequestException('Planned completion must be on or after the start date');
      }
      throw err;
    }
  }
}
