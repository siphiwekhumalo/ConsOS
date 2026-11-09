import { Body, ConflictException, Controller, Get, Post } from '@nestjs/common';
import { asc } from 'drizzle-orm';
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
}
