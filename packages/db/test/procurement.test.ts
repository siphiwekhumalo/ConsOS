/**
 * Procurement guarantees (migration 0009), enforced by the database as the app
 * role regardless of what the API does.
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;

const run = Date.now().toString(36);
const T = {
  id: randomUUID(), slug: `pr-a-${run}`, user: randomUUID(), project: randomUUID(), other: randomUUID(), code: randomUUID(), otherCode: randomUUID(),
  supplier: randomUUID(), exp: randomUUID(), ap: randomUUID(),
};
const OTHER = { id: randomUUID(), slug: `pr-b-${run}` };

let owner: postgres.Sql;
let app: postgres.Sql;

async function as<R>(db: postgres.Sql, tenant: string, fn: (tx: postgres.TransactionSql) => Promise<R>) {
  return db.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    return fn(tx);
  }) as Promise<R>;
}

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected rejection');
}

let poNo = 0;
async function order(status: 'draft' | 'approved', lines: [number, number][]) {
  return as(app, T.id, async (tx) => {
    const [po] = await tx`
      insert into purchase_orders (tenant_id, po_no, supplier_id, project_id, order_date, subtotal, vat_total, total, created_by)
      values (${T.id}, ${++poNo}, ${T.supplier}, ${T.project}, '2026-11-01', 1000, 150, 1150, ${T.user}) returning id`;
    const ids: string[] = [];
    let n = 0;
    for (const [q, price] of lines) {
      const [l] = await tx`
        insert into purchase_order_lines (tenant_id, po_id, line_no, description, unit, quantity, unit_price, project_id, cost_code_id, category)
        values (${T.id}, ${po!.id}, ${++n}, 'Lagging', 'm2', ${q}, ${price}, ${T.project}, ${T.code}, 'material') returning id`;
      ids.push(l!.id);
    }
    if (status === 'approved') {
      await tx`update purchase_orders set status = 'submitted' where id = ${po!.id}`;
      await tx`update purchase_orders set status = 'approved', approved_at = now(), approved_by = ${T.user} where id = ${po!.id}`;
    }
    return { po: po!.id as string, lines: ids };
  });
}

let grnNo = 0;
const receive = (po: string, line: string, q: number) =>
  as(app, T.id, async (tx) => {
    const [g] = await tx`insert into goods_receipts (tenant_id, grn_no, po_id, received_on, received_by) values (${T.id}, ${++grnNo}, ${po}, '2026-11-03', ${T.user}) returning id`;
    await tx`insert into goods_receipt_lines (tenant_id, receipt_id, po_line_id, quantity) values (${T.id}, ${g!.id}, ${line}, ${q})`;
  });

let jNo = 0;
let invNo = 0;
/** A draft supplier invoice billing `q` units at `price` against a PO line, then try to approve it. */
async function invoiceAgainst(poLine: string, q: number, price: number, override: string | null = null) {
  const amount = q * price;
  return as(app, T.id, async (tx) => {
    const [inv] = await tx`
      insert into supplier_invoices (tenant_id, supplier_id, invoice_no, invoice_date, due_date, subtotal, total, created_by)
      values (${T.id}, ${T.supplier}, ${`INV-${++invNo}`}, '2026-11-04', '2026-12-04', ${amount}, ${amount}, ${T.user}) returning id`;
    await tx`
      insert into supplier_invoice_lines (tenant_id, invoice_id, line_no, description, project_id, cost_code_id, category, amount, vat_rate, po_line_id, quantity, unit_price)
      values (${T.id}, ${inv!.id}, 1, 'Lagging', ${T.project}, ${T.code}, 'material', ${amount}, 0, ${poLine}, ${q}, ${price})`;
    const [j] = await tx`insert into journals (tenant_id, journal_no, entry_date, description, source, posted_by) values (${T.id}, ${++jNo}, '2026-11-04', 't', 'supplier_invoice', ${T.user}) returning id`;
    await tx`insert into journal_lines (tenant_id, journal_id, account_id, debit) values (${T.id}, ${j!.id}, ${T.exp}, ${amount})`;
    await tx`insert into journal_lines (tenant_id, journal_id, account_id, credit) values (${T.id}, ${j!.id}, ${T.ap}, ${amount})`;
    await tx`update supplier_invoices set status = 'approved', journal_id = ${j!.id}, approved_at = now(), match_override_reason = ${override} where id = ${inv!.id}`;
  });
}

describe.skipIf(!OWNER_URL || !APP_URL)('procurement (0009)', () => {
  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [T, OTHER]) {
      await as(owner, t.id, (tx) => tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`);
    }
    await as(owner, T.id, async (tx) => {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${T.user}, ${T.id}, 'buyer@x.test', 'Buyer', 'x', 'finance')`;
      await tx`insert into projects (id, tenant_id, code, name) values (${T.project}, ${T.id}, 'P-1', 'Plant'), (${T.other}, ${T.id}, 'P-2', 'Other')`;
      await tx`insert into cost_codes (id, tenant_id, project_id, code, description, budget) values (${T.code}, ${T.id}, ${T.project}, '100', 'Materials', 100000), (${T.otherCode}, ${T.id}, ${T.other}, '100', 'Other', 1)`;
      await tx`insert into suppliers (id, tenant_id, name, is_subcontractor) values (${T.supplier}, ${T.id}, 'Insulate SA', true)`;
      await tx`insert into accounts (id, tenant_id, code, name, type) values (${T.exp}, ${T.id}, '5010', 'Materials', 'expense'), (${T.ap}, ${T.id}, '2000', 'Payables', 'liability')`;
    });
    app = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  });

  describe('purchase orders', () => {
    it('cannot skip approval or start beyond draft', async () => {
      const { po } = await order('draft', [[10, 100]]);
      expect(await rejects(as(app, T.id, (tx) => tx`update purchase_orders set status = 'approved', approved_at = now(), approved_by = ${T.user} where id = ${po}`))).toMatch(/invalid purchase order transition draft -> approved/);
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into purchase_orders (tenant_id, po_no, supplier_id, order_date, status, created_by) values (${T.id}, 999, ${T.supplier}, '2026-11-01', 'approved', ${T.user})`)),
      ).toMatch(/start as draft/);
    });

    it('freezes an approved order and its lines', async () => {
      const { po, lines } = await order('approved', [[10, 100]]);
      expect(await rejects(as(app, T.id, (tx) => tx`update purchase_orders set notes = 'edit' where id = ${po}`))).toMatch(/approved and cannot be edited/);
      expect(await rejects(as(app, T.id, (tx) => tx`update purchase_order_lines set unit_price = 1 where id = ${lines[0]}`))).toMatch(/frozen/);
      expect(await rejects(as(app, T.id, (tx) => tx`delete from purchase_orders where id = ${po}`))).toMatch(/only a draft order can be deleted/);
    });
  });

  describe('goods received', () => {
    it('only against an approved order, never more than ordered', async () => {
      const draft = await order('draft', [[10, 100]]);
      expect(await rejects(receive(draft.po, draft.lines[0]!, 1))).toMatch(/approved order/);
      const { po, lines } = await order('approved', [[10, 100]]);
      await receive(po, lines[0]!, 6);
      expect(await rejects(receive(po, lines[0]!, 5))).toMatch(/would exceed the 10.000 ordered \(6.000 already received\)/);
      await receive(po, lines[0]!, 4);
    });

    it('is append-only, and an order with deliveries cannot be cancelled', async () => {
      const { po, lines } = await order('approved', [[10, 100]]);
      await receive(po, lines[0]!, 1);
      expect(await rejects(as(app, T.id, (tx) => tx`update goods_receipt_lines set quantity = 9 where po_line_id = ${lines[0]}`))).toMatch(/permission denied/);
      expect(await rejects(as(app, T.id, (tx) => tx`update purchase_orders set status = 'cancelled' where id = ${po}`))).toMatch(/close it instead/);
      await as(app, T.id, (tx) => tx`update purchase_orders set status = 'closed', closed_at = now() where id = ${po}`);
    });
  });

  describe('three-way match', () => {
    it('refuses to approve billing beyond what was received', async () => {
      const { po, lines } = await order('approved', [[10, 100]]);
      await receive(po, lines[0]!, 4);
      expect(await rejects(invoiceAgainst(lines[0]!, 5, 100))).toMatch(/invoiced 5.000 but only 4.000 received/);
      await invoiceAgainst(lines[0]!, 4, 100);
      // A second invoice for the same received goods is a duplicate bill.
      expect(await rejects(invoiceAgainst(lines[0]!, 1, 100))).toMatch(/invoiced 5.000 but only 4.000 received/);
    });

    it('refuses a price above the order, unless overridden with a reason', async () => {
      const { po, lines } = await order('approved', [[10, 100]]);
      await receive(po, lines[0]!, 10);
      expect(await rejects(invoiceAgainst(lines[0]!, 2, 110))).toMatch(/invoiced at 110.00 against an order price of 100.00/);
      await invoiceAgainst(lines[0]!, 2, 110, 'Supplier price increase agreed by phone 3 Nov');
    });

    it('allows a price tolerance when configured', async () => {
      await as(app, T.id, (tx) => tx`insert into procurement_settings (tenant_id, price_tolerance_pct) values (${T.id}, 5)`);
      const { po, lines } = await order('approved', [[10, 100]]);
      await receive(po, lines[0]!, 10);
      await invoiceAgainst(lines[0]!, 1, 105);
      expect(await rejects(invoiceAgainst(lines[0]!, 1, 105.01))).toMatch(/order price/);
    });
  });

  describe('subcontracts', () => {
    let sc: string;
    let cert: string;
    const insertCert = (no: number, gross: number, ret: number, prevGross: number, prevRet: number) =>
      as(app, T.id, (tx) => tx`
        insert into subcontract_certificates (tenant_id, subcontract_id, cert_no, period_end, work_done_to_date, retention_to_date, net_to_date,
                                              previous_gross, previous_retention, previously_certified, amount_due, created_by)
        values (${T.id}, ${sc}, ${no}, ${`2026-1${no}-28`}, ${gross}, ${ret}, ${gross - ret}, ${prevGross}, ${prevRet}, ${prevGross - prevRet},
                ${gross - ret - (prevGross - prevRet)}, ${T.user}) returning id`);

    it('needs a cost code on the same project', async () => {
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into subcontracts (tenant_id, project_id, supplier_id, ref, scope, cost_code_id, contract_value, created_by)
          values (${T.id}, ${T.project}, ${T.supplier}, 'SC-X', 'x', ${T.otherCode}, 1000, ${T.user})`)),
      ).toMatch(/does not belong to this project/);
      const [s] = await as(app, T.id, (tx) => tx`
        insert into subcontracts (tenant_id, project_id, supplier_id, ref, scope, cost_code_id, contract_value, created_by)
        values (${T.id}, ${T.project}, ${T.supplier}, 'SC-01', 'Cladding', ${T.code}, 1000000, ${T.user}) returning id`);
      sc = s!.id;
    });

    it('only certifies against an active subcontract, whose terms are then fixed', async () => {
      expect(await rejects(insertCert(1, 200000, 10000, 0, 0))).toMatch(/active subcontract/);
      await as(app, T.id, (tx) => tx`update subcontracts set status = 'active' where id = ${sc}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update subcontracts set contract_value = 2000000 where id = ${sc}`))).toMatch(/value, retention and parties are fixed/);
      await as(app, T.id, (tx) => tx`update subcontracts set scope = 'Cladding and flashings' where id = ${sc}`);
    });

    it('checks certificate arithmetic and allows one open certificate', async () => {
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into subcontract_certificates (tenant_id, subcontract_id, cert_no, period_end, work_done_to_date, retention_to_date, net_to_date, amount_due, created_by)
          values (${T.id}, ${sc}, 1, '2026-11-28', 200000, 10000, 190000, 999, ${T.user})`)),
      ).toMatch(/check constraint/);
      const [c] = await insertCert(1, 200000, 10000, 0, 0);
      cert = c!.id;
      expect(await rejects(insertCert(2, 300000, 15000, 200000, 10000))).toMatch(/certify the open certificate/);
    });

    it('freezes a certified certificate, except linking its invoice', async () => {
      await as(app, T.id, (tx) => tx`update subcontract_certificates set status = 'certified', certified_at = now(), certified_by = ${T.user} where id = ${cert}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update subcontract_certificates set notes = 'x' where id = ${cert}`))).toMatch(/certified and cannot change/);
      expect(await rejects(as(app, T.id, (tx) => tx`delete from subcontract_certificates where id = ${cert}`))).toMatch(/cannot be deleted/);
      await insertCert(2, 300000, 15000, 200000, 10000);
    });
  });

  describe('RFQs', () => {
    it('locks items and quotes once awarded', async () => {
      const [r] = await as(app, T.id, (tx) => tx`insert into rfqs (tenant_id, rfq_no, title, closing_date, created_by) values (${T.id}, 1, 'Lagging', '2026-11-20', ${T.user}) returning id`);
      const [it] = await as(app, T.id, (tx) => tx`insert into rfq_items (tenant_id, rfq_id, line_no, description, unit, quantity) values (${T.id}, ${r!.id}, 1, 'Lagging', 'm2', 100) returning id`);
      const [q] = await as(app, T.id, (tx) => tx`insert into rfq_quotes (tenant_id, rfq_id, supplier_id) values (${T.id}, ${r!.id}, ${T.supplier}) returning id`);
      await as(app, T.id, (tx) => tx`insert into rfq_quote_prices (tenant_id, quote_id, item_id, unit_price) values (${T.id}, ${q!.id}, ${it!.id}, 95)`);
      expect(await rejects(as(app, T.id, (tx) => tx`update rfqs set status = 'awarded' where id = ${r!.id}`))).toMatch(/choose the winning quote/);
      await as(app, T.id, (tx) => tx`update rfqs set status = 'awarded', awarded_quote_id = ${q!.id} where id = ${r!.id}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update rfq_quote_prices set unit_price = 1 where quote_id = ${q!.id}`))).toMatch(/awarded and can no longer change/);
      expect(await rejects(as(app, T.id, (tx) => tx`update rfqs set title = 'x' where id = ${r!.id}`))).toMatch(/awarded and can no longer change/);
    });
  });

  it('isolates procurement tables between tenants', async () => {
    for (const table of ['purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'rfqs', 'subcontracts', 'subcontract_certificates', 'procurement_settings']) {
      const rows = await as(app, OTHER.id, (tx) => tx`select 1 from ${tx(table)} where tenant_id = ${T.id}`);
      expect(rows, table).toHaveLength(0);
    }
  });
});
