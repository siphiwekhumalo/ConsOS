/**
 * Plant, HSE and quality guarantees (migration 0010), enforced by the database
 * as the app role regardless of what the API does.
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;

const run = Date.now().toString(36);
const T = { id: randomUUID(), slug: `ph-a-${run}`, user: randomUUID(), project: randomUUID(), code: randomUUID(), otherCode: randomUUID(), other: randomUUID() };
const OTHER = { id: randomUUID(), slug: `ph-b-${run}` };

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

describe.skipIf(!OWNER_URL || !APP_URL)('plant, HSE and quality (0010)', () => {
  let excavator: string;

  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [T, OTHER]) {
      await as(owner, t.id, (tx) => tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`);
    }
    await as(owner, T.id, async (tx) => {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${T.user}, ${T.id}, 'hse@x.test', 'HSE', 'x', 'project_manager')`;
      await tx`insert into projects (id, tenant_id, code, name) values (${T.project}, ${T.id}, 'P-1', 'Plant'), (${T.other}, ${T.id}, 'P-2', 'Other')`;
      await tx`insert into cost_codes (id, tenant_id, project_id, code, description) values (${T.code}, ${T.id}, ${T.project}, '400', 'Plant'), (${T.otherCode}, ${T.id}, ${T.other}, '400', 'Plant')`;
    });
    app = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  });

  describe('plant', () => {
    it('keeps status consistent with the site and disposal', async () => {
      const [a] = await as(app, T.id, (tx) => tx`
        insert into assets (tenant_id, asset_no, name, category, meter_unit, charge_rate) values (${T.id}, 'EX-01', '20t excavator', 'earthmoving', 'hours', 4500) returning id`);
      excavator = a!.id;
      expect(await rejects(as(app, T.id, (tx) => tx`update assets set status = 'on_site' where id = ${excavator}`))).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`update assets set status = 'on_site', current_project_id = ${T.project} where id = ${excavator}`);
    });

    it('never lets a meter go backwards, and updates the asset', async () => {
      await as(app, T.id, (tx) => tx`insert into asset_meter_readings (tenant_id, asset_id, read_on, reading, recorded_by) values (${T.id}, ${excavator}, '2026-11-01', 1200, ${T.user})`);
      expect(await rejects(as(app, T.id, (tx) => tx`insert into asset_meter_readings (tenant_id, asset_id, read_on, reading, recorded_by) values (${T.id}, ${excavator}, '2026-11-02', 1199.9, ${T.user})`))).toMatch(/lower than the last reading 1200/);
      const [row] = await as(app, T.id, (tx) => tx`select meter_reading from assets where id = ${excavator}`);
      expect(row!.meter_reading).toBe('1200.0');
      expect(await rejects(as(app, T.id, (tx) => tx`update asset_meter_readings set reading = 1 where asset_id = ${excavator}`))).toMatch(/permission denied/);
    });

    it('charges plant usage at most one day per date, to a cost code on that project', async () => {
      const usage = (project: string, code: string, date: string, q: number) => as(app, T.id, (tx) => tx`
        insert into plant_usage (tenant_id, asset_id, project_id, cost_code_id, used_on, quantity, rate_unit, rate, amount, recorded_by)
        values (${T.id}, ${excavator}, ${project}, ${code}, ${date}, ${q}, 'day', 4500, ${q * 4500}, ${T.user})`);
      expect(await rejects(usage(T.project, T.otherCode, '2026-11-03', 1))).toMatch(/does not belong to this project/);
      await usage(T.project, T.code, '2026-11-03', 0.5);
      await usage(T.other, T.otherCode, '2026-11-03', 0.5);
      expect(await rejects(usage(T.project, T.code, '2026-11-03', 0.5))).toMatch(/already charged for a full day/);
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into plant_usage (tenant_id, asset_id, project_id, cost_code_id, used_on, quantity, rate_unit, rate, amount, recorded_by)
          values (${T.id}, ${excavator}, ${T.project}, ${T.code}, '2026-11-04', 1, 'day', 4500, 4000, ${T.user})`)),
      ).toMatch(/check constraint/);
      expect(await rejects(as(app, T.id, (tx) => tx`delete from plant_usage where asset_id = ${excavator}`))).toMatch(/permission denied/);
    });

    it('freezes completed work orders and disposed assets', async () => {
      const [wo] = await as(app, T.id, (tx) => tx`
        insert into work_orders (tenant_id, wo_no, asset_id, kind, description, reported_on, created_by) values (${T.id}, 1, ${excavator}, 'repair', 'Hydraulic leak', '2026-11-05', ${T.user}) returning id`);
      expect(await rejects(as(app, T.id, (tx) => tx`update work_orders set status = 'completed' where id = ${wo!.id}`))).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`update work_orders set status = 'completed', completed_on = '2026-11-06', work_done = 'Replaced hose' where id = ${wo!.id}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update work_orders set parts_cost = 1 where id = ${wo!.id}`))).toMatch(/work_orders is completed and cannot change/);

      await as(app, T.id, (tx) => tx`update assets set status = 'disposed', current_project_id = null, disposed_on = '2026-11-10' where id = ${excavator}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update assets set name = 'x' where id = ${excavator}`))).toMatch(/assets is disposed and cannot change/);
      expect(await rejects(as(app, T.id, (tx) => tx`insert into asset_meter_readings (tenant_id, asset_id, read_on, reading, recorded_by) values (${T.id}, ${excavator}, '2026-11-11', 1300, ${T.user})`))).toMatch(/disposed/);
    });
  });

  describe('incidents', () => {
    const insert = (type: string, severity: string, daysLost: number) => as(app, T.id, (tx) => tx`
      insert into incidents (tenant_id, incident_no, project_id, occurred_at, type, severity, title, description, days_lost, reported_by)
      values (${T.id}, ${Math.floor(Math.random() * 1e9)}, ${T.project}, now(), ${type}, ${severity}, 't', 'd', ${daysLost}, ${T.user}) returning id`);

    it('keeps severity consistent', async () => {
      expect(await rejects(insert('near_miss', 'first_aid', 0))).toMatch(/check constraint/);
      expect(await rejects(insert('injury', 'lost_time', 0))).toMatch(/check constraint/);
    });

    it('cannot close without a root cause, and is frozen once closed', async () => {
      const [i] = await insert('injury', 'lost_time', 3);
      expect(await rejects(as(app, T.id, (tx) => tx`update incidents set status = 'closed', closed_at = now(), closed_by = ${T.user} where id = ${i!.id}`))).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`update incidents set status = 'closed', closed_at = now(), closed_by = ${T.user}, root_cause = 'Unguarded edge' where id = ${i!.id}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update incidents set days_lost = 0 where id = ${i!.id}`))).toMatch(/incidents is closed and cannot change/);
    });
  });

  describe('quality', () => {
    it('stores inspections only with an outcome that matches the checklist, and never edits them', async () => {
      const items = [{ item: 'Edge protection', result: 'pass' }, { item: 'Scaffold tag', result: 'fail' }];
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into inspections (tenant_id, inspection_no, project_id, kind, title, inspected_on, inspector, items, failed_items, passed)
          values (${T.id}, 1, ${T.project}, 'safety', 'Weekly', '2026-11-05', ${T.user}, ${tx.json(items)}, 0, true)`)),
      ).toMatch(/failed item count does not match/);
      expect(
        await rejects(as(app, T.id, (tx) => tx`
          insert into inspections (tenant_id, inspection_no, project_id, kind, title, inspected_on, inspector, items, failed_items, passed)
          values (${T.id}, 1, ${T.project}, 'safety', 'Weekly', '2026-11-05', ${T.user}, '[{"item":"x","result":"maybe"}]'::jsonb, 0, true)`)),
      ).toMatch(/pass, fail or na/);
      const [ins] = await as(app, T.id, (tx) => tx`
        insert into inspections (tenant_id, inspection_no, project_id, kind, title, inspected_on, inspector, items, failed_items, passed)
        values (${T.id}, 1, ${T.project}, 'safety', 'Weekly', '2026-11-05', ${T.user}, ${tx.json(items)}, 1, false) returning id`);
      expect(await rejects(as(app, T.id, (tx) => tx`update inspections set passed = true where id = ${ins!.id}`))).toMatch(/permission denied/);
    });

    it('requires a corrective action, root cause and verifier to close an NCR', async () => {
      const [n] = await as(app, T.id, (tx) => tx`
        insert into ncrs (tenant_id, ncr_no, project_id, title, description, category, severity, raised_on, raised_by)
        values (${T.id}, 1, ${T.project}, 'Lagging gaps', 'Joints not sealed', 'workmanship', 'major', '2026-11-05', ${T.user}) returning id`);
      expect(await rejects(as(app, T.id, (tx) => tx`update ncrs set status = 'action_proposed' where id = ${n!.id}`))).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`update ncrs set status = 'action_proposed', corrective_action = 'Re-seal joints' where id = ${n!.id}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update ncrs set status = 'closed', closed_on = '2026-11-08' where id = ${n!.id}`))).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`update ncrs set status = 'closed', closed_on = '2026-11-08', verified_by = ${T.user}, root_cause = 'No hold point' where id = ${n!.id}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update ncrs set rework_cost = 1 where id = ${n!.id}`))).toMatch(/ncrs is closed/);
    });

    it('freezes completed corrective actions', async () => {
      const [a] = await as(app, T.id, (tx) => tx`
        insert into corrective_actions (tenant_id, source_type, source_id, action, owner_name, due_on, created_by)
        values (${T.id}, 'ncr', ${randomUUID()}, 'Add hold point', 'QC lead', '2026-11-20', ${T.user}) returning id`);
      expect(await rejects(as(app, T.id, (tx) => tx`update corrective_actions set status = 'done' where id = ${a!.id}`))).toMatch(/check constraint/);
      await as(app, T.id, (tx) => tx`update corrective_actions set status = 'done', completed_on = '2026-11-12' where id = ${a!.id}`);
      expect(await rejects(as(app, T.id, (tx) => tx`update corrective_actions set due_on = '2026-12-01' where id = ${a!.id}`))).toMatch(/is done and cannot change/);
    });
  });

  it('isolates every table between tenants', async () => {
    for (const table of ['assets', 'asset_meter_readings', 'plant_usage', 'work_orders', 'incidents', 'inspections', 'ncrs', 'corrective_actions']) {
      const rows = await as(app, OTHER.id, (tx) => tx`select 1 from ${tx(table)} where tenant_id = ${T.id}`);
      expect(rows, table).toHaveLength(0);
    }
  });
});
