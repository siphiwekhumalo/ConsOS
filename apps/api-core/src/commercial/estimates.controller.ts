import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type EstimateStage, type Tx, type UserRole } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { analyse, parseAmount } from './variance';

const E = schema.estimates;
const L = schema.estimateLines;

const qty = z.string().regex(/^\d{1,15}(\.\d{1,3})?$/, 'quantity as a decimal string').nullable().optional();
const rate = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'rate as a decimal string').nullable().optional();

const CreateEstimate = z.object({
  ref: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  clientName: z.string().trim().min(1).max(200),
  clientReference: z.string().trim().max(100).optional(),
  sourceFileId: z.string().uuid().optional(),
});
const LineBody = z.object({
  lineNo: z.string().trim().min(1).max(20),
  description: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(20),
  clientQty: qty,
  clientRate: rate,
  internalQty: qty,
  internalRate: rate,
});
const LinePatch = LineBody.partial();
const ImportAi = z.object({ jobId: z.string().uuid() });
const Transition = z.object({
  to: z.enum(['intake', 'technical_review', 'client_approval', 'baseline_locked', 'rejected']),
  note: z.string().trim().max(2000).optional(),
  clientApprovalRef: z.string().trim().min(1).max(100).optional(),
  acknowledgeVariance: z.boolean().optional(),
});

type Transition = z.infer<typeof Transition>;

/**
 * Who may move an estimate between stages. The database separately enforces
 * which transitions exist at all (migration 0005); this adds the approval tiers.
 */
const TRANSITION_ROLES: Record<string, UserRole[]> = {
  'intake>technical_review': ['owner', 'admin', 'project_manager'],
  'technical_review>client_approval': ['owner', 'admin', 'finance'],
  'technical_review>intake': ['owner', 'admin', 'project_manager', 'finance'],
  'client_approval>technical_review': ['owner', 'admin', 'project_manager', 'finance'],
  'client_approval>baseline_locked': ['owner', 'admin'],
  'intake>rejected': ['owner', 'admin'],
  'technical_review>rejected': ['owner', 'admin'],
  'client_approval>rejected': ['owner', 'admin'],
  'rejected>intake': ['owner', 'admin'],
};
const EDITORS: UserRole[] = ['owner', 'admin', 'project_manager', 'finance'];

const pgCode = (err: unknown) => (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;

@Controller('estimates')
@RequiresModule('mod_commercial')
export class EstimatesController {
  constructor(private readonly db: DatabaseService) {}

  // ------------------------------------------------------------------ reads

  /** Pipeline board: every estimate with its live totals and flag count. */
  @Get()
  list(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const rows = await tx.select().from(E).orderBy(desc(E.updatedAt)).limit(500);
      const lines = await tx.select().from(L);
      return rows.map((e) => {
        const { summary } = analyse(lines.filter((l) => l.estimateId === e.id));
        return { ...this.header(e), summary };
      });
    });
  }

  @Get(':id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, id));
  }

  // ------------------------------------------------------------------ intake

  @Post()
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(CreateEstimate)) body: z.infer<typeof CreateEstimate>) {
    this.requireRole(p, EDITORS);
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [e] = await tx
          .insert(E)
          .values({ ...body, tenantId: p.tenantId, createdBy: p.userId })
          .returning();
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'estimate.created',
          entityType: 'estimate',
          entityId: e!.id,
          payload: { ref: body.ref, client: body.clientName },
        });
        return this.load(tx, e!.id);
      });
    } catch (err) {
      if (pgCode(err) === '23505') throw new ConflictException(`Estimate ${body.ref} already exists`);
      if (pgCode(err) === '23503') throw new BadRequestException('Unknown source file');
      throw err;
    }
  }

  // ------------------------------------------------------------------ lines

  @Post(':id/lines')
  addLine(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(LineBody)) body: z.infer<typeof LineBody>) {
    this.requireRole(p, EDITORS);
    return this.mutateLines(p, id, async (tx) => {
      await tx.insert(L).values({ ...body, estimateId: id, tenantId: p.tenantId });
    });
  }

  @Patch(':id/lines/:lineId')
  updateLine(
    @CurrentUser() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body(new ZodBodyPipe(LinePatch)) body: z.infer<typeof LinePatch>,
  ) {
    this.requireRole(p, EDITORS);
    return this.mutateLines(p, id, async (tx) => {
      const updated = await tx.update(L).set(body).where(and(eq(L.id, lineId), eq(L.estimateId, id))).returning({ id: L.id });
      if (updated.length === 0) throw new NotFoundException('Line not found');
    });
  }

  @Delete(':id/lines/:lineId')
  removeLine(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Param('lineId', ParseUUIDPipe) lineId: string) {
    this.requireRole(p, EDITORS);
    return this.mutateLines(p, id, async (tx) => {
      await tx.delete(L).where(and(eq(L.id, lineId), eq(L.estimateId, id)));
    });
  }

  /** Standardise a client JCE: copy lines from an AI BOQ extraction as the client's figures. */
  @Post(':id/import-ai')
  @HttpCode(200)
  importAi(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(ImportAi)) body: z.infer<typeof ImportAi>) {
    this.requireRole(p, EDITORS);
    return this.mutateLines(p, id, async (tx) => {
      const [job] = await tx.select().from(schema.aiJobs).where(eq(schema.aiJobs.id, body.jobId));
      if (!job || job.kind !== 'boq_extraction' || job.status !== 'succeeded' || !job.result) {
        throw new BadRequestException('Choose a completed BOQ extraction');
      }
      const result = job.result as { sections?: { name: string; items: Record<string, string | null>[] }[] };
      const values = (result.sections ?? []).flatMap((s) =>
        s.items.map((it) => ({
          id: randomUUID(),
          tenantId: p.tenantId,
          estimateId: id,
          lineNo: String(it.item_no ?? '').slice(0, 20) || '—',
          description: `${String(it.description ?? '').slice(0, 480)}`,
          unit: String(it.unit ?? 'ea').slice(0, 20) || 'ea',
          clientQty: parseAmount(it.quantity),
          clientRate: parseAmount(it.rate),
          source: 'ai_extraction',
        })),
      );
      const inserted = values.length
        ? await tx.insert(L).values(values).onConflictDoNothing({ target: [L.estimateId, L.lineNo] }).returning({ id: L.id })
        : [];
      await appendAudit(tx, {
        tenantId: p.tenantId,
        actorUserId: p.userId,
        action: 'estimate.lines_imported',
        entityType: 'estimate',
        entityId: id,
        payload: { jobId: body.jobId, imported: inserted.length, skipped: values.length - inserted.length },
      });
    });
  }

  // ------------------------------------------------------------------ workflow

  @Post(':id/transition')
  @HttpCode(200)
  async transition(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Transition)) body: Transition) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const current = await this.load(tx, id);
        const from = current.stage as EstimateStage;
        const allowed = TRANSITION_ROLES[`${from}>${body.to}`];
        if (!allowed) throw new ConflictException(`Cannot move from ${from} to ${body.to}`);
        this.requireRole(p, allowed);
        const s = current.summary;

        // Guards: never let an estimate advance on incomplete or unacknowledged information.
        if (body.to === 'technical_review' && from === 'intake' && s.lines === 0) {
          throw new BadRequestException('Add or import the client’s line items before technical review');
        }
        if (body.to === 'client_approval' && s.flagCounts.missing_internal > 0) {
          throw new BadRequestException(`${s.flagCounts.missing_internal} line(s) have no internal takeoff yet`);
        }
        if (body.to === 'rejected' && !body.note) throw new BadRequestException('Give a reason for rejecting');
        if (body.to === 'baseline_locked') {
          if (!body.clientApprovalRef) throw new BadRequestException('Enter the client approval or PO reference');
          if (s.flaggedLines > 0 && !body.acknowledgeVariance) {
            throw new BadRequestException(`${s.flaggedLines} line(s) are flagged. Acknowledge the variances to lock the baseline`);
          }
          return this.lockBaseline(tx, p, current, body);
        }

        await tx
          .update(E)
          .set({ stage: body.to, rejectionReason: body.to === 'rejected' ? body.note : null })
          .where(eq(E.id, id));
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'estimate.stage_changed',
          entityType: 'estimate',
          entityId: id,
          payload: { ref: current.ref, from, to: body.to, note: body.note ?? null, clientTotal: s.clientTotal, internalTotal: s.internalTotal },
        });
        return this.load(tx, id);
      });
    } catch (err) {
      if (pgCode(err) === '23505') throw new ConflictException('A project with this code already exists');
      throw err;
    }
  }

  /** Freeze scope and baseline costs, and create the project that execution will run against. */
  private async lockBaseline(tx: Tx, p: Principal, current: Awaited<ReturnType<EstimatesController['load']>>, body: Transition) {
    const s = current.summary;
    const projectId = randomUUID();
    await tx.insert(schema.projects).values({
      id: projectId,
      tenantId: p.tenantId,
      code: current.ref,
      name: current.title,
      status: 'awarded',
      contractValue: s.clientTotal,
    });
    await tx
      .update(E)
      .set({
        stage: 'baseline_locked',
        projectId,
        clientApprovalRef: body.clientApprovalRef,
        lockedAt: new Date(),
        lockedBy: p.userId,
        baselineClientTotal: s.clientTotal,
        baselineInternalTotal: s.internalTotal,
      })
      .where(eq(E.id, current.id));
    await appendAudit(tx, {
      tenantId: p.tenantId,
      actorUserId: p.userId,
      action: 'estimate.baseline_locked',
      entityType: 'estimate',
      entityId: current.id,
      payload: {
        ref: current.ref,
        projectId,
        clientApprovalRef: body.clientApprovalRef,
        clientTotal: s.clientTotal,
        internalTotal: s.internalTotal,
        margin: s.margin,
        leakage: s.leakage,
        flaggedLines: s.flaggedLines,
        varianceAcknowledged: Boolean(body.acknowledgeVariance),
        note: body.note ?? null,
      },
    });
    return this.load(tx, current.id);
  }

  // ------------------------------------------------------------------ helpers

  private requireRole(p: Principal, roles: UserRole[]) {
    if (!roles.includes(p.role)) throw new ForbiddenException('Your role cannot approve this step');
  }

  private header(e: typeof E.$inferSelect) {
    return {
      id: e.id,
      ref: e.ref,
      title: e.title,
      clientName: e.clientName,
      clientReference: e.clientReference,
      stage: e.stage,
      projectId: e.projectId,
      clientApprovalRef: e.clientApprovalRef,
      rejectionReason: e.rejectionReason,
      baselineClientTotal: e.baselineClientTotal,
      baselineInternalTotal: e.baselineInternalTotal,
      lockedAt: e.lockedAt,
      lockedBy: e.lockedBy,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }

  private async load(tx: Tx, id: string) {
    const [e] = await tx.select().from(E).where(eq(E.id, id));
    if (!e) throw new NotFoundException('Estimate not found');
    const lines = await tx.select().from(L).where(eq(L.estimateId, id)).orderBy(asc(L.lineNo));
    const { lines: views, summary } = analyse(lines);
    return { ...this.header(e), summary, lines: views };
  }

  private async mutateLines(p: Principal, id: string, fn: (tx: Tx) => Promise<void>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [e] = await tx.select({ stage: E.stage }).from(E).where(eq(E.id, id));
        if (!e) throw new NotFoundException('Estimate not found');
        if (e.stage !== 'intake' && e.stage !== 'technical_review') {
          throw new ConflictException('Lines are frozen once an estimate goes to the client');
        }
        await fn(tx);
        return this.load(tx, id);
      });
    } catch (err) {
      if (pgCode(err) === '23505') throw new ConflictException('That line number already exists on this estimate');
      if (pgCode(err) === '42501') throw new ConflictException('Lines are frozen at this stage');
      throw err;
    }
  }
}
