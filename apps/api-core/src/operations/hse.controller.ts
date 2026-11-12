import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx, type UserRole } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { LedgerService, ledgerError } from '../ledger/ledger.service';
import { inspectionOutcome, isOverdue, manHoursFromDiary, reportability, safetyKpis, type Severity } from './calc';

const I = schema.incidents;
const TT = schema.toolboxTalks;
const IN = schema.inspections;
const N = schema.ncrs;
const CA = schema.correctiveActions;
const P = schema.projects;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const SEVERITIES = ['none', 'first_aid', 'medical_treatment', 'restricted_work', 'lost_time', 'fatality'] as const;

const IncidentBody = z.object({
  projectId: z.string().uuid().nullable().optional(),
  occurredAt: z.string().datetime({ offset: true }),
  type: z.enum(['injury', 'near_miss', 'property_damage', 'environmental', 'dangerous_occurrence', 'vehicle']),
  severity: z.enum(SEVERITIES).default('none'),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  location: z.string().trim().max(200).nullable().optional(),
  injuredPerson: z.string().trim().max(200).nullable().optional(),
  daysLost: z.number().int().min(0).max(3650).optional(),
  assetId: z.string().uuid().nullable().optional(),
  immediateCause: z.string().trim().max(2000).nullable().optional(),
  rootCause: z.string().trim().max(2000).nullable().optional(),
});
const IncidentTransition = z.object({ to: z.enum(['investigating', 'closed']) });
const Reported = z.object({ authority: z.enum(['dol', 'coida']), reportedOn: isoDate });
const TalkBody = z.object({
  projectId: z.string().uuid(),
  heldOn: isoDate,
  topic: z.string().trim().min(1).max(200),
  presenter: z.string().trim().min(1).max(100),
  attendees: z.number().int().min(1).max(5000),
  notes: z.string().trim().max(2000).optional(),
});
const InspectionBody = z.object({
  projectId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  kind: z.enum(['safety', 'quality', 'plant_pre_use', 'environmental']),
  title: z.string().trim().min(1).max(200),
  inspectedOn: isoDate,
  items: z.array(z.object({ item: z.string().trim().min(1).max(300), result: z.enum(['pass', 'fail', 'na']), note: z.string().trim().max(500).optional() })).min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
});
const NcrBody = z.object({
  projectId: z.string().uuid(),
  inspectionId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(5000),
  category: z.enum(['workmanship', 'material', 'design', 'procedure', 'documentation', 'other']),
  severity: z.enum(['minor', 'major', 'critical']),
  responsibleParty: z.string().trim().max(200).nullable().optional(),
  supplierId: z.string().uuid().nullable().optional(),
  raisedOn: isoDate,
  dueOn: isoDate.nullable().optional(),
  rootCause: z.string().trim().max(2000).nullable().optional(),
  correctiveAction: z.string().trim().max(2000).nullable().optional(),
  reworkCost: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/).optional(),
});
const NcrTransition = z.object({ to: z.enum(['action_proposed', 'closed']), closedOn: isoDate.optional() });
const ActionBody = z.object({
  sourceType: z.enum(['incident', 'ncr', 'inspection']),
  sourceId: z.string().uuid(),
  action: z.string().trim().min(1).max(1000),
  ownerName: z.string().trim().min(1).max(100),
  dueOn: isoDate,
});
const ActionComplete = z.object({ completedOn: isoDate, note: z.string().trim().max(1000).optional() });

/** Everyone on a job can report and inspect; viewers can read. */
const READERS: UserRole[] = ['owner', 'admin', 'project_manager', 'site_foreman', 'finance', 'viewer'];
const REPORTERS: UserRole[] = ['owner', 'admin', 'project_manager', 'site_foreman', 'finance'];
/** Closing an investigation or verifying an NCR is a management sign-off. */
const SIGN_OFF: UserRole[] = ['owner', 'admin', 'project_manager'];
const today = () => new Date().toISOString().slice(0, 10);

@Controller('hse')
@RequiresModule('mod_hse')
@Roles(...READERS)
export class HseController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ================================================================ dashboard

  /** LTIFR / TRIFR, incident counts, open actions and NCRs for a period (default: last 12 months). */
  @Get('kpis')
  kpis(@CurrentUser() p: Principal, @Query('from') from?: string, @Query('to') to?: string, @Query('projectId') projectId?: string) {
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today();
    const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : `${Number(t.slice(0, 4)) - 1}${t.slice(4)}`;
    return this.db.forTenant(p.tenantId, async (tx) => {
      const D = schema.siteDiaryEntries;
      const [[settings], incidents, diary, actions, ncrs] = await Promise.all([
        tx.select().from(schema.hseSettings),
        tx.select().from(I).where(and(gte(I.occurredAt, new Date(`${f}T00:00:00Z`)), lte(I.occurredAt, new Date(`${t}T23:59:59Z`)), projectId ? eq(I.projectId, projectId) : undefined)),
        tx.select({ workforce: D.workforceCount }).from(D).where(and(gte(D.entryDate, f), lte(D.entryDate, t), projectId ? eq(D.projectId, projectId) : undefined)),
        tx.select().from(CA).where(and(eq(CA.status, 'open'), projectId ? eq(CA.projectId, projectId) : undefined)),
        tx.select().from(N).where(projectId ? eq(N.projectId, projectId) : undefined),
      ]);
      const hours = manHoursFromDiary(diary.map((d) => d.workforce), settings?.hoursPerShift ?? '9');
      const k = safetyKpis(incidents.map((i) => ({ type: i.type, severity: i.severity as Severity, daysLost: i.daysLost, occurredAt: i.occurredAt.toISOString() })), hours, t);
      const byMonth = new Map<string, { month: string; incidents: number; nearMisses: number; recordable: number }>();
      for (const i of incidents) {
        const m = i.occurredAt.toISOString().slice(0, 7);
        const row = byMonth.get(m) ?? { month: m, incidents: 0, nearMisses: 0, recordable: 0 };
        row.incidents++;
        if (i.type === 'near_miss') row.nearMisses++;
        if (['medical_treatment', 'restricted_work', 'lost_time', 'fatality'].includes(i.severity)) row.recordable++;
        byMonth.set(m, row);
      }
      return {
        from: f,
        to: t,
        hoursPerShift: settings?.hoursPerShift ?? '9.0',
        ...k,
        monthly: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
        openInvestigations: incidents.filter((i) => i.status !== 'closed').length,
        unreported: incidents.filter((i) => (i.dolReportable && !i.dolReportedOn) || (i.coidaReportable && !i.coidaReportedOn)).length,
        openActions: actions.length,
        overdueActions: actions.filter((a) => isOverdue(a.dueOn, a.status, today())).length,
        openNcrs: ncrs.filter((n) => n.status !== 'closed').length,
        overdueNcrs: ncrs.filter((n) => isOverdue(n.dueOn, n.status, today())).length,
      };
    });
  }

  @Patch('settings')
  @Roles('owner', 'admin')
  settings(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(z.object({ hoursPerShift: z.string().regex(/^\d{1,2}(\.\d)?$/) }))) body: { hoursPerShift: string }) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      await tx.insert(schema.hseSettings).values({ tenantId: p.tenantId, ...body }).onConflictDoUpdate({ target: schema.hseSettings.tenantId, set: body });
      await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'hse.settings_updated', entityType: 'tenant', entityId: p.tenantId, payload: body });
      return body;
    });
  }

  // ================================================================ incidents

  @Get('incidents')
  incidents(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) =>
      (await tx.select({ i: I, projectCode: P.code }).from(I).leftJoin(P, eq(P.id, I.projectId)).orderBy(desc(I.occurredAt)).limit(500)).map((r) => ({ ...r.i, number: label('INC', r.i.incidentNo), projectCode: r.projectCode })),
    );
  }

  @Get('incidents/:id')
  incident(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadIncident(tx, id));
  }

  /** Report an incident. OHSA s24 and COIDA reportability are flagged from the type and severity. */
  @Post('incidents')
  @Roles(...REPORTERS)
  async report(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(IncidentBody)) body: z.infer<typeof IncidentBody>) {
    if (new Date(body.occurredAt).getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('The incident time is in the future');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const incidentNo = await this.ledger.nextNo(tx, 'incident');
        const [i] = await tx
          .insert(I)
          .values({ ...body, occurredAt: new Date(body.occurredAt), daysLost: body.daysLost ?? 0, tenantId: p.tenantId, incidentNo, reportedBy: p.userId, ...reportability(body.type, body.severity, body.daysLost ?? 0) })
          .returning();
        // No personal information in the audit payload.
        await this.audit(tx, p, 'incident.reported', 'incident', i!.id, { number: label('INC', incidentNo), type: body.type, severity: body.severity, projectId: body.projectId ?? null });
        return this.loadIncident(tx, i!.id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Patch('incidents/:id')
  @Roles(...REPORTERS)
  async updateIncident(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(IncidentBody.partial())) body: Partial<z.infer<typeof IncidentBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getIncident(tx, id);
        const type = body.type ?? cur.type;
        const severity = (body.severity ?? cur.severity) as Severity;
        const daysLost = body.daysLost ?? cur.daysLost;
        await tx
          .update(I)
          .set({ ...body, occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined, ...reportability(type, severity, daysLost) })
          .where(eq(I.id, id));
        await this.audit(tx, p, 'incident.updated', 'incident', id, { number: label('INC', cur.incidentNo), fields: Object.keys(body), severity, daysLost });
        return this.loadIncident(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('incidents/:id/transition')
  @HttpCode(200)
  async transitionIncident(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(IncidentTransition)) body: z.infer<typeof IncidentTransition>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getIncident(tx, id);
        if (body.to === 'investigating') {
          if (!REPORTERS.includes(p.role)) throw new ForbiddenException('Your role cannot start investigations');
          if (cur.status !== 'reported') throw new BadRequestException(`The incident is already ${cur.status}`);
          await tx.update(I).set({ status: 'investigating' }).where(eq(I.id, id));
        } else {
          if (!SIGN_OFF.includes(p.role)) throw new ForbiddenException('Only a project manager or administrator can close an investigation');
          if (!cur.rootCause) throw new BadRequestException('Record the root cause before closing');
          const open = await tx.select({ id: CA.id }).from(CA).where(and(eq(CA.sourceType, 'incident'), eq(CA.sourceId, id), eq(CA.status, 'open')));
          if (open.length) throw new BadRequestException(`${open.length} corrective action(s) are still open`);
          if (cur.severity !== 'none' && cur.severity !== 'first_aid' && (await tx.select({ id: CA.id }).from(CA).where(and(eq(CA.sourceType, 'incident'), eq(CA.sourceId, id)))).length === 0) {
            throw new BadRequestException('A recordable incident needs at least one corrective action before it is closed');
          }
          await tx.update(I).set({ status: 'closed', closedAt: new Date(), closedBy: p.userId }).where(eq(I.id, id));
        }
        await this.audit(tx, p, `incident.${body.to}`, 'incident', id, { number: label('INC', cur.incidentNo) });
        return this.loadIncident(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Record the date the incident was reported to the Department of Employment and Labour or the Compensation Fund. */
  @Post('incidents/:id/reported')
  @HttpCode(200)
  @Roles(...SIGN_OFF)
  async markReported(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Reported)) body: z.infer<typeof Reported>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getIncident(tx, id);
        await tx.update(I).set(body.authority === 'dol' ? { dolReportedOn: body.reportedOn } : { coidaReportedOn: body.reportedOn }).where(eq(I.id, id));
        await this.audit(tx, p, 'incident.reported_to_authority', 'incident', id, { number: label('INC', cur.incidentNo), ...body });
        return this.loadIncident(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ toolbox talks

  @Get('toolbox-talks')
  talks(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) =>
      (await tx.select({ t: TT, projectCode: P.code }).from(TT).innerJoin(P, eq(P.id, TT.projectId)).orderBy(desc(TT.heldOn)).limit(300)).map((r) => ({ ...r.t, projectCode: r.projectCode })),
    );
  }

  @Post('toolbox-talks')
  @Roles(...REPORTERS)
  async addTalk(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(TalkBody)) body: z.infer<typeof TalkBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [t] = await tx.insert(TT).values({ ...body, notes: body.notes ?? '', tenantId: p.tenantId, recordedBy: p.userId }).returning();
        await this.audit(tx, p, 'toolbox_talk.recorded', 'project', body.projectId, { topic: body.topic, attendees: body.attendees, heldOn: body.heldOn });
        return t;
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ inspections

  @Get('inspections')
  inspections(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) =>
      (await tx.select({ i: IN, projectCode: P.code, inspectorName: schema.users.fullName }).from(IN).leftJoin(P, eq(P.id, IN.projectId)).innerJoin(schema.users, eq(schema.users.id, IN.inspector)).orderBy(desc(IN.inspectedOn), desc(IN.inspectionNo)).limit(300))
        .map((r) => ({ ...r.i, number: label('INS', r.i.inspectionNo), projectCode: r.projectCode, inspectorName: r.inspectorName })),
    );
  }

  /** Sign off a completed checklist. It cannot be edited afterwards. */
  @Post('inspections')
  @Roles(...REPORTERS)
  async addInspection(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(InspectionBody)) body: z.infer<typeof InspectionBody>) {
    if (!body.projectId && !body.assetId) throw new BadRequestException('Choose the project or the asset inspected');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const inspectionNo = await this.ledger.nextNo(tx, 'inspection');
        const { failedItems, passed } = inspectionOutcome(body.items);
        const [i] = await tx
          .insert(IN)
          .values({ ...body, notes: body.notes ?? '', tenantId: p.tenantId, inspectionNo, inspector: p.userId, failedItems, passed })
          .returning();
        await this.audit(tx, p, 'inspection.signed', 'inspection', i!.id, { number: label('INS', inspectionNo), kind: body.kind, passed, failedItems });
        return { ...i!, number: label('INS', inspectionNo) };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ NCRs

  @Get('ncrs')
  ncrs(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) =>
      (await tx.select({ n: N, projectCode: P.code }).from(N).innerJoin(P, eq(P.id, N.projectId)).orderBy(desc(N.ncrNo)).limit(500)).map((r) => ({ ...r.n, number: label('NCR', r.n.ncrNo), projectCode: r.projectCode, overdue: isOverdue(r.n.dueOn, r.n.status, today()) })),
    );
  }

  @Get('ncrs/:id')
  ncr(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadNcr(tx, id));
  }

  @Post('ncrs')
  @Roles(...REPORTERS)
  async raiseNcr(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(NcrBody)) body: z.infer<typeof NcrBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const ncrNo = await this.ledger.nextNo(tx, 'ncr');
        const [n] = await tx.insert(N).values({ ...body, tenantId: p.tenantId, ncrNo, raisedBy: p.userId }).returning();
        await this.audit(tx, p, 'ncr.raised', 'ncr', n!.id, { number: label('NCR', ncrNo), severity: body.severity, category: body.category, projectId: body.projectId });
        return this.loadNcr(tx, n!.id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Patch('ncrs/:id')
  @Roles(...REPORTERS)
  async updateNcr(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(NcrBody.partial())) body: Partial<z.infer<typeof NcrBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getNcr(tx, id);
        await tx.update(N).set(body).where(eq(N.id, id));
        await this.audit(tx, p, 'ncr.updated', 'ncr', id, { number: label('NCR', cur.ncrNo), changes: body });
        return this.loadNcr(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** open → action proposed → closed (verified by a project manager or administrator). */
  @Post('ncrs/:id/transition')
  @HttpCode(200)
  async transitionNcr(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(NcrTransition)) body: z.infer<typeof NcrTransition>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getNcr(tx, id);
        if (body.to === 'action_proposed') {
          if (cur.status !== 'open') throw new BadRequestException(`The NCR is ${cur.status.replace('_', ' ')}`);
          if (!cur.correctiveAction) throw new BadRequestException('Describe the corrective action first');
          await tx.update(N).set({ status: 'action_proposed' }).where(eq(N.id, id));
        } else {
          if (!SIGN_OFF.includes(p.role)) throw new ForbiddenException('Only a project manager or administrator can verify and close an NCR');
          if (cur.raisedBy === p.userId && p.role !== 'owner') throw new ForbiddenException('Someone other than the person who raised the NCR must verify it');
          if (cur.status !== 'action_proposed') throw new BadRequestException('Propose the corrective action before closing');
          if (!cur.rootCause) throw new BadRequestException('Record the root cause before closing');
          const open = await tx.select({ id: CA.id }).from(CA).where(and(eq(CA.sourceType, 'ncr'), eq(CA.sourceId, id), eq(CA.status, 'open')));
          if (open.length) throw new BadRequestException(`${open.length} corrective action(s) are still open`);
          await tx.update(N).set({ status: 'closed', verifiedBy: p.userId, closedOn: body.closedOn ?? today() }).where(eq(N.id, id));
        }
        await this.audit(tx, p, `ncr.${body.to}`, 'ncr', id, { number: label('NCR', cur.ncrNo) });
        return this.loadNcr(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ corrective actions

  @Get('actions')
  actions(@CurrentUser() p: Principal, @Query('status') status?: string) {
    if (status && status !== 'open' && status !== 'done') throw new BadRequestException('status is open or done');
    return this.db.forTenant(p.tenantId, async (tx) =>
      (await tx.select({ a: CA, projectCode: P.code }).from(CA).leftJoin(P, eq(P.id, CA.projectId)).where(status ? eq(CA.status, status) : undefined).orderBy(asc(CA.dueOn)).limit(500))
        .map((r) => ({ ...r.a, projectCode: r.projectCode, overdue: isOverdue(r.a.dueOn, r.a.status, today()) })),
    );
  }

  @Post('actions')
  @Roles(...REPORTERS)
  async addAction(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(ActionBody)) body: z.infer<typeof ActionBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const projectId = await this.sourceProject(tx, body.sourceType, body.sourceId);
        const [a] = await tx.insert(CA).values({ ...body, projectId, tenantId: p.tenantId, createdBy: p.userId }).returning();
        await this.audit(tx, p, 'corrective_action.created', body.sourceType, body.sourceId, { action: body.action, dueOn: body.dueOn });
        return a;
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('actions/:id/complete')
  @HttpCode(200)
  @Roles(...REPORTERS)
  async completeAction(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(ActionComplete)) body: z.infer<typeof ActionComplete>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [a] = await tx.update(CA).set({ status: 'done', completedOn: body.completedOn, completionNote: body.note ?? null }).where(eq(CA.id, id)).returning();
        if (!a) throw new NotFoundException('Action not found');
        await this.audit(tx, p, 'corrective_action.completed', a.sourceType, a.sourceId, { action: a.action, completedOn: body.completedOn });
        return a;
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ helpers

  private audit(tx: Tx, p: Principal, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
    return appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action, entityType, entityId, payload });
  }

  private async sourceProject(tx: Tx, type: 'incident' | 'ncr' | 'inspection', id: string) {
    const table = type === 'incident' ? I : type === 'ncr' ? N : IN;
    const [row] = await tx.select({ projectId: table.projectId }).from(table).where(eq(table.id, id));
    if (!row) throw new BadRequestException(`Unknown ${type}`);
    return row.projectId;
  }

  private async getIncident(tx: Tx, id: string) {
    const [i] = await tx.select().from(I).where(eq(I.id, id));
    if (!i) throw new NotFoundException('Incident not found');
    return i;
  }

  private async loadIncident(tx: Tx, id: string) {
    const i = await this.getIncident(tx, id);
    const actions = await tx.select().from(CA).where(and(eq(CA.sourceType, 'incident'), eq(CA.sourceId, id))).orderBy(asc(CA.dueOn));
    return { ...i, number: label('INC', i.incidentNo), actions: actions.map((a) => ({ ...a, overdue: isOverdue(a.dueOn, a.status, today()) })) };
  }

  private async getNcr(tx: Tx, id: string) {
    const [n] = await tx.select().from(N).where(eq(N.id, id));
    if (!n) throw new NotFoundException('NCR not found');
    return n;
  }

  private async loadNcr(tx: Tx, id: string) {
    const n = await this.getNcr(tx, id);
    const [actions, [supplier]] = await Promise.all([
      tx.select().from(CA).where(and(eq(CA.sourceType, 'ncr'), eq(CA.sourceId, id))).orderBy(asc(CA.dueOn)),
      n.supplierId ? tx.select({ name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.id, n.supplierId)) : Promise.resolve([]),
    ]);
    return { ...n, number: label('NCR', n.ncrNo), supplierName: supplier?.name ?? null, overdue: isOverdue(n.dueOn, n.status, today()), actions: actions.map((a) => ({ ...a, overdue: isOverdue(a.dueOn, a.status, today()) })) };
  }
}

const label = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;
