import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appendAudit, schema, type OpportunityStage, type Tx, type UserRole } from '@constructos/db';
import { DatabaseService } from '../database/database.module';
import { CurrentUser, RequiresModule, Roles } from '../auth/decorators';
import { ZodBodyPipe } from '../common/zod-body.pipe';
import type { Principal } from '../auth/auth.types';
import { LedgerService, ledgerError } from '../ledger/ledger.service';
import { OPEN_STAGES, STAGE_PROBABILITY, deadlines, pipeline, winRate } from './calc';

const CU = schema.customers;
const CT = schema.contacts;
const O = schema.opportunities;
const A = schema.crmActivities;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date as YYYY-MM-DD');
const money = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'amount as a decimal string');
const SECTORS = ['mining', 'petrochemical', 'power', 'manufacturing', 'infrastructure', 'government', 'commercial', 'other'] as const;
const PROVINCES = ['EC', 'FS', 'GP', 'KZN', 'LP', 'MP', 'NC', 'NW', 'WC'] as const;

const AccountBody = z.object({
  name: z.string().trim().min(1).max(200),
  vatNumber: z.string().regex(/^4\d{9}$/, 'a South African VAT number is 10 digits starting with 4').nullable().optional(),
  registrationNo: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  billingAddress: z.string().trim().max(500).nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  sector: z.enum(SECTORS).nullable().optional(),
  province: z.enum(PROVINCES).nullable().optional(),
  website: z.string().trim().max(200).nullable().optional(),
  accountManagerId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(4000).optional(),
});
const ContactBody = z.object({
  fullName: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().max(100).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  isPrimary: z.boolean().optional(),
  marketingOptOut: z.boolean().optional(),
});
const OppBody = z.object({
  customerId: z.string().uuid(),
  contactId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  stage: z.enum(['lead', 'qualifying']).optional(),
  source: z.enum(['client_rfq', 'tender_bulletin', 'etender_portal', 'referral', 'repeat_client', 'other']).optional(),
  estimatedValue: money.nullable().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  tenderRef: z.string().trim().max(60).nullable().optional(),
  briefingOn: z.string().datetime({ offset: true }).nullable().optional(),
  closingAt: z.string().datetime({ offset: true }).nullable().optional(),
  expectedAwardOn: isoDate.nullable().optional(),
  cidbGradeRequired: z.string().trim().toUpperCase().regex(/^[1-9][A-Z]{1,3}$/, 'CIDB grading like 6CE').nullable().optional(),
  bbbeeLevelRequired: z.number().int().min(1).max(8).nullable().optional(),
  ownerId: z.string().uuid().optional(),
});
const OppPatch = OppBody.omit({ stage: true }).partial();
const Transition = z.object({
  to: z.enum(['lead', 'qualifying', 'tendering', 'submitted', 'won', 'lost', 'no_bid']),
  probability: z.number().int().min(0).max(100).optional(),
  awardedValue: money.optional(),
  closeReason: z.string().trim().min(1).max(1000).optional(),
  competitor: z.string().trim().max(200).optional(),
  projectId: z.string().uuid().optional(),
});
const ActivityBody = z.object({
  customerId: z.string().uuid(),
  opportunityId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  kind: z.enum(['call', 'meeting', 'email', 'site_visit', 'note']),
  occurredOn: isoDate,
  summary: z.string().trim().min(1).max(4000),
  nextStep: z.string().trim().max(500).nullable().optional(),
  followUpOn: isoDate.nullable().optional(),
});

const COMMERCIAL: UserRole[] = ['owner', 'admin', 'project_manager', 'finance'];
const today = () => new Date().toISOString().slice(0, 10);
export const oppLabel = (n: number) => `OPP-${String(n).padStart(4, '0')}`;

/** Clients, contacts, the opportunity / tender pipeline, and activities. */
@Controller('crm')
@RequiresModule('mod_crm')
@Roles(...COMMERCIAL)
export class CrmController {
  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  // ================================================================ dashboard

  @Get('dashboard')
  dashboard(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [opps, followUps] = await Promise.all([
        tx.select({ o: O, customerName: CU.name }).from(O).innerJoin(CU, eq(CU.id, O.customerId)),
        tx
          .select({ a: A, customerName: CU.name })
          .from(A)
          .innerJoin(CU, eq(CU.id, A.customerId))
          .where(and(isNotNull(A.followUpOn), eq(A.followUpDone, false), lte(A.followUpOn, new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))))
          .orderBy(asc(A.followUpOn))
          .limit(50),
      ]);
      const all = opps.map((r) => ({ ...r.o, customerName: r.customerName, number: oppLabel(r.o.oppNo) }));
      const yearAgo = `${Number(today().slice(0, 4)) - 1}${today().slice(4)}`;
      return {
        pipeline: pipeline(all),
        winRate: winRate(all, yearAgo),
        deadlines: deadlines(all, new Date(), 14).map((x) => ({ ...x, opportunity: { id: x.opportunity.id, number: x.opportunity.number, title: x.opportunity.title, customerName: x.opportunity.customerName, stage: x.opportunity.stage } })),
        followUps: followUps.map((r) => ({ ...r.a, customerName: r.customerName, overdue: r.a.followUpOn! < today() })),
      };
    });
  }

  // ================================================================ accounts

  @Get('accounts')
  accounts(@CurrentUser() p: Principal) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [rows, opps, contacts, last] = await Promise.all([
        tx.select().from(CU).orderBy(asc(CU.name)),
        tx.select({ customerId: O.customerId, stage: O.stage, value: O.estimatedValue }).from(O).where(inArray(O.stage, OPEN_STAGES)),
        tx.select({ customerId: CT.customerId, n: sql<number>`count(*)::int` }).from(CT).groupBy(CT.customerId),
        tx.select({ customerId: A.customerId, last: sql<string>`max(${A.occurredOn})::text` }).from(A).groupBy(A.customerId),
      ]);
      return rows.map((c) => {
        const open = opps.filter((o) => o.customerId === c.id);
        return {
          ...c,
          contacts: contacts.find((x) => x.customerId === c.id)?.n ?? 0,
          openOpportunities: open.length,
          openValue: open.reduce((s, o) => s + Number(o.value ?? 0), 0).toFixed(2),
          lastActivity: last.find((x) => x.customerId === c.id)?.last ?? null,
        };
      });
    });
  }

  @Get('accounts/:id')
  account(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadAccount(tx, id));
  }

  @Post('accounts')
  async addAccount(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(AccountBody)) body: z.infer<typeof AccountBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [c] = await tx.insert(CU).values({ ...body, notes: body.notes ?? '', accountManagerId: body.accountManagerId ?? p.userId, tenantId: p.tenantId }).returning();
        await this.audit(tx, p, 'customer.created', 'customer', c!.id, { name: body.name, sector: body.sector ?? null });
        return this.loadAccount(tx, c!.id);
      });
    } catch (err) {
      ledgerError(err, `A client called ${body.name} already exists`);
    }
  }

  @Patch('accounts/:id')
  async updateAccount(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(AccountBody.partial())) body: Partial<z.infer<typeof AccountBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [c] = await tx.update(CU).set(body).where(eq(CU.id, id)).returning({ id: CU.id });
        if (!c) throw new NotFoundException('Client not found');
        await this.audit(tx, p, 'customer.updated', 'customer', id, { fields: Object.keys(body) });
        return this.loadAccount(tx, id);
      });
    } catch (err) {
      ledgerError(err, 'Another client already has that name');
    }
  }

  // ================================================================ contacts

  @Post('accounts/:id/contacts')
  async addContact(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(ContactBody)) body: z.infer<typeof ContactBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        if (body.isPrimary) await tx.update(CT).set({ isPrimary: false }).where(eq(CT.customerId, id));
        await tx.insert(CT).values({ ...body, customerId: id, tenantId: p.tenantId });
        await this.audit(tx, p, 'contact.created', 'customer', id, {});
        return this.loadAccount(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Patch('contacts/:contactId')
  async updateContact(@CurrentUser() p: Principal, @Param('contactId', ParseUUIDPipe) contactId: string, @Body(new ZodBodyPipe(ContactBody.partial())) body: Partial<z.infer<typeof ContactBody>>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [cur] = await tx.select().from(CT).where(eq(CT.id, contactId));
        if (!cur) throw new NotFoundException('Contact not found');
        if (body.isPrimary) await tx.update(CT).set({ isPrimary: false }).where(eq(CT.customerId, cur.customerId));
        await tx.update(CT).set(body).where(eq(CT.id, contactId));
        // Contact details stay out of the audit payload; only which fields changed.
        await this.audit(tx, p, 'contact.updated', 'customer', cur.customerId, { fields: Object.keys(body) });
        return this.loadAccount(tx, cur.customerId);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Delete('contacts/:contactId')
  async removeContact(@CurrentUser() p: Principal, @Param('contactId', ParseUUIDPipe) contactId: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [cur] = await tx.delete(CT).where(eq(CT.id, contactId)).returning();
        if (!cur) throw new NotFoundException('Contact not found');
        await this.audit(tx, p, 'contact.deleted', 'customer', cur.customerId, {});
        return this.loadAccount(tx, cur.customerId);
      });
    } catch (err) {
      ledgerError(err, 'This contact is linked to opportunities or activities');
    }
  }

  // ================================================================ opportunities

  @Get('opportunities')
  opportunities(@CurrentUser() p: Principal, @Query('stage') stage?: string) {
    const stages = schema.opportunityStage.enumValues as readonly string[];
    if (stage && !stages.includes(stage)) throw new BadRequestException('Unknown stage');
    return this.db.forTenant(p.tenantId, async (tx) =>
      (
        await tx
          .select({ o: O, customerName: CU.name, ownerName: schema.users.fullName })
          .from(O)
          .innerJoin(CU, eq(CU.id, O.customerId))
          .innerJoin(schema.users, eq(schema.users.id, O.ownerId))
          .where(stage ? eq(O.stage, stage as OpportunityStage) : undefined)
          .orderBy(desc(O.updatedAt))
          .limit(1000)
      ).map((r) => ({ ...r.o, number: oppLabel(r.o.oppNo), customerName: r.customerName, ownerName: r.ownerName })),
    );
  }

  @Get('opportunities/:id')
  opportunity(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, (tx) => this.loadOpp(tx, id));
  }

  @Post('opportunities')
  async addOpp(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(OppBody)) body: z.infer<typeof OppBody>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const oppNo = await this.ledger.nextNo(tx, 'opportunity');
        const stage = body.stage ?? 'lead';
        const [o] = await tx
          .insert(O)
          .values({
            ...body,
            stage,
            briefingOn: body.briefingOn ? new Date(body.briefingOn) : null,
            closingAt: body.closingAt ? new Date(body.closingAt) : null,
            probability: body.probability ?? STAGE_PROBABILITY[stage],
            ownerId: body.ownerId ?? p.userId,
            tenantId: p.tenantId,
            oppNo,
            createdBy: p.userId,
          })
          .returning();
        await this.audit(tx, p, 'opportunity.created', 'opportunity', o!.id, { number: oppLabel(oppNo), title: body.title, estimatedValue: body.estimatedValue ?? null });
        return this.loadOpp(tx, o!.id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Patch('opportunities/:id')
  async updateOpp(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(OppPatch)) body: z.infer<typeof OppPatch>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getOpp(tx, id);
        await tx
          .update(O)
          .set({
            ...body,
            briefingOn: body.briefingOn === undefined ? undefined : body.briefingOn ? new Date(body.briefingOn) : null,
            closingAt: body.closingAt === undefined ? undefined : body.closingAt ? new Date(body.closingAt) : null,
          })
          .where(eq(O.id, id));
        await this.audit(tx, p, 'opportunity.updated', 'opportunity', id, { number: oppLabel(cur.oppNo), fields: Object.keys(body), ...(body.estimatedValue !== undefined ? { estimatedValue: body.estimatedValue } : {}) });
        return this.loadOpp(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Move through the pipeline. Won needs the awarded value; lost and no-bid need the reason. */
  @Post('opportunities/:id/transition')
  @HttpCode(200)
  async transition(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(Transition)) body: z.infer<typeof Transition>) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getOpp(tx, id);
        const set: Partial<typeof O.$inferInsert> = { stage: body.to, probability: body.probability ?? STAGE_PROBABILITY[body.to] };
        if (body.to === 'submitted' && !cur.estimatedValue) throw new BadRequestException('Enter the tendered value before marking it submitted');
        if (body.to === 'won') {
          set.awardedValue = body.awardedValue ?? cur.estimatedValue ?? undefined;
          if (!set.awardedValue) throw new BadRequestException('Enter the awarded value');
          set.closedAt = new Date();
          set.projectId = body.projectId ?? (await this.estimateProject(tx, cur.estimateId)) ?? null;
        }
        if (body.to === 'lost' || body.to === 'no_bid') {
          if (!body.closeReason) throw new BadRequestException(body.to === 'lost' ? 'Record why the tender was lost' : 'Record why the company is not bidding');
          set.closeReason = body.closeReason;
          set.competitor = body.competitor ?? null;
          set.closedAt = new Date();
        }
        await tx.update(O).set(set).where(eq(O.id, id));
        await this.audit(tx, p, `opportunity.${body.to}`, 'opportunity', id, {
          number: oppLabel(cur.oppNo),
          from: cur.stage,
          to: body.to,
          awardedValue: set.awardedValue ?? null,
          closeReason: body.closeReason ?? null,
          competitor: body.competitor ?? null,
        });
        return this.loadOpp(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /** Link a won tender to the project it became. */
  @Post('opportunities/:id/project')
  @HttpCode(200)
  async linkProject(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBodyPipe(z.object({ projectId: z.string().uuid() }))) body: { projectId: string }) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getOpp(tx, id);
        if (cur.stage !== 'won') throw new BadRequestException('Only a won opportunity can be linked to a project');
        await tx.update(O).set({ projectId: body.projectId }).where(eq(O.id, id));
        await this.audit(tx, p, 'opportunity.project_linked', 'opportunity', id, { number: oppLabel(cur.oppNo), projectId: body.projectId });
        return this.loadOpp(tx, id);
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  /**
   * Start pricing the tender: create its estimate in Commercial Intake (needs
   * that module), linked to this opportunity, and move it to tendering.
   */
  @Post('opportunities/:id/estimate')
  @HttpCode(200)
  async startEstimate(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const cur = await this.getOpp(tx, id);
        if (cur.estimateId) throw new BadRequestException('This opportunity already has an estimate');
        if (cur.stage !== 'qualifying' && cur.stage !== 'tendering') throw new BadRequestException('Qualify the opportunity before pricing it');
        const [tenant] = await tx.select({ modules: schema.tenants.activeModules }).from(schema.tenants);
        if (!tenant?.modules.includes('mod_commercial')) throw new BadRequestException('Commercial Intake is not active for your organisation');
        const [customer] = await tx.select({ name: CU.name }).from(CU).where(eq(CU.id, cur.customerId));
        const [e] = await tx
          .insert(schema.estimates)
          .values({
            tenantId: p.tenantId,
            ref: (cur.tenderRef ?? oppLabel(cur.oppNo)).slice(0, 40),
            title: cur.title,
            clientName: customer!.name,
            clientReference: cur.tenderRef,
            createdBy: p.userId,
          })
          .returning({ id: schema.estimates.id });
        await tx.update(O).set({ estimateId: e!.id, stage: 'tendering', probability: Math.max(cur.probability, STAGE_PROBABILITY.tendering) }).where(eq(O.id, id));
        await this.audit(tx, p, 'opportunity.estimate_started', 'opportunity', id, { number: oppLabel(cur.oppNo), estimateId: e!.id });
        return this.loadOpp(tx, id);
      });
    } catch (err) {
      ledgerError(err, 'An estimate with this tender reference already exists. Change the tender reference first.');
    }
  }

  // ================================================================ activities

  @Get('activities')
  activities(@CurrentUser() p: Principal, @Query('customerId') customerId?: string) {
    return this.db.forTenant(p.tenantId, async (tx) =>
      (
        await tx
          .select({ a: A, customerName: CU.name, author: schema.users.fullName })
          .from(A)
          .innerJoin(CU, eq(CU.id, A.customerId))
          .innerJoin(schema.users, eq(schema.users.id, A.createdBy))
          .where(customerId ? eq(A.customerId, customerId) : undefined)
          .orderBy(desc(A.occurredOn), desc(A.createdAt))
          .limit(500)
      ).map((r) => ({ ...r.a, customerName: r.customerName, author: r.author, overdue: Boolean(r.a.followUpOn && !r.a.followUpDone && r.a.followUpOn < today()) })),
    );
  }

  @Post('activities')
  async addActivity(@CurrentUser() p: Principal, @Body(new ZodBodyPipe(ActivityBody)) body: z.infer<typeof ActivityBody>) {
    if (body.occurredOn > today()) throw new BadRequestException('Log activities that have happened; use the follow-up date for what comes next');
    try {
      return await this.db.forTenant(p.tenantId, async (tx) => {
        const [a] = await tx.insert(A).values({ ...body, tenantId: p.tenantId, createdBy: p.userId }).returning();
        return a;
      });
    } catch (err) {
      ledgerError(err);
    }
  }

  @Post('activities/:id/done')
  @HttpCode(200)
  async followUpDone(@CurrentUser() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.forTenant(p.tenantId, async (tx) => {
      const [a] = await tx.update(A).set({ followUpDone: true }).where(and(eq(A.id, id), isNotNull(A.followUpOn))).returning();
      if (!a) throw new NotFoundException('Follow-up not found');
      return a;
    });
  }

  // ================================================================ helpers

  private audit(tx: Tx, p: Principal, action: string, entityType: string, entityId: string, payload: Record<string, unknown>) {
    return appendAudit(tx, { tenantId: p.tenantId, actorUserId: p.userId, action, entityType, entityId, payload });
  }

  private async estimateProject(tx: Tx, estimateId: string | null) {
    if (!estimateId) return null;
    const [e] = await tx.select({ projectId: schema.estimates.projectId }).from(schema.estimates).where(eq(schema.estimates.id, estimateId));
    return e?.projectId ?? null;
  }

  private async loadAccount(tx: Tx, id: string) {
    const [c] = await tx.select().from(CU).where(eq(CU.id, id));
    if (!c) throw new NotFoundException('Client not found');
    const [contacts, opps, activities, [manager]] = await Promise.all([
      tx.select().from(CT).where(eq(CT.customerId, id)).orderBy(desc(CT.isPrimary), asc(CT.fullName)),
      tx.select().from(O).where(eq(O.customerId, id)).orderBy(desc(O.updatedAt)),
      tx.select({ a: A, author: schema.users.fullName }).from(A).innerJoin(schema.users, eq(schema.users.id, A.createdBy)).where(eq(A.customerId, id)).orderBy(desc(A.occurredOn)).limit(100),
      c.accountManagerId ? tx.select({ fullName: schema.users.fullName }).from(schema.users).where(eq(schema.users.id, c.accountManagerId)) : Promise.resolve([]),
    ]);
    return {
      ...c,
      accountManagerName: manager?.fullName ?? null,
      contacts,
      opportunities: opps.map((o) => ({ ...o, number: oppLabel(o.oppNo) })),
      activities: activities.map((r) => ({ ...r.a, author: r.author, overdue: Boolean(r.a.followUpOn && !r.a.followUpDone && r.a.followUpOn < today()) })),
      winRate: winRate(opps, '1900-01-01'),
    };
  }

  private async getOpp(tx: Tx, id: string) {
    const [o] = await tx.select().from(O).where(eq(O.id, id));
    if (!o) throw new NotFoundException('Opportunity not found');
    return o;
  }

  private async loadOpp(tx: Tx, id: string) {
    const o = await this.getOpp(tx, id);
    const [[customer], activities, [estimate], [project], [owner]] = await Promise.all([
      tx.select({ name: CU.name }).from(CU).where(eq(CU.id, o.customerId)),
      tx.select({ a: A, author: schema.users.fullName }).from(A).innerJoin(schema.users, eq(schema.users.id, A.createdBy)).where(eq(A.opportunityId, id)).orderBy(desc(A.occurredOn)),
      o.estimateId ? tx.select({ id: schema.estimates.id, ref: schema.estimates.ref, stage: schema.estimates.stage, projectId: schema.estimates.projectId }).from(schema.estimates).where(eq(schema.estimates.id, o.estimateId)) : Promise.resolve([]),
      o.projectId ? tx.select({ id: schema.projects.id, code: schema.projects.code, name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, o.projectId)) : Promise.resolve([]),
      tx.select({ fullName: schema.users.fullName }).from(schema.users).where(eq(schema.users.id, o.ownerId)),
    ]);
    return {
      ...o,
      number: oppLabel(o.oppNo),
      customerName: customer?.name ?? '',
      ownerName: owner?.fullName ?? '',
      estimate: estimate ?? null,
      project: project ?? null,
      activities: activities.map((r) => ({ ...r.a, author: r.author })),
    };
  }
}
