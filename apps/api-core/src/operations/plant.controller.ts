import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type Tx, type UserRole } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { LedgerService, ledgerError } from '../ledger/ledger.service';
import { complianceIssues, maintenanceDue, plantCharge, utilisation } from './calc';

const AS = schema.assets;
const AL = schema.assetAllocations;
const MR = schema.assetMeterReadings;
const PU = schema.plantUsage;
const MP = schema.maintenancePlans;
const WO = schema.workOrders;
const P = schema.projects;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string');
const meter = z.string().regex(/^\d{1,11}(\.\d)?$/, 'reading as a number with at most one decimal');

const AssetBody = z.object({
  assetNo: z.string().trim().min(1).max(30),
  name: z.string().trim().min(1).max(200),
  category: z.enum(['earthmoving', 'lifting', 'vehicle', 'generator', 'compressor', 'scaffolding', 'tools', 'other']),
  make: z.string().trim().max(100).nullable().optional(),
  model: z.string().trim().max(100).nullable().optional(),
  serialNo: z.string().trim().max(100).nullable().optional(),
  registration: z.string().trim().max(30).nullable().optional(),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  ownership: z.enum(['owned', 'hired_in']).optional(),
  hiredFromId: z.string().uuid().nullable().optional(),
  rateUnit: z.enum(['hour', 'day']).optional(),
  chargeRate: money.optional(),
  meterUnit: z.enum(['hours', 'km', 'none']).optional(),
  purchaseDate: isoDate.nullable().optional(),
  purchaseValue: money.nullable().optional(),
  licenceExpiry: isoDate.nullable().optional(),
  roadworthyExpiry: isoDate.nullable().optional(),
  loadTestExpiry: isoDate.nullable().optional(),
  calibrationExpiry: isoDate.nullable().optional(),
  notes: z.string().trim().max(2000).optional(),
});
const Move = z.object({ projectId: z.string().uuid().nullable(), movedOn: isoDate, note: z.string().trim().max(500).optional() });
const Reading = z.object({ readOn: isoDate, reading: meter });
const Usage = z.object({
  projectId: z.string().uuid(),
  costCodeId: z.string().uuid(),
  usedOn: isoDate,
  quantity: z.string().regex(/^\d{1,2}(\.\d{1,2})?$/, 'hours or days, e.g. 8.5 or 1'),
  operatorName: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
});
const Dispose = z.object({ disposedOn: isoDate, reason: z.string().trim().min(1).max(500) });
const PlanBody = z.object({
  description: z.string().trim().min(1).max(200),
  intervalMeter: meter.nullable().optional(),
  intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  lastDoneOn: isoDate.nullable().optional(),
  lastDoneMeter: meter.nullable().optional(),
});
const WorkOrderBody = z.object({
  kind: z.enum(['service', 'repair', 'breakdown', 'inspection']),
  description: z.string().trim().min(1).max(2000),
  reportedOn: isoDate,
  planId: z.string().uuid().nullable().optional(),
});
const Complete = z.object({
  completedOn: isoDate,
  workDone: z.string().trim().min(1).max(2000),
  meterAtCompletion: meter.nullable().optional(),
  labourCost: money.optional(),
  partsCost: money.optional(),
  downtimeHours: z.string().regex(/^\d{1,6}(\.\d)?$/).optional(),
});

const READERS: UserRole[] = ['owner', 'admin', 'project_manager', 'site_foreman', 'finance'];
const MANAGERS: UserRole[] = ['owner', 'admin', 'project_manager'];
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** Plant & equipment register, site allocation, usage charged to projects, and maintenance. */
@Controller('plant')
@RequiresModule('mod_fleet')
@Roles(...READERS)
export class PlantController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ================================================================ register

  @Get('assets')
  list(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const assets = await tx.select({ a: AS, projectCode: P.code }).from(AS).leftJoin(P, eq(P.id, AS.currentProjectId)).orderBy(asc(AS.assetNo));
      const ids = assets.map((r) => r.a.id);
      const [plans, usage, openWo] = ids.length
        ? await Promise.all([
            tx.select().from(MP).where(and(inArray(MP.assetId, ids), eq(MP.isActive, true))),
            tx.select({ assetId: PU.assetId, usedOn: PU.usedOn }).from(PU).where(and(inArray(PU.assetId, ids), gte(PU.usedOn, daysAgo(29)))),
            tx.select({ assetId: WO.assetId }).from(WO).where(and(inArray(WO.assetId, ids), inArray(WO.status, ['open', 'in_progress']))),
          ])
        : [[], [], []];
      const t = today();
      return assets.map(({ a, projectCode }) => {
        const due = plans.filter((pl) => pl.assetId === a.id).map((pl) => maintenanceDue(pl, a.meterReading, t));
        return {
          ...a,
          projectCode,
          maintenance: due.some((d) => d.status === 'overdue') ? 'overdue' : due.some((d) => d.status === 'due_soon') ? 'due_soon' : 'ok',
          compliance: complianceIssues(a, t),
          utilisation30d: utilisation(usage.filter((u) => u.assetId === a.id).map((u) => String(u.usedOn)), daysAgo(29), t),
          openWorkOrders: openWo.filter((w) => w.assetId === a.id).length,
        };
      });
    });
  }

  @Get('assets/:id')
  get(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.load(tx, id));
  }

  @Post('assets')
  @Roles(...MANAGERS)
  async create(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(AssetBody)) body: z.infer<typeof AssetBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [a] = await tx.insert(AS).values({ ...body, notes: body.notes ?? '', tenantId: p.tenantId }).returning();
        await this.audit(tx, p, 'asset.created', a!.id, { assetNo: body.assetNo, name: body.name });
        return this.load(tx, a!.id);
      });
    } catch (err) {
      ledgerError(err, `Asset number ${body.assetNo} is already used`);
    }
  }

  @Patch('assets/:id')
  @Roles(...MANAGERS)
  async update(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(AssetBody.partial())) body: Partial<z.infer<typeof AssetBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const a = await this.asset(tx, id);
        if (body.meterUnit && body.meterUnit !== a.meterUnit && Number(a.meterReading) > 0) {
          throw new BadRequestException('The meter type cannot change once readings have been recorded');
        }
        await tx.update(AS).set(body).where(eq(AS.id, id));
        await this.audit(tx, p, 'asset.updated', id, { assetNo: a.assetNo, changes: body });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err, 'That asset number is already used');
    }
  }

  /** Send to a project site, or back to the yard (projectId null). */
  @Post('assets/:id/move')
  @HttpCode(200)
  @Roles(...MANAGERS, 'site_foreman')
  async move(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Move)) body: z.infer<typeof Move>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const a = await this.asset(tx, id);
        if (body.projectId && (a.status === 'under_maintenance' || a.status === 'broken_down')) {
          throw new BadRequestException(`The asset is ${a.status.replace('_', ' ')}; complete its work order before sending it to site`);
        }
        await tx.insert(AL).values({ tenantId: p.tenantId, assetId: id, projectId: body.projectId, movedOn: body.movedOn, note: body.note ?? null, movedBy: p.userId });
        const keepRepairStatus = a.status === 'under_maintenance' || a.status === 'broken_down';
        await tx
          .update(AS)
          .set({ currentProjectId: body.projectId, status: body.projectId ? 'on_site' : keepRepairStatus ? a.status : 'available' })
          .where(eq(AS.id, id));
        await this.audit(tx, p, 'asset.moved', id, { assetNo: a.assetNo, from: a.currentProjectId, to: body.projectId, movedOn: body.movedOn });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('assets/:id/meter')
  @HttpCode(200)
  @Roles(...MANAGERS, 'site_foreman')
  async reading(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Reading)) body: z.infer<typeof Reading>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        await tx.insert(MR).values({ tenantId: p.tenantId, assetId: id, readOn: body.readOn, reading: body.reading, recordedBy: p.userId });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Charge a day (or hours) of plant to a project cost code at the asset's
   * internal rate. Also posted to the project's cost ledger (category plant),
   * so it appears in the CVR.
   */
  @Post('assets/:id/usage')
  @HttpCode(200)
  @Roles(...MANAGERS, 'site_foreman')
  async usage(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Usage)) body: z.infer<typeof Usage>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const a = await this.asset(tx, id);
        if (!Number(a.chargeRate)) throw new BadRequestException('Set the asset’s charge-out rate first');
        if (body.usedOn > today()) throw new BadRequestException('Usage cannot be recorded in advance');
        const amount = plantCharge(body.quantity, a.chargeRate);
        const usageId = randomUUID();
        let costEntryId: string | null = null;
        if (Number(amount) > 0) {
          const [ce] = await tx
            .insert(schema.costEntries)
            .values({
              tenantId: p.tenantId,
              projectId: body.projectId,
              costCodeId: body.costCodeId,
              entryDate: body.usedOn,
              category: 'plant',
              description: `${a.assetNo} ${a.name}: ${body.quantity} ${a.rateUnit}${Number(body.quantity) === 1 ? '' : 's'}`.slice(0, 300),
              amount,
              reference: a.assetNo,
              source: 'plant',
              sourceId: usageId,
              createdBy: p.userId,
            })
            .returning({ id: schema.costEntries.id });
          costEntryId = ce!.id;
        }
        await tx.insert(PU).values({
          id: usageId,
          tenantId: p.tenantId,
          assetId: id,
          projectId: body.projectId,
          costCodeId: body.costCodeId,
          usedOn: body.usedOn,
          quantity: body.quantity,
          rateUnit: a.rateUnit,
          rate: a.chargeRate,
          amount,
          operatorName: body.operatorName ?? null,
          note: body.note ?? null,
          costEntryId,
          recordedBy: p.userId,
        });
        await this.audit(tx, p, 'plant.usage_recorded', id, { assetNo: a.assetNo, projectId: body.projectId, usedOn: body.usedOn, quantity: body.quantity, amount });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('assets/:id/dispose')
  @HttpCode(200)
  @Roles('owner', 'admin')
  async dispose(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Dispose)) body: z.infer<typeof Dispose>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const a = await this.asset(tx, id);
        const [open] = await tx.select({ id: WO.id }).from(WO).where(and(eq(WO.assetId, id), inArray(WO.status, ['open', 'in_progress']))).limit(1);
        if (open) throw new BadRequestException('Complete or cancel its open work orders first');
        await tx.update(AS).set({ status: 'disposed', disposedOn: body.disposedOn, currentProjectId: null, notes: `${a.notes}\nDisposed ${body.disposedOn}: ${body.reason}`.trim().slice(0, 2000) }).where(eq(AS.id, id));
        await this.audit(tx, p, 'asset.disposed', id, { assetNo: a.assetNo, ...body });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Cost codes to charge usage to (codes and descriptions only, no financials). */
  @Get('projects/:projectId/cost-codes')
  costCodes(@CurrentUser() p: Principal, @Param('projectId', ParseUUIDPipe) projectId: string) {
    const CC = schema.costCodes;
    return this.db.forTenant(p.tenantId, (tx) =>
      tx.select({ id: CC.id, code: CC.code, description: CC.description }).from(CC).where(eq(CC.projectId, projectId)).orderBy(asc(CC.code)),
    );
  }

  // ================================================================ maintenance

  @Post('assets/:id/plans')
  @Roles(...MANAGERS)
  async addPlan(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(PlanBody)) body: z.infer<typeof PlanBody>) {
    if (!body.intervalMeter && !body.intervalDays) throw new BadRequestException('Give a meter interval, a day interval, or both');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const a = await this.asset(tx, id);
        if (body.intervalMeter && a.meterUnit === 'none') throw new BadRequestException('This asset has no meter; use a day interval');
        await tx.insert(MP).values({ ...body, tenantId: p.tenantId, assetId: id, lastDoneMeter: body.lastDoneMeter ?? (body.intervalMeter ? a.meterReading : null) });
        await this.audit(tx, p, 'maintenance_plan.created', id, { assetNo: a.assetNo, ...body });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Patch('plans/:planId')
  @Roles(...MANAGERS)
  async updatePlan(@CurrentUser() p: Principal, @Param('planId', ParseUUIDPipe) planId: string, @Body(new ZodBodyPipe(PlanBody.partial().extend({ isActive: z.boolean().optional() }))) body: Partial<z.infer<typeof PlanBody>> & { isActive?: boolean }) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [plan] = await tx.update(MP).set(body).where(eq(MP.id, planId)).returning();
        if (!plan) throw new NotFoundException('Maintenance plan not found');
        await this.audit(tx, p, 'maintenance_plan.updated', plan.assetId, { planId, changes: body });
        return this.load(tx, plan.assetId);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Get('work-orders')
  workOrders(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) =>
      (await tx.select({ w: WO, assetNo: AS.assetNo, assetName: AS.name }).from(WO).innerJoin(AS, eq(AS.id, WO.assetId)).orderBy(desc(WO.woNo)).limit(300))
        .map((r) => ({ ...r.w, number: woLabel(r.w.woNo), assetNo: r.assetNo, assetName: r.assetName })),
    );
  }

  /** Report a breakdown or schedule a service. A breakdown takes the asset out of use. */
  @Post('assets/:id/work-orders')
  @Roles(...MANAGERS, 'site_foreman')
  async addWorkOrder(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(WorkOrderBody)) body: z.infer<typeof WorkOrderBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const a = await this.asset(tx, id);
        const woNo = await this.ledger.nextNo(tx, 'work_order');
        await tx.insert(WO).values({ ...body, planId: body.planId ?? null, tenantId: p.tenantId, woNo, assetId: id, createdBy: p.userId });
        if (body.kind === 'breakdown') await tx.update(AS).set({ status: 'broken_down', currentProjectId: null }).where(eq(AS.id, id));
        await this.audit(tx, p, 'work_order.created', id, { assetNo: a.assetNo, number: woLabel(woNo), kind: body.kind });
        return this.load(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('work-orders/:woId/start')
  @HttpCode(200)
  @Roles(...MANAGERS, 'site_foreman')
  async start(@CurrentUser() p: Principal, @Param('woId', ParseUUIDPipe) woId: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const wo = await this.workOrder(tx, woId);
        if (wo.status !== 'open') throw new BadRequestException(`The work order is ${wo.status.replace('_', ' ')}`);
        await tx.update(WO).set({ status: 'in_progress' }).where(eq(WO.id, woId));
        await tx.update(AS).set({ status: 'under_maintenance', currentProjectId: null }).where(eq(AS.id, wo.assetId));
        await this.audit(tx, p, 'work_order.started', wo.assetId, { number: woLabel(wo.woNo) });
        return this.load(tx, wo.assetId);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Complete: records the work and cost, resets the plan it services, and returns the asset to the yard. */
  @Post('work-orders/:woId/complete')
  @HttpCode(200)
  @Roles(...MANAGERS, 'site_foreman')
  async complete(@CurrentUser() p: Principal, @Param('woId', ParseUUIDPipe) woId: string, @Body(new ZodBodyPipe(Complete)) body: z.infer<typeof Complete>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const wo = await this.workOrder(tx, woId);
        if (wo.status !== 'open' && wo.status !== 'in_progress') throw new BadRequestException(`The work order is ${wo.status}`);
        const a = await this.asset(tx, wo.assetId);
        if (body.meterAtCompletion && Number(body.meterAtCompletion) > Number(a.meterReading)) {
          await tx.insert(MR).values({ tenantId: p.tenantId, assetId: a.id, readOn: body.completedOn, reading: body.meterAtCompletion, recordedBy: p.userId });
        }
        await tx.update(WO).set({ ...body, status: 'completed' }).where(eq(WO.id, woId));
        if (wo.planId) {
          await tx.update(MP).set({ lastDoneOn: body.completedOn, lastDoneMeter: body.meterAtCompletion ?? a.meterReading }).where(eq(MP.id, wo.planId));
        }
        const [stillOpen] = await tx.select({ id: WO.id }).from(WO).where(and(eq(WO.assetId, a.id), inArray(WO.status, ['open', 'in_progress']))).limit(1);
        if (!stillOpen && (a.status === 'under_maintenance' || a.status === 'broken_down')) {
          await tx.update(AS).set({ status: 'available' }).where(eq(AS.id, a.id));
        }
        await this.audit(tx, p, 'work_order.completed', a.id, { number: woLabel(wo.woNo), ...body });
        return this.load(tx, a.id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('work-orders/:woId/cancel')
  @HttpCode(200)
  @Roles(...MANAGERS)
  async cancel(@CurrentUser() p: Principal, @Param('woId', ParseUUIDPipe) woId: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const wo = await this.workOrder(tx, woId);
        await tx.update(WO).set({ status: 'cancelled' }).where(eq(WO.id, woId));
        const a = await this.asset(tx, wo.assetId);
        const [stillOpen] = await tx.select({ id: WO.id }).from(WO).where(and(eq(WO.assetId, a.id), inArray(WO.status, ['open', 'in_progress']))).limit(1);
        if (!stillOpen && (a.status === 'under_maintenance' || a.status === 'broken_down')) await tx.update(AS).set({ status: 'available' }).where(eq(AS.id, a.id));
        await this.audit(tx, p, 'work_order.cancelled', a.id, { number: woLabel(wo.woNo) });
        return this.load(tx, a.id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  // ================================================================ helpers

  private audit(tx: Tx, p: Principal, action: string, assetId: string, payload: Record<string, unknown>) {
    return appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action, entityType: 'asset', entityId: assetId, payload });
  }

  private async asset(tx: Tx, id: string) {
    const [a] = await tx.select().from(AS).where(eq(AS.id, id));
    if (!a) throw new NotFoundException('Asset not found');
    return a;
  }

  private async workOrder(tx: Tx, id: string) {
    const [w] = await tx.select().from(WO).where(eq(WO.id, id));
    if (!w) throw new NotFoundException('Work order not found');
    return w;
  }

  private async load(tx: Tx, id: string) {
    const a = await this.asset(tx, id);
    const t = today();
    const [allocations, readings, usage, plans, workOrders, [project], [costs]] = await Promise.all([
      tx.select({ al: AL, projectCode: P.code }).from(AL).leftJoin(P, eq(P.id, AL.projectId)).where(eq(AL.assetId, id)).orderBy(desc(AL.movedOn), desc(AL.createdAt)).limit(50),
      tx.select().from(MR).where(eq(MR.assetId, id)).orderBy(desc(MR.readOn), desc(MR.createdAt)).limit(50),
      tx.select({ u: PU, projectCode: P.code }).from(PU).innerJoin(P, eq(P.id, PU.projectId)).where(eq(PU.assetId, id)).orderBy(desc(PU.usedOn)).limit(100),
      tx.select().from(MP).where(eq(MP.assetId, id)),
      tx.select().from(WO).where(eq(WO.assetId, id)).orderBy(desc(WO.woNo)).limit(100),
      a.currentProjectId ? tx.select({ code: P.code, name: P.name }).from(P).where(eq(P.id, a.currentProjectId)) : Promise.resolve([]),
      tx
        .select({
          maintenance: sql<string>`coalesce(sum(${WO.labourCost} + ${WO.partsCost}), 0)::numeric(18,2)::text`,
          downtime: sql<string>`coalesce(sum(${WO.downtimeHours}), 0)::text`,
        })
        .from(WO)
        .where(and(eq(WO.assetId, id), eq(WO.status, 'completed'))),
    ]);
    const [{ recovered }] = await tx.select({ recovered: sql<string>`coalesce(sum(${PU.amount}), 0)::numeric(18,2)::text` }).from(PU).where(eq(PU.assetId, id));
    return {
      ...a,
      project: project ?? null,
      compliance: complianceIssues(a, t),
      utilisation30d: utilisation(usage.map((u) => String(u.u.usedOn)), daysAgo(29), t),
      totals: { recovered, maintenanceCost: costs?.maintenance ?? '0.00', downtimeHours: costs?.downtime ?? '0' },
      allocations: allocations.map((r) => ({ ...r.al, projectCode: r.projectCode })),
      readings,
      usage: usage.map((r) => ({ ...r.u, projectCode: r.projectCode })),
      plans: plans.map((pl) => ({ ...pl, due: maintenanceDue(pl, a.meterReading, t) })),
      workOrders: workOrders.map((w) => ({ ...w, number: woLabel(w.woNo) })),
    };
  }
}

export const woLabel = (n: number) => `WO-${String(n).padStart(5, '0')}`;
