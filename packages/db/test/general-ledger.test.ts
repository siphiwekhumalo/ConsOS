/**
 * General-ledger guarantees (migration 0008), enforced by the database as the
 * app role regardless of what the API does.
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;

const run = Date.now().toString(36);
const T = { id: randomUUID(), slug: `gl-a-${run}`, user: randomUUID(), bank: randomUUID(), exp: randomUUID(), ap: randomUUID(), old: randomUUID(), supplier: randomUUID() };
const OTHER = { id: randomUUID(), slug: `gl-b-${run}` };

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

/** Insert a journal with lines [accountId, debit, credit][] in one transaction. */
async function journal(date: string, lines: [string, number, number][], tenant = T.id) {
  return as(app, tenant, async (tx) => {
    const [{ n }] = await tx`select next_doc_no('journal') as n`;
    const [j] = await tx`
      insert into journals (tenant_id, journal_no, entry_date, description, source, posted_by)
      values (${tenant}, ${n}, ${date}, 'test', 'manual', ${T.user}) returning id`;
    for (const [account, dr, cr] of lines) {
      await tx`insert into journal_lines (tenant_id, journal_id, account_id, debit, credit) values (${tenant}, ${j!.id}, ${account}, ${dr}, ${cr})`;
    }
    return j!.id as string;
  });
}

describe.skipIf(!OWNER_URL || !APP_URL)('general ledger (0008)', () => {
  let posted: string;

  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [T, OTHER]) {
      await as(owner, t.id, (tx) => tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`);
    }
    await as(owner, T.id, async (tx) => {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${T.user}, ${T.id}, 'fin@x.test', 'Fin', 'x', 'finance')`;
      await tx`insert into accounts (id, tenant_id, code, name, type, is_bank) values
        (${T.bank}, ${T.id}, '1000', 'Bank', 'asset', true),
        (${T.exp},  ${T.id}, '6100', 'Rent', 'expense', false),
        (${T.ap},   ${T.id}, '2000', 'Payables', 'liability', false),
        (${T.old},  ${T.id}, '6999', 'Old', 'expense', false)`;
      await tx`update accounts set is_active = false where id = ${T.old}`;
      await tx`insert into suppliers (id, tenant_id, name) values (${T.supplier}, ${T.id}, 'Lagging Supplies')`;
    });
    app = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  });

  describe('journals', () => {
    it('posts a balanced journal', async () => {
      posted = await journal('2026-10-01', [[T.exp, 1000, 0], [T.bank, 0, 1000]]);
    });

    it('rejects an unbalanced journal at commit', async () => {
      expect(await rejects(journal('2026-10-01', [[T.exp, 1000, 0], [T.bank, 0, 999.99]]))).toMatch(/does not balance/);
    });

    it('rejects a journal with fewer than two lines', async () => {
      expect(await rejects(journal('2026-10-01', [[T.exp, 10, 0]]))).toMatch(/at least two lines/);
    });

    it('rejects a line with both or neither side', async () => {
      expect(await rejects(journal('2026-10-01', [[T.exp, 10, 10], [T.bank, 0, 0]]))).toMatch(/check constraint/);
    });

    it('is append-only', async () => {
      expect(await rejects(as(app, T.id, (tx) => tx`update journal_lines set debit = 1 where journal_id = ${posted}`))).toMatch(/permission denied/);
      expect(await rejects(as(app, T.id, (tx) => tx`delete from journals where id = ${posted}`))).toMatch(/permission denied/);
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into journal_lines (tenant_id, journal_id, account_id, debit) values (${T.id}, ${posted}, ${T.exp}, 5)`)),
      ).toMatch(/cannot be added to a posted journal/);
    });

    it('refuses inactive accounts', async () => {
      expect(await rejects(journal('2026-10-01', [[T.old, 10, 0], [T.bank, 0, 10]]))).toMatch(/inactive/);
    });

    it('refuses postings in a locked period', async () => {
      await as(app, T.id, (tx) => tx`insert into finance_settings (tenant_id, locked_through) values (${T.id}, '2026-10-31')`);
      expect(await rejects(journal('2026-10-31', [[T.exp, 10, 0], [T.bank, 0, 10]]))).toMatch(/locked/);
      await journal('2026-11-01', [[T.exp, 10, 0], [T.bank, 0, 10]]);
    });

    it('cannot change the type of an account with postings', async () => {
      expect(await rejects(as(app, T.id, (tx) => tx`update accounts set type = 'asset' where id = ${T.exp}`))).toMatch(/type cannot change/);
    });

    it('numbers documents per tenant without gaps', async () => {
      const a = await as(app, OTHER.id, (tx) => tx`select next_doc_no('payment_out') as n`);
      const b = await as(app, OTHER.id, (tx) => tx`select next_doc_no('payment_out') as n`);
      expect([a[0]!.n, b[0]!.n]).toEqual([1, 2]);
    });
  });

  describe('supplier invoices', () => {
    let inv: string;

    it('starts as a draft whose lines can change', async () => {
      const [i] = await as(app, T.id, (tx) => tx`
        insert into supplier_invoices (tenant_id, supplier_id, invoice_no, invoice_date, due_date, subtotal, vat_total, total, created_by)
        values (${T.id}, ${T.supplier}, 'LS-100', '2026-11-02', '2026-12-02', 1000, 150, 1150, ${T.user}) returning id`);
      inv = i!.id;
      await as(app, T.id, (tx) => tx`
        insert into supplier_invoice_lines (tenant_id, invoice_id, line_no, description, account_id, amount, vat_amount)
        values (${T.id}, ${inv}, 1, 'Rent', ${T.exp}, 1000, 150)`);
      await as(app, T.id, (tx) => tx`update supplier_invoice_lines set description = 'Office rent' where invoice_id = ${inv}`);
    });

    it('cannot be approved without a journal, nor with totals that do not add up', async () => {
      expect(await rejects(as(app, T.id, (tx) => tx`update supplier_invoices set status = 'approved', approved_at = now() where id = ${inv}`))).toMatch(/check constraint/);
      expect(await rejects(as(app, T.id, (tx) => tx`update supplier_invoices set total = 1 where id = ${inv}`))).toMatch(/check constraint/);
    });

    it('freezes once approved: only payment progress may change', async () => {
      const j = await journal('2026-11-02', [[T.exp, 1150, 0], [T.ap, 0, 1150]]);
      await as(app, T.id, (tx) => tx`update supplier_invoices set status = 'approved', journal_id = ${j}, approved_at = now() where id = ${inv}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update supplier_invoices set notes = 'edit' where id = ${inv}`))).toMatch(/approved and cannot be edited/);
      expect(await rejects(as(app, T.id, (tx) => tx`update supplier_invoice_lines set amount = 1 where invoice_id = ${inv}`))).toMatch(/frozen/);
      expect(await rejects(as(app, T.id, (tx) => tx`delete from supplier_invoices where id = ${inv}`))).toMatch(/only a draft invoice can be deleted/);
    });

    it('keeps the paid status consistent with the amount paid', async () => {
      expect(await rejects(as(app, T.id, (tx) => tx`update supplier_invoices set status = 'paid', amount_paid = 100 where id = ${inv}`))).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`update supplier_invoices set status = 'part_paid', amount_paid = 100 where id = ${inv}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update supplier_invoices set status = 'void' where id = ${inv}`))).toMatch(/invalid invoice transition|payments allocated/);
      await as(app, T.id, (tx) => tx`update supplier_invoices set status = 'paid', amount_paid = 1150 where id = ${inv}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update supplier_invoices set amount_paid = 0, status = 'part_paid' where id = ${inv}`))).toMatch(/paid and cannot change/);
    });

    it('rejects a duplicate supplier invoice number', async () => {
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into supplier_invoices (tenant_id, supplier_id, invoice_no, invoice_date, due_date, created_by)
          values (${T.id}, ${T.supplier}, 'LS-100', '2026-11-02', '2026-12-02', ${T.user})`)),
      ).toMatch(/duplicate key/);
    });

    it('lets a draft be deleted with its lines', async () => {
      const [i] = await as(app, T.id, (tx) => tx`
        insert into supplier_invoices (tenant_id, supplier_id, invoice_no, invoice_date, due_date, created_by)
        values (${T.id}, ${T.supplier}, 'LS-101', '2026-11-02', '2026-12-02', ${T.user}) returning id`);
      await as(app, T.id, (tx) => tx`
        insert into supplier_invoice_lines (tenant_id, invoice_id, line_no, description, account_id, amount)
        values (${T.id}, ${i!.id}, 1, 'x', ${T.exp}, 10)`);
      await as(app, T.id, (tx) => tx`delete from supplier_invoices where id = ${i!.id}`);
    });
  });

  describe('bank reconciliation', () => {
    let stmt: string;
    let bankLine: string;

    it('imports statement lines once per external id', async () => {
      const insert = () => as(app, T.id, (tx) => tx`
        insert into bank_statement_lines (tenant_id, bank_account_id, txn_date, description, amount, external_id)
        values (${T.id}, ${T.bank}, '2026-10-02', 'DEBIT ORDER RENT', -1000, 'abc') returning id`);
      const [s] = await insert();
      stmt = s!.id;
      expect(await rejects(insert())).toMatch(/duplicate key/);
    });

    it('only matches a ledger line on the same bank account for the same amount', async () => {
      const [wrongAccount] = await as(app, T.id, (tx) => tx`select id from journal_lines where journal_id = ${posted} and account_id = ${T.exp}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update bank_statement_lines set matched_line_id = ${wrongAccount!.id}, matched_at = now() where id = ${stmt}`))).toMatch(/same bank account for the same amount/);
      const [b] = await as(app, T.id, (tx) => tx`select id from journal_lines where journal_id = ${posted} and account_id = ${T.bank}`);
      bankLine = b!.id;
      await as(app, T.id, (tx) => tx`update bank_statement_lines set matched_line_id = ${bankLine}, matched_at = now() where id = ${stmt}`);
    });

    it('never matches a ledger line twice, and never edits imported data', async () => {
      const [s2] = await as(app, T.id, (tx) => tx`
        insert into bank_statement_lines (tenant_id, bank_account_id, txn_date, description, amount, external_id)
        values (${T.id}, ${T.bank}, '2026-10-03', 'DUPLICATE', -1000, 'def') returning id`);
      expect(await rejects(as(app, T.id, (tx) => tx`update bank_statement_lines set matched_line_id = ${bankLine}, matched_at = now() where id = ${s2!.id}`))).toMatch(/duplicate key/);
      expect(await rejects(as(app, T.id, (tx) => tx`update bank_statement_lines set amount = -5 where id = ${stmt}`))).toMatch(/cannot be edited/);
    });

    it('only accepts statement lines for bank accounts', async () => {
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into bank_statement_lines (tenant_id, bank_account_id, txn_date, description, amount, external_id)
          values (${T.id}, ${T.exp}, '2026-10-02', 'x', 1, 'ghi')`)),
      ).toMatch(/belong to a bank account/);
    });
  });

  it('isolates every ledger table between tenants', async () => {
    for (const table of ['accounts', 'journals', 'journal_lines', 'suppliers', 'supplier_invoices', 'bank_statement_lines', 'finance_settings']) {
      const rows = await as(app, OTHER.id, (tx) => tx`select 1 from ${tx(table)} where tenant_id = ${T.id}`);
      expect(rows, table).toHaveLength(0);
    }
    expect(await rejects(journal('2026-11-05', [[T.exp, 1, 0], [T.bank, 0, 1]], OTHER.id))).toMatch(/does not exist|row-level security|foreign key/);
  });
});
