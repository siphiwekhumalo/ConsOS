/**
 * CRM guarantees (migration 0012), enforced by the database as the app role.
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;

const run = Date.now().toString(36);
const T = { id: randomUUID(), slug: `crm-a-${run}`, user: randomUUID(), customer: randomUUID(), project: randomUUID() };
const OTHER = { id: randomUUID(), slug: `crm-b-${run}` };

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

let n = 0;
const newOpp = (stage = 'lead') => as(app, T.id, (tx) => tx`
  insert into opportunities (tenant_id, opp_no, customer_id, title, stage, owner_id, created_by)
  values (${T.id}, ${++n}, ${T.customer}, 'Boiler lagging', ${stage}, ${T.user}, ${T.user}) returning id`);
const move = (id: string, set: string) => as(app, T.id, (tx) => tx.unsafe(`update opportunities set ${set} where id = '${id}'`));

describe.skipIf(!OWNER_URL || !APP_URL)('CRM (0012)', () => {
  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [T, OTHER]) {
      await as(owner, t.id, (tx) => tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`);
    }
    await as(owner, T.id, async (tx) => {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${T.user}, ${T.id}, 'bd@x.test', 'BD', 'x', 'project_manager')`;
      await tx`insert into customers (id, tenant_id, name, sector, province) values (${T.customer}, ${T.id}, 'Sasol Secunda', 'petrochemical', 'MP')`;
      await tx`insert into projects (id, tenant_id, code, name) values (${T.project}, ${T.id}, 'P-1', 'Won job')`;
    });
    app = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  });

  it('allows one primary contact per client', async () => {
    const add = (name: string) => as(app, T.id, (tx) => tx`insert into contacts (tenant_id, customer_id, full_name, is_primary) values (${T.id}, ${T.customer}, ${name}, true)`);
    await add('Procurement lead');
    expect(await rejects(add('Second primary'))).toMatch(/duplicate key/);
  });

  it('starts as a lead or in qualifying and follows the pipeline', async () => {
    expect(await rejects(newOpp('won'))).toMatch(/start as a lead or in qualifying/);
    const [o] = await newOpp();
    expect(await rejects(move(o!.id, `stage = 'submitted'`))).toMatch(/invalid opportunity transition lead -> submitted/);
    await move(o!.id, `stage = 'qualifying'`);
    await move(o!.id, `stage = 'tendering'`);
    await move(o!.id, `stage = 'submitted'`);
    expect(await rejects(move(o!.id, `stage = 'won', closed_at = now()`))).toMatch(/check constraint/); // needs awarded value
    await move(o!.id, `stage = 'won', closed_at = now(), awarded_value = 4500000`);
    expect(await rejects(move(o!.id, `title = 'changed'`))).toMatch(/is won and cannot change/);
    await move(o!.id, `project_id = '${T.project}'`); // the one allowed change
  });

  it('needs a reason to lose or decline, and freezes afterwards', async () => {
    const [o] = await newOpp('qualifying');
    expect(await rejects(move(o!.id, `stage = 'no_bid', closed_at = now()`))).toMatch(/check constraint/);
    await move(o!.id, `stage = 'no_bid', closed_at = now(), close_reason = 'CIDB 8 required'`);
    expect(await rejects(move(o!.id, `project_id = '${T.project}'`))).toMatch(/no_bid and cannot change/);
  });

  it('isolates CRM tables between tenants, and hides contacts from the AI engine', async () => {
    for (const table of ['contacts', 'opportunities', 'crm_activities']) {
      expect(await as(app, OTHER.id, (tx) => tx`select 1 from ${tx(table)} where tenant_id = ${T.id}`), table).toHaveLength(0);
    }
    const [{ allowed }] = await owner`select has_table_privilege('constructos_ai', 'contacts', 'select') as allowed`;
    expect(allowed).toBe(false);
  });
});
