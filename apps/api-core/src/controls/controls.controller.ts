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
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx, type UserRole, type Valuation, type Variation } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { cvr, money, timeBarDaysLeft, valuationFigures } from './calc';
import { commitmentsByCostCode } from '../procurement/commitments';
import { Decimal } from '@constructos/dsl-parser';

const P = schema.projects;
const CC = schema.costCodes;
const CE = schema.costEntries;
const V = schema.variations;
const VAL = schema.valuations;

const amount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string, e.g. "1250.00"');
const signedAmount = z.string().regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string, e.g. "-1250.00"');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');

const CostCodeBody = z.object({
  code: z.string().trim().min(1).max(30),
  description: z.string().trim().min(1).max(300),
  budget: amount.default('0'),
});
const CostCodePatch = CostCodeBody.partial();

const CostBody = z.object({
  costCodeId: z.string().uuid(),
  entryDate: isoDate,
  category: z.enum(['labour', 'material', 'plant', 'subcontract', 'overhead', 'other']),
  description: z.string().trim().min(1).max(300),
  amount: signedAmount.refine((v) => !/^-?0+(\.0+)?$/.test(v), 'amount cannot be zero'),
  reference: z.string().trim().max(100).optional(),
});
const ReverseBody = z.object({ reason: z.string().trim().min(1).max(250) });

const VariationBody = z.object({
  ref: z.string().trim().min(1).max(30),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  instructionRef: z.string().trim().max(100).optional(),
  notifiedOn: isoDate,
  timeBarDays: z.number().int().min(1).max(365).nullable().optional(),
  valueClaimed: signedAmount.optional(),
  costEstimate: signedAmount.optional(),
  costCodeId: z.string().uuid().nullable().optional(),
  timeImpactDays: z.number().int().min(-3650).max(3650).optional(),
});
const VariationPatch = VariationBody.omit({ ref: true }).partial();
const VariationTransition = z.object({
  to: z.enum(['draft', 'submitted', 'approved', 'rejected']),
  valueApproved: signedAmount.optional(),
  note: z.string().trim().max(2000).optional(),
});

const ValuationBody = z.object({
  periodEnd: isoDate,
  workDoneToDate: amount,
  materialsOnSite: amount.optional(),
  notes: z.string().trim().max(5000).optional(),
});
const ValuationPatch = ValuationBody.partial();
const ValuationTransition = z.object({
  to: z.enum(['draft', 'submitted', 'certified', 'paid']),
  /** Client-assessed work done, when the certifier values it differently from the application. */
  certifiedWorkDone: amount.optional(),
  certificateRef: z.string().trim().min(1).max(100).optional(),
  paidOn: isoDate.optional(),
});

/** Who may see project financials. Site foremen and viewers do not. */
const READERS: UserRole[] = ['owner', 'admin', 'project_manager', 'finance'];
const EDITORS: UserRole[] = ['owner', 'admin', 'project_manager', 'finance'];
/** Approving variations and certifying valuations commits money: finance or leadership only. */
const APPROVERS: UserRole[] = ['owner', 'admin', 'finance'];

const pgCode = (err: unknown) => (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;

/**
 * Project controls (Finance & CVR module): budgets by cost code, actual costs,
 * variations, valuations with retention, and the cost-value reconciliation.
 */
@Controller()
@RequiresModule('mod_finance')
@Roles(...READERS)
export class ControlsController {
  constructor(private readonly db: DatabaseService) {}

  // ================================================================ reads

  /** Everything the project's Controls tab needs, in one call. */
  @Get('projects/:projectId/controls')
  get(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, projectId));
  }

  /** Portfolio CVR: one summary row per project. */
  @Get('controls/portfolio')
  portfolio(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const projects = await tx.select().from(P).orderBy(asc(P.code));
      const [codes, entries, vars, vals] = await Promise.all([
        tx.select().from(CC),
        tx.select({ projectId: CE.projectId, costCodeId: CE.costCodeId, amount: CE.amount, entryDate: CE.entryDate }).from(CE),
        tx.select().from(V),
        tx.select().from(VAL),
      ]);
      const commitments = await commitmentsByCostCode(tx);
      const rows = projects.map((proj) => {
        const r = cvr(
          proj,
          codes.filter((c) => c.projectId === proj.id),
          entries.filter((e) => e.projectId === proj.id),
          vars.filter((v) => v.projectId === proj.id),
          vals.filter((v) => v.projectId === proj.id),
          commitments,
        );
        return {
          project: { id: proj.id, code: proj.code, name: proj.name, status: proj.status },
          summary: r.summary,
          overrunCodes: r.costCodes.filter((c) => new Decimal(c.overrun).isNegative()).length,
        };
      });
      const totals = cvr(
        { contractValue: money(projects.reduce((s, x) => s.plus(x.contractValue ?? 0), new Decimal(0))) },
        codes,
        entries,
        vars,
        vals.filter((v) => v.status === 'certified' || v.status === 'paid'),
        commitments,
      );
      // The portfolio "latest certificate" is the sum of each project's latest, not one global latest.
      const sum = (k: 'certifiedValue' | 'retentionHeld' | 'certifiedNet' | 'paidToDate') =>
        money(rows.reduce((s, r) => s.plus(r.summary[k]), new Decimal(0)));
      const certifiedValue = sum('certifiedValue');
      const marginToDate = new Decimal(certifiedValue).minus(totals.summary.costToDate);
      return {
        projects: rows,
        totals: {
          ...totals.summary,
          certifiedValue,
          retentionHeld: sum('retentionHeld'),
          certifiedNet: sum('certifiedNet'),
          paidToDate: sum('paidToDate'),
          marginToDate: money(marginToDate),
          marginToDatePct: new Decimal(certifiedValue).isZero() ? null : marginToDate.dividedBy(certifiedValue).times(100).toFixed(1),
        },
        monthly: totals.monthly,
      };
    });
  }

  // ================================================================ cost codes

  @Post('projects/:projectId/cost-codes')
  addCostCode(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string, @Body(new ZodBodyPipe(CostCodeBody)) body: z.infer<typeof CostCodeBody>) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const [c] = await tx.insert(CC).values({ ...body, projectId, tenantId: p.tenantId }).returning();
      await this.audit(tx, p, 'cost_code.created', 'cost_code', c!.id, { projectId, code: body.code, budget: body.budget });
    }, 'That cost code already exists on this project');
  }

  @Patch('projects/:projectId/cost-codes/:id')
  updateCostCode(
    @CurrentUser() p: Principal,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(CostCodePatch)) body: z.infer<typeof CostCodePatch>,
  ) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const [before] = await tx.select().from(CC).where(and(eq(CC.id, id), eq(CC.projectId, projectId)));
      if (!before) throw new NotFoundException('Cost code not found');
      await tx.update(CC).set(body).where(eq(CC.id, id));
      await this.audit(tx, p, 'cost_code.updated', 'cost_code', id, {
        projectId,
        code: before.code,
        changes: body,
        previousBudget: before.budget,
      });
    }, 'That cost code already exists on this project');
  }

  @Delete('projects/:projectId/cost-codes/:id')
  removeCostCode(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string, @Param('id', ParseUUIDPipe) id: string) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const deleted = await tx.delete(CC).where(and(eq(CC.id, id), eq(CC.projectId, projectId))).returning();
      if (deleted.length === 0) throw new NotFoundException('Cost code not found');
      await this.audit(tx, p, 'cost_code.deleted', 'cost_code', id, { projectId, code: deleted[0]!.code, budget: deleted[0]!.budget });
    });
  }

  /**
   * Seed the budget from the project's locked estimate baseline: one cost code
   * per estimate line, budgeted at the internal takeoff amount.
   */
  @Post('projects/:projectId/cost-codes/from-baseline')
  @HttpCode(200)
  fromBaseline(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const existing = await tx.select({ id: CC.id }).from(CC).where(eq(CC.projectId, projectId)).limit(1);
      if (existing.length) throw new ConflictException('This project already has a budget. Edit the cost codes instead');
      const [est] = await tx
        .select()
        .from(schema.estimates)
        .where(and(eq(schema.estimates.projectId, projectId), eq(schema.estimates.stage, 'baseline_locked')));
      if (!est) throw new BadRequestException('This project has no locked estimate baseline');
      const lines = await tx.select().from(schema.estimateLines).where(eq(schema.estimateLines.estimateId, est.id)).orderBy(asc(schema.estimateLines.lineNo));
      const values = lines.map((l) => ({
        tenantId: p.tenantId,
        projectId,
        code: l.lineNo.slice(0, 30),
        description: l.description.slice(0, 300),
        budget: l.internalQty && l.internalRate ? money(new Decimal(l.internalQty).times(l.internalRate)) : '0.00',
      }));
      if (values.length) await tx.insert(CC).values(values).onConflictDoNothing({ target: [CC.projectId, CC.code] });
      await this.audit(tx, p, 'cost_code.seeded_from_baseline', 'project', projectId, { estimateId: est.id, estimateRef: est.ref, codes: values.length });
    });
  }

  // ================================================================ costs

  @Post('projects/:projectId/costs')
  addCost(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string, @Body(new ZodBodyPipe(CostBody)) body: z.infer<typeof CostBody>) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const [e] = await tx.insert(CE).values({ ...body, projectId, tenantId: p.tenantId, createdBy: p.userId }).returning();
      await this.audit(tx, p, 'cost.posted', 'cost_entry', e!.id, { projectId, ...body });
    });
  }

  /** Costs are never edited or deleted: a correction is a reversing entry. */
  @Post('projects/:projectId/costs/:id/reverse')
  @HttpCode(200)
  reverseCost(
    @CurrentUser() p: Principal,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(ReverseBody)) body: z.infer<typeof ReverseBody>,
  ) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const [orig] = await tx.select().from(CE).where(and(eq(CE.id, id), eq(CE.projectId, projectId)));
      if (!orig) throw new NotFoundException('Cost entry not found');
      if (orig.reversesId) throw new BadRequestException('A reversal cannot itself be reversed');
      const [rev] = await tx
        .insert(CE)
        .values({
          tenantId: p.tenantId,
          projectId,
          costCodeId: orig.costCodeId,
          entryDate: new Date().toISOString().slice(0, 10),
          category: orig.category,
          description: `Reversal: ${body.reason}`.slice(0, 300),
          amount: money(new Decimal(orig.amount).negated()),
          reference: orig.reference,
          source: orig.source,
          reversesId: orig.id,
          createdBy: p.userId,
        })
        .returning();
      await this.audit(tx, p, 'cost.reversed', 'cost_entry', orig.id, { projectId, reversalId: rev!.id, amount: orig.amount, reason: body.reason });
    }, 'This entry has already been reversed');
  }

  // ================================================================ variations

  @Post('projects/:projectId/variations')
  addVariation(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string, @Body(new ZodBodyPipe(VariationBody)) body: z.infer<typeof VariationBody>) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const [v] = await tx.insert(V).values({ ...body, projectId, tenantId: p.tenantId, createdBy: p.userId }).returning();
      await this.audit(tx, p, 'variation.created', 'variation', v!.id, { projectId, ref: body.ref, valueClaimed: body.valueClaimed ?? '0.00' });
    }, 'That variation reference already exists on this project');
  }

  @Patch('projects/:projectId/variations/:id')
  updateVariation(
    @CurrentUser() p: Principal,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(VariationPatch)) body: z.infer<typeof VariationPatch>,
  ) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const v = await this.variation(tx, projectId, id);
      if (v.status !== 'draft' && v.status !== 'submitted') throw new ConflictException(`Variation ${v.ref} is ${v.status} and cannot change`);
      await tx.update(V).set(body).where(eq(V.id, id));
      await this.audit(tx, p, 'variation.updated', 'variation', id, { projectId, ref: v.ref, changes: body });
    });
  }

  @Post('projects/:projectId/variations/:id/transition')
  @HttpCode(200)
  transitionVariation(
    @CurrentUser() p: Principal,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(VariationTransition)) body: z.infer<typeof VariationTransition>,
  ) {
    return this.mutate(p, projectId, async (tx) => {
      const v = await this.variation(tx, projectId, id);
      const key = `${v.status}>${body.to}`;
      const allowed: Record<string, UserRole[]> = {
        'draft>submitted': EDITORS,
        'submitted>draft': EDITORS,
        'submitted>approved': APPROVERS,
        'submitted>rejected': APPROVERS,
      };
      if (!allowed[key]) throw new ConflictException(`Cannot move a ${v.status} variation to ${body.to}`);
      this.requireRole(p, allowed[key]);

      const set: Partial<Variation> = { status: body.to };
      if (body.to === 'submitted') set.submittedAt = new Date();
      if (body.to === 'approved' || body.to === 'rejected') {
        set.decidedAt = new Date();
        set.decidedBy = p.userId;
        set.decisionNote = body.note ?? null;
      }
      if (body.to === 'approved') set.valueApproved = body.valueApproved ?? v.valueClaimed;
      if (body.to === 'rejected' && !body.note) throw new BadRequestException('Give the reason the client rejected it');

      await tx.update(V).set(set).where(eq(V.id, id));
      await this.audit(tx, p, `variation.${body.to}`, 'variation', id, {
        projectId,
        ref: v.ref,
        from: v.status,
        to: body.to,
        valueClaimed: v.valueClaimed,
        valueApproved: set.valueApproved ?? null,
        note: body.note ?? null,
      });
    });
  }

  // ================================================================ valuations

  @Post('projects/:projectId/valuations')
  addValuation(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string, @Body(new ZodBodyPipe(ValuationBody)) body: z.infer<typeof ValuationBody>) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const prior = await tx.select().from(VAL).where(eq(VAL.projectId, projectId)).orderBy(desc(VAL.valuationNo));
      if (prior.some((v) => v.status === 'draft' || v.status === 'submitted')) {
        throw new ConflictException('Certify the open valuation before starting another');
      }
      const lastCert = prior.find((v) => v.status === 'certified' || v.status === 'paid');
      if (lastCert && body.periodEnd <= String(lastCert.periodEnd)) {
        throw new BadRequestException(`Period end must be after valuation ${lastCert.valuationNo} (${lastCert.periodEnd})`);
      }
      const terms = await this.terms(tx, projectId);
      const figures = valuationFigures({
        workDoneToDate: body.workDoneToDate,
        materialsOnSite: body.materialsOnSite ?? '0',
        retentionPct: terms.retentionPct,
        retentionLimitPct: terms.retentionLimitPct,
        contractValue: terms.revisedContractValue,
        previouslyCertified: lastCert?.netToDate ?? '0',
      });
      const valuationNo = (prior[0]?.valuationNo ?? 0) + 1;
      const [v] = await tx
        .insert(VAL)
        .values({
          tenantId: p.tenantId,
          projectId,
          valuationNo,
          periodEnd: body.periodEnd,
          workDoneToDate: body.workDoneToDate,
          materialsOnSite: body.materialsOnSite ?? '0',
          retentionPct: terms.retentionPct,
          previouslyCertified: lastCert?.netToDate ?? '0',
          notes: body.notes ?? '',
          createdBy: p.userId,
          ...figures,
        })
        .returning();
      await this.audit(tx, p, 'valuation.created', 'valuation', v!.id, { projectId, valuationNo, periodEnd: body.periodEnd, ...figures });
    }, 'Another valuation was started at the same time. Reload and try again');
  }

  @Patch('projects/:projectId/valuations/:id')
  updateValuation(
    @CurrentUser() p: Principal,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(ValuationPatch)) body: z.infer<typeof ValuationPatch>,
  ) {
    this.requireRole(p, EDITORS);
    return this.mutate(p, projectId, async (tx) => {
      const v = await this.valuation(tx, projectId, id);
      if (v.status !== 'draft') throw new ConflictException('Only a draft valuation can be edited. Return it to draft first');
      const next = { ...v, ...body };
      const figures = await this.refigure(tx, projectId, next);
      await tx.update(VAL).set({ ...body, ...figures }).where(eq(VAL.id, id));
      await this.audit(tx, p, 'valuation.updated', 'valuation', id, { projectId, valuationNo: v.valuationNo, changes: body, ...figures });
    });
  }

  @Post('projects/:projectId/valuations/:id/transition')
  @HttpCode(200)
  transitionValuation(
    @CurrentUser() p: Principal,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(ValuationTransition)) body: z.infer<typeof ValuationTransition>,
  ) {
    return this.mutate(p, projectId, async (tx) => {
      const v = await this.valuation(tx, projectId, id);
      const key = `${v.status}>${body.to}`;
      const allowed: Record<string, UserRole[]> = {
        'draft>submitted': EDITORS,
        'submitted>draft': EDITORS,
        'submitted>certified': APPROVERS,
        'certified>paid': APPROVERS,
      };
      if (!allowed[key]) throw new ConflictException(`Cannot move a ${v.status} valuation to ${body.to}`);
      this.requireRole(p, allowed[key]);

      const set: Partial<Valuation> = { status: body.to };
      if (body.to === 'submitted') set.submittedAt = new Date();
      if (body.to === 'certified') {
        if (!body.certificateRef) throw new BadRequestException('Enter the payment certificate number');
        set.certificateRef = body.certificateRef;
        set.certifiedAt = new Date();
        set.certifiedBy = p.userId;
        // The certifier may value the work differently from what was applied for.
        const workDoneToDate = body.certifiedWorkDone ?? v.workDoneToDate;
        Object.assign(set, { workDoneToDate }, await this.refigure(tx, projectId, { ...v, workDoneToDate }));
      }
      if (body.to === 'paid') {
        if (!body.paidOn) throw new BadRequestException('Enter the date payment was received');
        set.paidOn = body.paidOn;
      }
      await tx.update(VAL).set(set).where(eq(VAL.id, id));
      await this.audit(tx, p, `valuation.${body.to}`, 'valuation', id, {
        projectId,
        valuationNo: v.valuationNo,
        from: v.status,
        to: body.to,
        appliedWorkDone: v.workDoneToDate,
        certifiedWorkDone: set.workDoneToDate ?? null,
        amountDue: set.amountDue ?? v.amountDue,
        certificateRef: body.certificateRef ?? null,
        paidOn: body.paidOn ?? null,
      });
    });
  }

  // ================================================================ helpers

  private requireRole(p: Principal, roles: UserRole[]) {
    if (!roles.includes(p.role)) throw new ForbiddenException('Your role cannot do this');
  }

  private audit(tx: Tx, p: Principal, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
    return appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action, entityType, entityId, payload });
  }

  private async variation(tx: Tx, projectId: string, id: string) {
    const [v] = await tx.select().from(V).where(and(eq(V.id, id), eq(V.projectId, projectId)));
    if (!v) throw new NotFoundException('Variation not found');
    return v;
  }

  private async valuation(tx: Tx, projectId: string, id: string) {
    const [v] = await tx.select().from(VAL).where(and(eq(VAL.id, id), eq(VAL.projectId, projectId)));
    if (!v) throw new NotFoundException('Valuation not found');
    return v;
  }

  /** Retention terms and the revised contract value (original + approved variations). */
  private async terms(tx: Tx, projectId: string) {
    const [proj] = await tx.select().from(P).where(eq(P.id, projectId));
    if (!proj) throw new NotFoundException('Project not found');
    const approved = await tx
      .select({ valueApproved: V.valueApproved })
      .from(V)
      .where(and(eq(V.projectId, projectId), eq(V.status, 'approved')));
    const revised = proj.contractValue === null
      ? null
      : money(approved.reduce((s, v) => s.plus(v.valueApproved ?? 0), new Decimal(proj.contractValue)));
    return { retentionPct: proj.retentionPct, retentionLimitPct: proj.retentionLimitPct, revisedContractValue: revised };
  }

  private async refigure(tx: Tx, projectId: string, v: Pick<Valuation, 'workDoneToDate' | 'materialsOnSite' | 'retentionPct' | 'previouslyCertified'>) {
    const terms = await this.terms(tx, projectId);
    return valuationFigures({
      workDoneToDate: v.workDoneToDate,
      materialsOnSite: v.materialsOnSite,
      retentionPct: v.retentionPct,
      retentionLimitPct: terms.retentionLimitPct,
      contractValue: terms.revisedContractValue,
      previouslyCertified: v.previouslyCertified,
    });
  }

  private async load(tx: Tx, projectId: string) {
    const [proj] = await tx.select().from(P).where(eq(P.id, projectId));
    if (!proj) throw new NotFoundException('Project not found');
    const [codes, entries, vars, vals] = await Promise.all([
      tx.select().from(CC).where(eq(CC.projectId, projectId)).orderBy(asc(CC.code)),
      tx.select().from(CE).where(eq(CE.projectId, projectId)).orderBy(desc(CE.entryDate), desc(CE.createdAt)),
      tx.select().from(V).where(eq(V.projectId, projectId)).orderBy(desc(V.notifiedOn)),
      tx.select().from(VAL).where(eq(VAL.projectId, projectId)).orderBy(desc(VAL.valuationNo)),
    ]);
    const report = cvr(proj, codes, entries, vars, vals, await commitmentsByCostCode(tx, projectId));
    const reversed = new Set(entries.filter((e) => e.reversesId).map((e) => e.reversesId));
    const codeOf = new Map(codes.map((c) => [c.id, c.code]));
    return {
      project: {
        id: proj.id,
        code: proj.code,
        name: proj.name,
        status: proj.status,
        contractValue: proj.contractValue,
        retentionPct: proj.retentionPct,
        retentionLimitPct: proj.retentionLimitPct,
        startDate: proj.startDate,
        plannedCompletion: proj.plannedCompletion,
      },
      ...report,
      costs: entries.slice(0, 500).map((e) => ({
        id: e.id,
        costCodeId: e.costCodeId,
        costCode: codeOf.get(e.costCodeId) ?? null,
        entryDate: e.entryDate,
        category: e.category,
        description: e.description,
        amount: e.amount,
        reference: e.reference,
        source: e.source,
        reversesId: e.reversesId,
        reversed: reversed.has(e.id),
        createdAt: e.createdAt,
      })),
      variations: vars.map((v) => ({ ...v, timeBarDaysLeft: timeBarDaysLeft(v) })),
      valuations: vals,
    };
  }

  /** Run a write in the tenant's transaction, return the refreshed controls, and map DB errors to HTTP. */
  private async mutate(p: Principal, projectId: string, fn: (tx: Tx) => Promise<void>, duplicateMessage = 'That already exists') {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [proj] = await tx.select({ id: P.id }).from(P).where(eq(P.id, projectId));
        if (!proj) throw new NotFoundException('Project not found');
        await fn(tx);
        return this.load(tx, projectId);
      });
    } catch (err) {
      const code = pgCode(err);
      if (code === '23505') throw new ConflictException(duplicateMessage);
      if (code === '23503') throw new ConflictException('This record is still referenced (for example, a cost code with costs posted against it)');
      if (code === '23514') throw new BadRequestException((err as { cause?: { message?: string } }).cause?.message ?? 'That change breaks a business rule');
      if (code === '42501') throw new ConflictException((err as { cause?: { message?: string } }).cause?.message ?? 'This record is locked');
      throw err;
    }
  }
}
