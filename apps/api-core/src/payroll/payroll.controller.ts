import {
  BadRequestException,
  Body,
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
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx, type UserRole } from '@constructos/db';
import { Decimal } from '@constructos/dsl-parser';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { LedgerService, ledgerError } from '../ledger/ledger.service';
import { ensureSystemAccounts } from '../ledger/chart';
import { allocate, leaveBalances, monthBounds, payslip, taxYearFor, workingDays } from './calc';

const E = schema.employees;
const EP = schema.employeePrivate;
const C = schema.certifications;
const L = schema.leaveRequests;
const TE = schema.timeEntries;
const PR = schema.payRuns;
const PS = schema.payslips;
const S = schema.payrollSettings;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const hours = z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'hours, e.g. 8 or 7.5');
const money = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'amount as a decimal string');

const PrivateBody = z.object({
  idNumber: z.string().regex(/^\d{13}$/, 'a South African ID number has 13 digits').nullable().optional(),
  passportNo: z.string().trim().max(20).nullable().optional(),
  taxNumber: z.string().regex(/^\d{10}$/, 'a SARS tax reference has 10 digits').nullable().optional(),
  dateOfBirth: isoDate,
});
const EmployeeBody = z.object({
  employeeNo: z.string().trim().min(1).max(20),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  occupation: z.string().trim().min(1).max(100),
  employmentType: z.enum(['permanent', 'fixed_term', 'casual']),
  payBasis: z.enum(['monthly', 'hourly']),
  rate: money.refine((v) => Number(v) > 0, 'the rate must be more than zero'),
  medicalAidMembers: z.number().int().min(0).max(20).optional(),
  startDate: isoDate,
  defaultProjectId: z.string().uuid().nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  private: PrivateBody,
});
const EmployeePatch = EmployeeBody.omit({ private: true }).partial().extend({ private: PrivateBody.partial().optional() });
const Terminate = z.object({ endDate: isoDate, reason: z.string().trim().min(1).max(500) });
const CertBody = z.object({
  kind: z.string().trim().min(1).max(100),
  certificateNo: z.string().trim().max(60).nullable().optional(),
  issuedOn: isoDate,
  expiresOn: isoDate.nullable().optional(),
});
const LeaveBody = z.object({
  employeeId: z.string().uuid(),
  kind: z.enum(['annual', 'sick', 'family_responsibility', 'unpaid']),
  startsOn: isoDate,
  endsOn: isoDate,
  days: z.string().regex(/^\d{1,3}(\.5)?$/).optional(),
  note: z.string().trim().max(500).optional(),
});
const Decide = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(500).optional() });
const TimeBody = z.object({
  entries: z
    .array(
      z.object({
        employeeId: z.string().uuid(),
        projectId: z.string().uuid(),
        costCodeId: z.string().uuid(),
        workDate: isoDate,
        normalHours: hours.optional(),
        overtimeHours: hours.optional(),
        sundayHours: hours.optional(),
        note: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(500),
});
const Ids = z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) });
const RunBody = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period as YYYY-MM'), payDate: isoDate });
const SettingsBody = z.object({
  sdlLiable: z.boolean(),
  monthlyHours: z.string().regex(/^\d{3}(\.\d)?$/),
  payeReference: z.string().regex(/^7\d{9}$/, 'a PAYE reference is 10 digits starting with 7').nullable(),
  uifReference: z.string().trim().max(20).nullable(),
}).partial();

/** Pay, personal details and pay runs: finance and leadership only. */
const PAYROLL: UserRole[] = ['owner', 'admin', 'finance'];
/** People on site: who works here, their tickets, their time and leave. */
const WORKFORCE: UserRole[] = ['owner', 'admin', 'finance', 'project_manager', 'site_foreman'];
const APPROVERS: UserRole[] = ['owner', 'admin', 'project_manager'];
const today = () => new Date().toISOString().slice(0, 10);

@Controller('payroll')
@RequiresModule('mod_payroll')
@Roles(...WORKFORCE)
export class PayrollController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ================================================================ employees

  /** Everyone on the books, without pay or personal details unless the caller handles payroll. */
  @Get('employees')
  employees(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [rows, certs] = await Promise.all([
        tx.select().from(E).orderBy(asc(E.lastName), asc(E.firstName)),
        tx.select({ employeeId: C.employeeId, kind: C.kind, expiresOn: C.expiresOn }).from(C),
      ]);
      const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      return rows.map((e) => ({
        ...this.visible(p, e),
        expiredCertifications: certs.filter((c) => c.employeeId === e.id && c.expiresOn && c.expiresOn < today()).map((c) => c.kind),
        expiringCertifications: certs.filter((c) => c.employeeId === e.id && c.expiresOn && c.expiresOn >= today() && c.expiresOn <= soon).map((c) => c.kind),
      }));
    });
  }

  @Get('employees/:id')
  employee(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadEmployee(tx, p, id));
  }

  @Post('employees')
  @Roles(...PAYROLL)
  async addEmployee(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(EmployeeBody)) body: z.infer<typeof EmployeeBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const { private: priv, ...rest } = body;
        const [e] = await tx.insert(E).values({ ...rest, tenantId: p.tenantId }).returning();
        await tx.insert(EP).values({ ...priv, employeeId: e!.id, tenantId: p.tenantId });
        // Personal details never go into the audit payload.
        await this.audit(tx, p, 'employee.created', e!.id, { employeeNo: body.employeeNo, payBasis: body.payBasis, startDate: body.startDate });
        return this.loadEmployee(tx, p, e!.id);
      });
    } catch (err) {
      ledgerError(err, `Employee number ${body.employeeNo} is already used`);
    }
  }

  @Patch('employees/:id')
  @Roles(...PAYROLL)
  async updateEmployee(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(EmployeePatch)) body: z.infer<typeof EmployeePatch>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const e = await this.getEmployee(tx, id);
        if (e.status === 'terminated') throw new BadRequestException('A terminated employee cannot be edited');
        const { private: priv, ...rest } = body;
        if (Object.keys(rest).length) await tx.update(E).set(rest).where(eq(E.id, id));
        if (priv && Object.keys(priv).length) await tx.update(EP).set(priv).where(eq(EP.employeeId, id));
        await this.audit(tx, p, 'employee.updated', id, {
          employeeNo: e.employeeNo,
          fields: [...Object.keys(rest), ...Object.keys(priv ?? {}).map((k) => `private.${k}`)],
          ...(rest.rate ? { previousRate: e.rate, rate: rest.rate } : {}),
        });
        return this.loadEmployee(tx, p, id);
      });
    } catch (err) {
      ledgerError(err, 'That employee number is already used');
    }
  }

  @Post('employees/:id/terminate')
  @HttpCode(200)
  @Roles(...PAYROLL)
  async terminate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Terminate)) body: z.infer<typeof Terminate>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const e = await this.getEmployee(tx, id);
        if (e.status === 'terminated') throw new BadRequestException('Already terminated');
        await tx.update(E).set({ status: 'terminated', endDate: body.endDate, terminationReason: body.reason }).where(eq(E.id, id));
        await this.audit(tx, p, 'employee.terminated', id, { employeeNo: e.employeeNo, endDate: body.endDate });
        return this.loadEmployee(tx, p, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ certifications

  @Post('employees/:id/certifications')
  @Roles('owner', 'admin', 'finance', 'project_manager')
  async addCert(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(CertBody)) body: z.infer<typeof CertBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        await this.getEmployee(tx, id);
        await tx.insert(C).values({ ...body, tenantId: p.tenantId, employeeId: id });
        await this.audit(tx, p, 'certification.added', id, { kind: body.kind, expiresOn: body.expiresOn ?? null });
        return this.loadEmployee(tx, p, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Delete('certifications/:certId')
  @Roles('owner', 'admin', 'finance', 'project_manager')
  async removeCert(@CurrentUser() p: Principal, @Param('certId', ParseUUIDPipe) certId: string) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [c] = await tx.delete(C).where(eq(C.id, certId)).returning();
      if (!c) throw new NotFoundException('Certification not found');
      await this.audit(tx, p, 'certification.removed', c.employeeId, { kind: c.kind });
      return this.loadEmployee(tx, p, c.employeeId);
    });
  }

  // ================================================================ leave

  @Get('leave')
  leave(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) =>
      (await tx.select({ l: L, firstName: E.firstName, lastName: E.lastName, employeeNo: E.employeeNo }).from(L).innerJoin(E, eq(E.id, L.employeeId)).orderBy(desc(L.startsOn)).limit(500))
        .map((r) => ({ ...r.l, employeeName: `${r.firstName} ${r.lastName}`, employeeNo: r.employeeNo })),
    );
  }

  @Post('leave')
  async requestLeave(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(LeaveBody)) body: z.infer<typeof LeaveBody>) {
    if (body.endsOn < body.startsOn) throw new BadRequestException('The leave ends before it starts');
    const days = body.days ?? String(workingDays(body.startsOn, body.endsOn));
    if (Number(days) <= 0) throw new BadRequestException('The leave covers no working days');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const e = await this.getEmployee(tx, body.employeeId);
        if (e.status === 'terminated') throw new BadRequestException('The employee has been terminated');
        const [l] = await tx.insert(L).values({ ...body, days, tenantId: p.tenantId, createdBy: p.userId }).returning();
        await this.audit(tx, p, 'leave.requested', body.employeeId, { kind: body.kind, startsOn: body.startsOn, endsOn: body.endsOn, days });
        return l;
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Approve or reject. Approval warns nothing: balances are shown to the approver, and unpaid leave covers shortfalls. */
  @Post('leave/:id/decide')
  @HttpCode(200)
  @Roles(...APPROVERS)
  async decide(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Decide)) body: z.infer<typeof Decide>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [cur] = await tx.select().from(L).where(eq(L.id, id));
        if (!cur) throw new NotFoundException('Leave request not found');
        if (cur.status !== 'requested') throw new BadRequestException(`The request is already ${cur.status}`);
        if (cur.createdBy === p.userId && p.role !== 'owner') throw new ForbiddenException('Someone other than the person who captured the request must decide it');
        const [l] = await tx.update(L).set({ status: body.decision, decidedBy: p.userId, note: body.note ?? cur.note }).where(eq(L.id, id)).returning();
        await this.audit(tx, p, `leave.${body.decision}`, cur.employeeId, { kind: cur.kind, startsOn: cur.startsOn, days: cur.days });
        return l;
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('leave/:id/cancel')
  @HttpCode(200)
  async cancelLeave(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [cur] = await tx.select().from(L).where(eq(L.id, id));
        if (!cur) throw new NotFoundException('Leave request not found');
        if (cur.status === 'approved' && !APPROVERS.includes(p.role)) throw new ForbiddenException('Only an approver can cancel approved leave');
        const [l] = await tx.update(L).set({ status: 'cancelled' }).where(eq(L.id, id)).returning();
        await this.audit(tx, p, 'leave.cancelled', cur.employeeId, { kind: cur.kind, startsOn: cur.startsOn });
        return l;
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ timesheets

  /** Cost codes to book time to (codes and descriptions only, no financials). */
  @Get('projects/:projectId/cost-codes')
  costCodes(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string) {
    const CC = schema.costCodes;
    return this.db.forTenant(p.tenantId, (tx) =>
      tx.select({ id: CC.id, code: CC.code, description: CC.description }).from(CC).where(eq(CC.projectId, projectId)).orderBy(asc(CC.code)),
    );
  }

  @Get('timesheets')
  timesheets(@CurrentUser() p: Principal, @Query('from') from?: string, @Query('to') to?: string, @Query('projectId') projectId?: string, @Query('status') status?: string) {
    const f = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    const t = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : today();
    if (status && !['submitted', 'approved', 'rejected'].includes(status)) throw new BadRequestException('Unknown status');
    return this.db.forTenant(p.tenantId, async (tx) =>
      (
        await tx
          .select({ t: TE, firstName: E.firstName, lastName: E.lastName, employeeNo: E.employeeNo, projectCode: schema.projects.code, costCode: schema.costCodes.code })
          .from(TE)
          .innerJoin(E, eq(E.id, TE.employeeId))
          .innerJoin(schema.projects, eq(schema.projects.id, TE.projectId))
          .leftJoin(schema.costCodes, eq(schema.costCodes.id, TE.costCodeId))
          .where(and(gte(TE.workDate, f), lte(TE.workDate, t), projectId ? eq(TE.projectId, projectId) : undefined, status ? eq(TE.status, status) : undefined))
          .orderBy(desc(TE.workDate), asc(E.lastName))
          .limit(2000)
      ).map((r) => ({ ...r.t, employeeName: `${r.firstName} ${r.lastName}`, employeeNo: r.employeeNo, projectCode: r.projectCode, costCode: r.costCode })),
    );
  }

  /** Capture a crew's day (or week) of time in one go. */
  @Post('timesheets')
  async capture(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(TimeBody)) body: z.infer<typeof TimeBody>) {
    if (body.entries.some((e) => e.workDate > today())) throw new BadRequestException('Time cannot be captured for future dates');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const rows = await tx
          .insert(TE)
          .values(body.entries.map((e) => ({ ...e, normalHours: e.normalHours ?? '0', overtimeHours: e.overtimeHours ?? '0', sundayHours: e.sundayHours ?? '0', tenantId: p.tenantId, capturedBy: p.userId })))
          .returning({ id: TE.id });
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'timesheet.captured', entityType: 'project', entityId: body.entries[0]!.projectId, payload: { entries: rows.length } });
        return { captured: rows.length };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('timesheets/approve')
  @HttpCode(200)
  @Roles(...APPROVERS)
  approve(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(Ids)) body: z.infer<typeof Ids>) {
    return this.decideTime(p, body.ids, 'approved');
  }

  @Post('timesheets/reject')
  @HttpCode(200)
  @Roles(...APPROVERS)
  reject(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(Ids)) body: z.infer<typeof Ids>) {
    return this.decideTime(p, body.ids, 'rejected');
  }

  @Delete('timesheets/:id')
  async removeTime(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [t] = await tx.select().from(TE).where(eq(TE.id, id));
        if (!t) throw new NotFoundException('Time entry not found');
        if (t.status === 'approved') throw new BadRequestException('Approved time cannot be deleted');
        await tx.delete(TE).where(eq(TE.id, id));
        return { deleted: true };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  private async decideTime(p: Principal, ids: string[], status: 'approved' | 'rejected') {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const rows = await tx.select().from(TE).where(inArray(TE.id, ids));
        const open = rows.filter((r) => r.status === 'submitted');
        if (open.some((r) => r.capturedBy === p.userId) && p.role !== 'owner') {
          throw new ForbiddenException('Time you captured must be approved by someone else');
        }
        if (open.length) await tx.update(TE).set({ status, approvedBy: status === 'approved' ? p.userId : null }).where(inArray(TE.id, open.map((r) => r.id)));
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: `timesheet.${status}`, entityType: 'tenant', entityId: p.tenantId, payload: { entries: open.length } });
        return { [status]: open.length, skipped: ids.length - open.length };
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ settings

  @Get('settings')
  @Roles(...PAYROLL)
  settings(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [s] = await tx.select().from(S);
      const tables = await tx.select({ taxYear: schema.taxTables.taxYear, startsOn: schema.taxTables.startsOn, endsOn: schema.taxTables.endsOn, source: schema.taxTables.source }).from(schema.taxTables).orderBy(desc(schema.taxTables.startsOn));
      return { sdlLiable: s?.sdlLiable ?? true, monthlyHours: s?.monthlyHours ?? '195.0', payeReference: s?.payeReference ?? null, uifReference: s?.uifReference ?? null, taxTables: tables };
    });
  }

  @Patch('settings')
  @Roles('owner', 'admin')
  async updateSettings(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(SettingsBody)) body: z.infer<typeof SettingsBody>) {
    await this.db.forTenant(p.tenantId, async (tx) => {
      await tx.insert(S).values({ tenantId: p.tenantId, ...body }).onConflictDoUpdate({ target: S.tenantId, set: body });
      await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'payroll.settings_updated', entityType: 'tenant', entityId: p.tenantId, payload: body });
    });
    return this.settings(p);
  }

  // ================================================================ pay runs

  @Get('pay-runs')
  @Roles(...PAYROLL)
  runs(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, (tx) => tx.select().from(PR).orderBy(desc(PR.period)));
  }

  @Get('pay-runs/:id')
  @Roles(...PAYROLL)
  run(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadRun(tx, id));
  }

  /** Draft a month's payroll from current rates, approved time and approved unpaid leave. */
  @Post('pay-runs')
  @Roles(...PAYROLL)
  async createRun(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(RunBody)) body: z.infer<typeof RunBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const taxYear = await this.taxYear(tx, body.payDate);
        const [run] = await tx.insert(PR).values({ ...body, taxYear, tenantId: p.tenantId, createdBy: p.userId }).returning();
        await this.calculate(tx, p, run!.id);
        await appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action: 'pay_run.drafted', entityType: 'pay_run', entityId: run!.id, payload: { period: body.period, payDate: body.payDate, taxYear } });
        return this.loadRun(tx, run!.id);
      });
    } catch (err) {
      ledgerError(err, `There is already a pay run for ${body.period}`);
    }
  }

  @Post('pay-runs/:id/recalculate')
  @HttpCode(200)
  @Roles(...PAYROLL)
  async recalculate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        await this.calculate(tx, p, id);
        return this.loadRun(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Finalise: freezes the month (payslips, time, leave), charges each employee's
   * cost to projects by approved hours (labour), and posts the payroll journal:
   * Dr labour / head-office salaries, Cr PAYE+UIF+SDL payable, Cr net wages payable.
   */
  @Post('pay-runs/:id/finalise')
  @HttpCode(200)
  @Roles(...PAYROLL)
  async finalise(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const run = await this.getRun(tx, id);
        if (run.status === 'finalised') throw new BadRequestException('Already finalised');
        const { from, to } = monthBounds(run.period);
        const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(TE).where(and(gte(TE.workDate, from), lte(TE.workDate, to), eq(TE.status, 'submitted')));
        if (pending!.n > 0) throw new BadRequestException(`${pending!.n} timesheet entries for ${run.period} are still awaiting approval`);
        // Recalculate so the payslips reflect exactly what is being frozen.
        await this.calculate(tx, p, id);
        const slips = await tx.select().from(PS).where(eq(PS.payRunId, id));
        if (!slips.length) throw new BadRequestException('There are no payslips to finalise');

        // Labour cost per project cost code, by approved hours.
        const time = await tx.select().from(TE).where(and(gte(TE.workDate, from), lte(TE.workDate, to), eq(TE.status, 'approved')));
        const projectCosts = new Map<string, InstanceType<typeof Decimal>>();
        let overhead = new Decimal(0);
        for (const s of slips) {
          const mine = time.filter((t) => t.employeeId === s.employeeId);
          const byKey = new Map<string, InstanceType<typeof Decimal>>();
          for (const t of mine) {
            const key = `${t.projectId}|${t.costCodeId}`;
            byKey.set(key, (byKey.get(key) ?? new Decimal(0)).plus(t.normalHours).plus(t.overtimeHours).plus(t.sundayHours));
          }
          const parts = allocate(s.employerCost, [...byKey.entries()].map(([key, h]) => ({ key, hours: h.toFixed(2) })));
          const allocated = parts.reduce((a, x) => a.plus(x.amount), new Decimal(0));
          for (const part of parts) projectCosts.set(part.key, (projectCosts.get(part.key) ?? new Decimal(0)).plus(part.amount));
          overhead = overhead.plus(new Decimal(s.employerCost).minus(allocated));
        }
        const costEntries = [...projectCosts.entries()].filter(([, v]) => v.greaterThan(0));
        if (costEntries.length) {
          await tx.insert(schema.costEntries).values(
            costEntries.map(([key, amount]) => {
              const [projectId, costCodeId] = key.split('|') as [string, string];
              return {
                tenantId: p.tenantId,
                projectId,
                costCodeId,
                entryDate: to,
                category: 'labour' as const,
                description: `Payroll ${run.period}: labour (incl. UIF and SDL)`,
                amount: amount.toFixed(2),
                reference: `PAY ${run.period}`,
                source: 'payroll',
                sourceId: id,
                createdBy: p.userId,
              };
            }),
          );
        }

        let journalId: string | null = null;
        if (await ensureSystemAccounts(tx, p.tenantId, ['payroll_liabilities', 'wages_payable', 'salaries_overhead', 'cost_labour'])) {
          const keys = await this.ledger.systemAccounts(tx, ['payroll_liabilities', 'wages_payable', 'salaries_overhead', 'cost_labour']);
          const sum = (k: 'paye' | 'uifEmployee' | 'uifEmployer' | 'sdl' | 'net') => slips.reduce((a, s) => a.plus(s[k]), new Decimal(0));
          const liabilities = sum('paye').plus(sum('uifEmployee')).plus(sum('uifEmployer')).plus(sum('sdl'));
          const journal = await this.ledger.post(tx, p, { entryDate: to, description: `Payroll ${run.period}`, source: 'payroll', sourceId: id }, [
            ...costEntries.map(([key, amount]) => ({ accountId: keys.cost_labour, amount: amount.toFixed(2), projectId: key.split('|')[0], description: 'Site labour' })),
            { accountId: keys.salaries_overhead, amount: overhead.toFixed(2), description: 'Salaries not on project timesheets' },
            { accountId: keys.payroll_liabilities, amount: liabilities.negated().toFixed(2), description: 'PAYE, UIF and SDL' },
            { accountId: keys.wages_payable, amount: sum('net').negated().toFixed(2), description: 'Net wages' },
          ]);
          journalId = journal.id;
        }
        await tx.update(PR).set({ status: 'finalised', finalisedAt: new Date(), finalisedBy: p.userId, journalId }).where(eq(PR.id, id));
        await appendAudit(tx, {
          tenantId: p.tenantId,
          actorUserId: p.userId,
          action: 'pay_run.finalised',
          entityType: 'pay_run',
          entityId: id,
          payload: { period: run.period, employees: slips.length, projectsCharged: costEntries.length, overhead: overhead.toFixed(2), journalId },
        });
        return this.loadRun(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** EMP201 working paper: what is due to SARS by the 7th of the following month. */
  @Get('pay-runs/:id/emp201')
  @Roles(...PAYROLL)
  emp201(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const run = await this.getRun(tx, id);
      const [s] = await tx.select().from(S);
      const [y, m] = run.period.split('-').map(Number) as [number, number];
      const due = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 7)).toISOString().slice(0, 10);
      return {
        period: run.period,
        payeReference: s?.payeReference ?? null,
        paye: run.payeTotal,
        uif: run.uifTotal,
        sdl: run.sdlTotal,
        eti: '0.00',
        total: new Decimal(run.payeTotal).plus(run.uifTotal).plus(run.sdlTotal).toFixed(2),
        dueOn: due,
        note: 'Employment Tax Incentive is not calculated by ConstructOS. Claim it in e@syFile if you qualify.',
      };
    });
  }

  // ================================================================ helpers

  private audit(tx: Tx, p: Principal, action: string, employeeId: string, payload: Record<string, unknown>) {
    return appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action, entityType: 'employee', entityId: employeeId, payload });
  }

  private async taxYear(tx: Tx, payDate: string) {
    const year = taxYearFor(payDate);
    const [t] = await tx.select({ taxYear: schema.taxTables.taxYear }).from(schema.taxTables).where(eq(schema.taxTables.taxYear, year));
    if (!t) throw new BadRequestException(`The SARS tax tables for ${year} are not loaded yet. Payroll for that tax year cannot run until they are added.`);
    return year;
  }

  /** Pay and personal fields are removed for roles that do not run payroll. */
  private visible(p: Principal, e: typeof E.$inferSelect) {
    if (PAYROLL.includes(p.role)) return e;
    const { rate: _r, medicalAidMembers: _m, ...rest } = e;
    return rest;
  }

  private async getEmployee(tx: Tx, id: string) {
    const [e] = await tx.select().from(E).where(eq(E.id, id));
    if (!e) throw new NotFoundException('Employee not found');
    return e;
  }

  private async loadEmployee(tx: Tx, p: Principal, id: string) {
    const e = await this.getEmployee(tx, id);
    const [certs, leave] = await Promise.all([
      tx.select().from(C).where(eq(C.employeeId, id)).orderBy(asc(C.expiresOn)),
      tx.select().from(L).where(eq(L.employeeId, id)).orderBy(desc(L.startsOn)),
    ]);
    const balances = leaveBalances(e.startDate, today(), leave.filter((l) => l.status === 'approved').map((l) => ({ kind: l.kind, startsOn: l.startsOn, days: l.days })));
    let priv: typeof EP.$inferSelect | null = null;
    if (PAYROLL.includes(p.role)) {
      [priv = null] = await tx.select().from(EP).where(eq(EP.employeeId, id));
      // POPIA: every view of personal details is recorded.
      await this.audit(tx, p, 'employee.private_viewed', id, { employeeNo: e.employeeNo });
    }
    return { ...this.visible(p, e), private: priv, certifications: certs.map((c) => ({ ...c, expired: Boolean(c.expiresOn && c.expiresOn < today()) })), leave, leaveBalances: balances };
  }

  private async getRun(tx: Tx, id: string) {
    const [r] = await tx.select().from(PR).where(eq(PR.id, id));
    if (!r) throw new NotFoundException('Pay run not found');
    return r;
  }

  private async loadRun(tx: Tx, id: string) {
    const run = await this.getRun(tx, id);
    const slips = await tx
      .select({ s: PS, firstName: E.firstName, lastName: E.lastName, employeeNo: E.employeeNo, occupation: E.occupation })
      .from(PS)
      .innerJoin(E, eq(E.id, PS.employeeId))
      .where(eq(PS.payRunId, id))
      .orderBy(asc(E.lastName));
    const { from, to } = monthBounds(run.period);
    const [pending] = await tx.select({ n: sql<number>`count(*)::int` }).from(TE).where(and(gte(TE.workDate, from), lte(TE.workDate, to), eq(TE.status, 'submitted')));
    return { ...run, pendingTimesheets: pending!.n, payslips: slips.map((r) => ({ ...r.s, employeeName: `${r.firstName} ${r.lastName}`, employeeNo: r.employeeNo, occupation: r.occupation })) };
  }

  /** (Re)build every payslip in a draft run. */
  private async calculate(tx: Tx, p: Principal, runId: string) {
    const run = await this.getRun(tx, runId);
    if (run.status !== 'draft') throw new BadRequestException('A finalised pay run cannot be recalculated');
    const { from, to } = monthBounds(run.period);
    const [[table], [settings], staff, time, unpaid] = await Promise.all([
      tx.select().from(schema.taxTables).where(eq(schema.taxTables.taxYear, run.taxYear)),
      tx.select().from(S),
      tx
        .select({ e: E, dob: EP.dateOfBirth })
        .from(E)
        .innerJoin(EP, eq(EP.employeeId, E.id))
        .where(and(lte(E.startDate, to), or(eq(E.status, 'active'), gte(E.endDate, from)))),
      tx.select().from(TE).where(and(gte(TE.workDate, from), lte(TE.workDate, to), eq(TE.status, 'approved'))),
      tx.select().from(L).where(and(eq(L.kind, 'unpaid'), eq(L.status, 'approved'), lte(L.startsOn, to), gte(L.endsOn, from))),
    ]);
    await tx.delete(PS).where(eq(PS.payRunId, runId));
    const totals = { gross: new Decimal(0), paye: new Decimal(0), uif: new Decimal(0), sdl: new Decimal(0), net: new Decimal(0) };
    for (const { e, dob } of staff) {
      const mine = time.filter((t) => t.employeeId === e.id);
      const sum = (k: 'normalHours' | 'overtimeHours' | 'sundayHours') => mine.reduce((a, t) => a.plus(t[k]), new Decimal(0)).toFixed(2);
      // Unpaid leave days that fall inside this month.
      const unpaidDays = unpaid
        .filter((l) => l.employeeId === e.id)
        .reduce((a, l) => a + workingDays(l.startsOn > from ? l.startsOn : from, l.endsOn < to ? l.endsOn : to), 0);
      const fig = payslip({
        employee: { payBasis: e.payBasis as 'monthly' | 'hourly', rate: e.rate, startDate: e.startDate, endDate: e.endDate, medicalAidMembers: e.medicalAidMembers },
        dateOfBirth: dob,
        period: run.period,
        hours: { normal: sum('normalHours'), overtime: sum('overtimeHours'), sunday: sum('sundayHours') },
        unpaidLeaveDays: String(unpaidDays),
        monthlyHours: settings?.monthlyHours ?? '195',
        sdlLiable: settings?.sdlLiable ?? true,
        table: table!,
      });
      // An hourly worker with no approved time this month gets no payslip.
      if (e.payBasis === 'hourly' && !new Decimal(fig.gross).greaterThan(0)) continue;
      await tx.insert(PS).values({ ...fig, tenantId: p.tenantId, payRunId: runId, employeeId: e.id });
      totals.gross = totals.gross.plus(fig.gross);
      totals.paye = totals.paye.plus(fig.paye);
      totals.uif = totals.uif.plus(fig.uifEmployee).plus(fig.uifEmployer);
      totals.sdl = totals.sdl.plus(fig.sdl);
      totals.net = totals.net.plus(fig.net);
    }
    await tx
      .update(PR)
      .set({ grossTotal: totals.gross.toFixed(2), payeTotal: totals.paye.toFixed(2), uifTotal: totals.uif.toFixed(2), sdlTotal: totals.sdl.toFixed(2), netTotal: totals.net.toFixed(2) })
      .where(eq(PR.id, runId));
  }
}
