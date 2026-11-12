/**
 * HR & payroll guarantees (migration 0011), enforced by the database as the
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
const T = { id: randomUUID(), slug: `pay-a-${run}`, user: randomUUID(), project: randomUUID(), other: randomUUID(), code: randomUUID(), emp: randomUUID() };
const OTHER = { id: randomUUID(), slug: `pay-b-${run}` };

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

const time = (date: string, normal: number, extra: { ot?: number; code?: string; project?: string } = {}) =>
  as(app, T.id, (tx) => tx`
    insert into time_entries (tenant_id, employee_id, project_id, cost_code_id, work_date, normal_hours, overtime_hours, captured_by)
    values (${T.id}, ${T.emp}, ${extra.project ?? T.project}, ${extra.code ?? T.code}, ${date}, ${normal}, ${extra.ot ?? 0}, ${T.user}) returning id`);

describe.skipIf(!OWNER_URL || !APP_URL)('HR & payroll (0011)', () => {
  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [T, OTHER]) {
      await as(owner, t.id, (tx) => tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`);
    }
    await as(owner, T.id, async (tx) => {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${T.user}, ${T.id}, 'hr@x.test', 'HR', 'x', 'finance')`;
      await tx`insert into projects (id, tenant_id, code, name) values (${T.project}, ${T.id}, 'P-1', 'One'), (${T.other}, ${T.id}, 'P-2', 'Two')`;
      await tx`insert into cost_codes (id, tenant_id, project_id, code, description) values (${T.code}, ${T.id}, ${T.project}, '100', 'Labour')`;
    });
    app = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  });

  it('serves SARS tax tables read-only', async () => {
    const [t] = await as(app, T.id, (tx) => tx`select primary_rebate, uif_ceiling_monthly from tax_tables where tax_year = '2025/26'`);
    expect(t).toMatchObject({ primary_rebate: '17235.00', uif_ceiling_monthly: '17712.00' });
    expect(await rejects(as(app, T.id, (tx) => tx`update tax_tables set primary_rebate = 0`))).toMatch(/permission denied/);
  });

  it('keeps personal details apart and requires an ID or passport', async () => {
    await as(app, T.id, (tx) => tx`
      insert into employees (id, tenant_id, employee_no, first_name, last_name, occupation, employment_type, pay_basis, rate, start_date)
      values (${T.emp}, ${T.id}, 'E001', 'Sipho', 'Ndlovu', 'Insulator', 'permanent', 'hourly', 65, '2025-01-06')`);
    expect(await rejects(as(app, T.id, (tx) => tx`insert into employee_private (employee_id, tenant_id, date_of_birth) values (${T.emp}, ${T.id}, '1990-04-01')`))).toMatch(/check constraint/);
    expect(await rejects(as(app, T.id, (tx) => tx`insert into employee_private (employee_id, tenant_id, id_number, date_of_birth) values (${T.emp}, ${T.id}, '90040150', '1990-04-01')`))).toMatch(/check constraint/);
    await as(app, T.id, (tx) => tx`insert into employee_private (employee_id, tenant_id, id_number, date_of_birth) values (${T.emp}, ${T.id}, '9004015800087', '1990-04-01')`);
    expect(await rejects(as(app, T.id, (tx) => tx`update employees set status = 'terminated' where id = ${T.emp}`))).toMatch(/check constraint/);
  });

  describe('timesheets', () => {
    it('bounds a day at 16 hours and only while employed', async () => {
      await time('2025-11-03', 9, { ot: 3 });
      expect(await rejects(time('2025-11-03', 5))).toMatch(/more than 16 hours/);
      expect(await rejects(time('2024-12-31', 8))).toMatch(/not employed/);
      expect(await rejects(time('2025-11-04', 8, { project: T.other }))).toMatch(/cost code does not belong/);
    });

    it('freezes approved time unless it is returned to submitted', async () => {
      const [t] = await time('2025-11-05', 8);
      await as(app, T.id, (tx) => tx`update time_entries set status = 'approved', approved_by = ${T.user} where id = ${t!.id}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update time_entries set normal_hours = 9 where id = ${t!.id}`))).toMatch(/approved time cannot change/);
      expect(await rejects(as(app, T.id, (tx) => tx`delete from time_entries where id = ${t!.id}`))).toMatch(/approved time cannot change/);
      await as(app, T.id, (tx) => tx`update time_entries set status = 'submitted', approved_by = null where id = ${t!.id}`);
    });
  });

  it('never lets approved leave overlap, and only cancels it', async () => {
    const leave = (from: string, to: string) => as(app, T.id, (tx) => tx`
      insert into leave_requests (tenant_id, employee_id, kind, starts_on, ends_on, days, status, decided_by, created_by)
      values (${T.id}, ${T.emp}, 'annual', ${from}, ${to}, 3, 'approved', ${T.user}, ${T.user}) returning id`);
    const [l] = await leave('2025-11-17', '2025-11-19');
    expect(await rejects(leave('2025-11-19', '2025-11-21'))).toMatch(/overlaps leave already approved/);
    expect(await rejects(as(app, T.id, (tx) => tx`update leave_requests set days = 1 where id = ${l!.id}`))).toMatch(/can only be cancelled/);
    await as(app, T.id, (tx) => tx`update leave_requests set status = 'cancelled' where id = ${l!.id}`);
    await leave('2025-11-19', '2025-11-21');
  });

  describe('pay runs', () => {
    let runId: string;
    const slip = (net: number) => as(app, T.id, (tx) => tx`
      insert into payslips (tenant_id, pay_run_id, employee_id, earnings, gross, paye, uif_employee, net, uif_employer, sdl, employer_cost)
      values (${T.id}, ${runId}, ${T.emp}, '[]'::jsonb, 10000, 900, 100, ${net}, 100, 100, 10200)`);

    it('checks payslip arithmetic', async () => {
      const [r] = await as(app, T.id, (tx) => tx`insert into pay_runs (tenant_id, period, pay_date, tax_year, created_by) values (${T.id}, '2025-11', '2025-11-25', '2025/26', ${T.user}) returning id`);
      runId = r!.id;
      expect(await rejects(slip(9001))).toMatch(/check constraint/);
      await slip(9000);
    });

    it('needs a known tax year', async () => {
      expect(await rejects(as(app, T.id, (tx) => tx`insert into pay_runs (tenant_id, period, pay_date, tax_year, created_by) values (${T.id}, '2030-11', '2030-11-25', '2030/31', ${T.user})`))).toMatch(/foreign key/);
    });

    it('freezes the month once finalised: run, payslips, time and leave', async () => {
      await as(app, T.id, (tx) => tx`update pay_runs set status = 'finalised', finalised_at = now(), finalised_by = ${T.user} where id = ${runId}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update pay_runs set net_total = 1 where id = ${runId}`))).toMatch(/pay_runs is finalised/);
      expect(await rejects(as(app, T.id, (tx) => tx`update payslips set paye = 0, net = 9900 where pay_run_id = ${runId}`))).toMatch(/payslips cannot change/);
      expect(await rejects(time('2025-11-06', 8))).toMatch(/payroll for 2025-11 is finalised/);
      expect(await rejects(as(app, T.id, (tx) => tx`update time_entries set normal_hours = 7 where work_date = '2025-11-05'`))).toMatch(/finalised/);
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into leave_requests (tenant_id, employee_id, kind, starts_on, ends_on, days, created_by) values (${T.id}, ${T.emp}, 'sick', '2025-11-10', '2025-11-10', 1, ${T.user})`)),
      ).toMatch(/finalised/);
      await time('2025-12-01', 8); // next month is open
    });
  });

  it('isolates payroll tables between tenants, and the AI engine cannot read them', async () => {
    for (const table of ['employees', 'employee_private', 'time_entries', 'leave_requests', 'pay_runs', 'payslips']) {
      const rows = await as(app, OTHER.id, (tx) => tx`select 1 from ${tx(table)} where tenant_id = ${T.id}`);
      expect(rows, table).toHaveLength(0);
    }
    const [{ allowed }] = await owner`select has_table_privilege('constructos_ai', 'employee_private', 'select') as allowed`;
    expect(allowed).toBe(false);
  });
});
