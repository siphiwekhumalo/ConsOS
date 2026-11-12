/**
 * Project-controls guarantees (migration 0007), enforced by the database as the
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
const T = { id: randomUUID(), slug: `pc-a-${run}`, user: randomUUID(), project: randomUUID(), other: randomUUID() };
const OTHER = { id: randomUUID(), slug: `pc-b-${run}` };

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

describe.skipIf(!OWNER_URL || !APP_URL)('project controls (0007)', () => {
  let codeA: string;
  let codeOther: string;
  let cost: string;

  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [T, OTHER]) {
      await as(owner, t.id, (tx) => tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`);
    }
    await as(owner, T.id, async (tx) => {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role)
               values (${T.user}, ${T.id}, 'qs@x.test', 'QS', 'x', 'finance')`;
      await tx`insert into projects (id, tenant_id, code, name, contract_value) values (${T.project}, ${T.id}, 'P-1', 'Plant upgrade', 1000000)`;
      await tx`insert into projects (id, tenant_id, code, name) values (${T.other}, ${T.id}, 'P-2', 'Other job')`;
    });
    app = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  });

  it('gives projects default 5% retention terms', async () => {
    const [p] = await as(app, T.id, (tx) => tx`select retention_pct, retention_limit_pct from projects where id = ${T.project}`);
    expect(p).toMatchObject({ retention_pct: '5.00', retention_limit_pct: '5.00' });
  });

  it('keeps cost codes unique per project', async () => {
    const [a] = await as(app, T.id, (tx) => tx`
      insert into cost_codes (tenant_id, project_id, code, description, budget)
      values (${T.id}, ${T.project}, '100', 'Insulation labour', 250000) returning id`);
    codeA = a!.id;
    const [o] = await as(app, T.id, (tx) => tx`
      insert into cost_codes (tenant_id, project_id, code, description) values (${T.id}, ${T.other}, '100', 'Other') returning id`);
    codeOther = o!.id;
    expect(
      await rejects(as(app, T.id, (tx) => tx`
        insert into cost_codes (tenant_id, project_id, code, description) values (${T.id}, ${T.project}, '100', 'dup')`)),
    ).toMatch(/duplicate key/);
  });

  it('rejects a cost posted to another project’s cost code', async () => {
    expect(
      await rejects(as(app, T.id, (tx) => tx`
        insert into cost_entries (tenant_id, project_id, cost_code_id, entry_date, category, description, amount, created_by)
        values (${T.id}, ${T.project}, ${codeOther}, '2026-11-01', 'labour', 'x', 10, ${T.user})`)),
    ).toMatch(/does not belong to this project/);
  });

  it('keeps cost entries append-only and non-zero', async () => {
    const [c] = await as(app, T.id, (tx) => tx`
      insert into cost_entries (tenant_id, project_id, cost_code_id, entry_date, category, description, amount, created_by)
      values (${T.id}, ${T.project}, ${codeA}, '2026-11-01', 'labour', 'Week 44 timesheets', 48250.50, ${T.user}) returning id`);
    cost = c!.id;
    expect(await rejects(as(app, T.id, (tx) => tx`update cost_entries set amount = 1 where id = ${cost}`))).toMatch(/permission denied/);
    expect(await rejects(as(app, T.id, (tx) => tx`delete from cost_entries where id = ${cost}`))).toMatch(/permission denied/);
    expect(
      await rejects(as(app, T.id, (tx) => tx`
        insert into cost_entries (tenant_id, project_id, cost_code_id, entry_date, category, description, amount, created_by)
        values (${T.id}, ${T.project}, ${codeA}, '2026-11-01', 'labour', 'zero', 0, ${T.user})`)),
    ).toMatch(/check constraint/);
  });

  it('allows an entry to be reversed only once', async () => {
    const reverse = () => as(app, T.id, (tx) => tx`
      insert into cost_entries (tenant_id, project_id, cost_code_id, entry_date, category, description, amount, reverses_id, created_by)
      values (${T.id}, ${T.project}, ${codeA}, '2026-11-02', 'labour', 'Reversal', -48250.50, ${cost}, ${T.user})`);
    await reverse();
    expect(await rejects(reverse())).toMatch(/duplicate key/);
  });

  it('runs variations through draft → submitted → approved and then freezes them', async () => {
    const [v] = await as(app, T.id, (tx) => tx`
      insert into variations (tenant_id, project_id, ref, title, notified_on, value_claimed, cost_estimate, created_by)
      values (${T.id}, ${T.project}, 'VO-01', 'Extra pipe rack', '2026-10-20', 85000, 60000, ${T.user}) returning id, status`);
    expect(v!.status).toBe('draft');
    expect(
      await rejects(as(app, T.id, (tx) => tx`update variations set status = 'approved', value_approved = 1, decided_at = now() where id = ${v!.id}`)),
    ).toMatch(/invalid variation transition draft -> approved/);
    await as(app, T.id, (tx) => tx`update variations set status = 'submitted', submitted_at = now() where id = ${v!.id}`);
    expect(
      await rejects(as(app, T.id, (tx) => tx`update variations set status = 'approved' where id = ${v!.id}`)),
    ).toMatch(/check constraint/); // approval needs a value and a decision date
    await as(app, T.id, (tx) => tx`
      update variations set status = 'approved', value_approved = 80000, decided_at = now(), decided_by = ${T.user} where id = ${v!.id}`);
    expect(
      await rejects(as(app, T.id, (tx) => tx`update variations set value_approved = 999999 where id = ${v!.id}`)),
    ).toMatch(/is approved and cannot change/);
  });

  it('rejects variations that do not start as draft', async () => {
    expect(
      await rejects(as(app, T.id, (tx) => tx`
        insert into variations (tenant_id, project_id, ref, title, notified_on, status, created_by)
        values (${T.id}, ${T.project}, 'VO-X', 't', '2026-10-20', 'submitted', ${T.user})`)),
    ).toMatch(/start as draft/);
  });

  describe('valuations', () => {
    let v1: string;
    const insert = (no: number, period: string, work: number, gross: number, ret: number, net: number, prev: number, due: number) =>
      as(app, T.id, (tx) => tx`
        insert into valuations (tenant_id, project_id, valuation_no, period_end, work_done_to_date, gross_to_date,
                                retention_pct, retention_to_date, net_to_date, previously_certified, amount_due, created_by)
        values (${T.id}, ${T.project}, ${no}, ${period}, ${work}, ${gross}, 5, ${ret}, ${net}, ${prev}, ${due}, ${T.user})
        returning id`);

    it('rejects figures that do not add up', async () => {
      expect(await rejects(insert(1, '2026-10-31', 200000, 200000, 10000, 195000, 0, 195000))).toMatch(/check constraint/);
    });

    it('allows only one open valuation at a time', async () => {
      const [v] = await insert(1, '2026-10-31', 200000, 200000, 10000, 190000, 0, 190000);
      v1 = v!.id;
      expect(await rejects(insert(2, '2026-11-30', 300000, 300000, 15000, 285000, 190000, 95000))).toMatch(/certify the open valuation/);
    });

    it('needs a certificate reference to certify', async () => {
      await as(app, T.id, (tx) => tx`update valuations set status = 'submitted', submitted_at = now() where id = ${v1}`);
      expect(
        await rejects(as(app, T.id, (tx) => tx`update valuations set status = 'certified', certified_at = now() where id = ${v1}`)),
      ).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`
        update valuations set status = 'certified', certified_at = now(), certified_by = ${T.user}, certificate_ref = 'IPC-01' where id = ${v1}`);
    });

    it('freezes a certified valuation except for recording payment', async () => {
      expect(
        await rejects(as(app, T.id, (tx) => tx`update valuations set notes = 'edit' where id = ${v1}`)),
      ).toMatch(/certified and cannot change/);
      expect(
        await rejects(as(app, T.id, (tx) => tx`update valuations set status = 'paid', paid_on = '2026-11-20', notes = 'sneak' where id = ${v1}`)),
      ).toMatch(/certified and cannot change/);
      await as(app, T.id, (tx) => tx`update valuations set status = 'paid', paid_on = '2026-11-20' where id = ${v1}`);
      expect(
        await rejects(as(app, T.id, (tx) => tx`update valuations set paid_on = '2026-11-21' where id = ${v1}`)),
      ).toMatch(/paid and cannot change/);
    });

    it('opens the next valuation once the previous is certified', async () => {
      await insert(2, '2026-11-30', 300000, 300000, 15000, 285000, 190000, 95000);
    });

    it('cannot delete valuations', async () => {
      expect(await rejects(as(app, T.id, (tx) => tx`delete from valuations where id = ${v1}`))).toMatch(/permission denied/);
    });
  });

  it('hides every project-controls table from other tenants', async () => {
    for (const table of ['cost_codes', 'cost_entries', 'variations', 'valuations']) {
      const rows = await as(app, OTHER.id, (tx) => tx`select id from ${tx(table)} where tenant_id = ${T.id}`);
      expect(rows, table).toHaveLength(0);
    }
    expect(
      await rejects(as(app, OTHER.id, (tx) => tx`
        insert into cost_codes (tenant_id, project_id, code, description) values (${T.id}, ${T.project}, 'X', 'cross-tenant')`)),
    ).toMatch(/row-level security/);
  });
});
