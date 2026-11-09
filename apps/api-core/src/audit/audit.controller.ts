import { Controller, Get, Query } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { schema, verifyAuditChain } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';

const ListQuery = z.object({
  entityType: z.string().max(60).optional(),
  entityId: z.string().uuid().optional(),
  beforeSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
type ListQuery = z.infer<typeof ListQuery>;

@Controller('audit')
@Roles('owner', 'admin', 'finance')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  /** Newest-first page of the tenant's audit trail. Paginate with ?beforeSeq=. */
  @Get('events')
  list(@CurrentUser() p: Principal, @Query(new ZodBodyPipe(ListQuery)) q: ListQuery) {
    const e = schema.auditEvents;
    return this.db.forTenant(p.tenantId, (tx) =>
      tx
        .select({
          seq: e.seq,
          occurredAt: e.occurredAt,
          actorUserId: e.actorUserId,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          payload: e.payload,
        })
        .from(e)
        .where(
          and(
            q.entityType ? eq(e.entityType, q.entityType) : undefined,
            q.entityId ? eq(e.entityId, q.entityId) : undefined,
            q.beforeSeq ? lt(e.seq, q.beforeSeq) : undefined,
          ),
        )
        .orderBy(desc(e.seq))
        .limit(q.limit),
    );
  }

  /** Recompute the tenant's hash chain. Evidence for FIDIC/NEC disputes and auditors. */
  @Get('verify')
  @Roles('owner', 'admin')
  verify(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const result = await verifyAuditChain(tx);
      return { ...result, intact: result.firstBrokenSeq === null, verifiedAt: new Date().toISOString() };
    });
  }
}
