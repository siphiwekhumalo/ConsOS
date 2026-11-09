/**
 * Commercial intake guarantees: stage machine and baseline freeze are enforced
 * by the database, as the app role, regardless of what the API does.
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;

const run = Date.now().toString(36);
const T = { id: randomUUID(), slug: `est-a-${run}`, user: randomUUID(), project: randomUUID() };
const OTHER = { id: randomUUID(), slug: `est-b-${run}` };

let owner: postgres.Sql;
let app: postgres.Sql;

async function as<T>(db: postgres.Sql, tenant: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return db.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected rejection');
}

describe.skipIf(!OWNER_URL || !APP_URL)('commercial intake (estimates)', () => {
  let estimate: string;

  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [T, OTHER]) {
      await as(owner, t.id, (tx) => tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`);
    }
    await as(owner, T.id, async (tx) => {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role)
               values (${T.user}, ${T.id}, 'pm@x.test', 'PM', 'x', 'project_manager')`;
    });
    app = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
  });

  it('creates an estimate at intake and accepts editable lines', async () => {
    const [e] = await as(app, T.id, (tx) => tx`
      insert into estimates (tenant_id, ref, title, client_name, created_by)
      values (${T.id}, 'JCE-1', 'Pipe rack insulation', 'Client Co', ${T.user}) returning id, stage`);
    estimate = e!.id;
    expect(e!.stage).toBe('intake');
    await as(app, T.id, (tx) => tx`
      insert into estimate_lines (tenant_id, estimate_id, line_no, description, unit, client_qty, client_rate, internal_qty, internal_rate)
      values (${T.id}, ${estimate}, '1.1', 'Insulate 150NB pipe', 'm', 120, 450, 132, 450)`);
  });

  it('rejects estimates that do not start at intake', async () => {
    expect(
      await rejects(as(app, T.id, (tx) => tx`
        insert into estimates (tenant_id, ref, title, client_name, created_by, stage)
        values (${T.id}, 'JCE-X', 't', 'c', ${T.user}, 'client_approval')`)),
    ).toMatch(/start at intake/);
  });

  it('enforces the stage machine (no skipping to baseline)', async () => {
    expect(
      await rejects(as(app, T.id, (tx) => tx`update estimates set stage = 'client_approval' where id = ${estimate}`)),
    ).toMatch(/invalid estimate transition intake -> client_approval/);
  });

  it('freezes lines once the estimate goes to the client', async () => {
    await as(app, T.id, (tx) => tx`update estimates set stage = 'technical_review' where id = ${estimate}`);
    await as(app, T.id, (tx) => tx`update estimates set stage = 'client_approval' where id = ${estimate}`);
    expect(
      await rejects(as(app, T.id, (tx) => tx`update estimate_lines set internal_qty = 1 where estimate_id = ${estimate}`)),
    ).toMatch(/frozen at stage client_approval/);
    expect(
      await rejects(as(app, T.id, (tx) => tx`delete from estimate_lines where estimate_id = ${estimate}`)),
    ).toMatch(/frozen/);
  });

  it('cannot lock a baseline without a project and client approval reference', async () => {
    expect(
      await rejects(as(app, T.id, (tx) => tx`update estimates set stage = 'baseline_locked', locked_at = now() where id = ${estimate}`)),
    ).toMatch(/check constraint/);
  });

  it('locks the baseline, after which nothing can change', async () => {
    await as(app, T.id, async (tx) => {
      await tx`insert into projects (id, tenant_id, code, name) values (${T.project}, ${T.id}, 'JCE-1', 'Pipe rack insulation')`;
      await tx`update estimates set stage = 'baseline_locked', project_id = ${T.project}, client_approval_ref = 'PO-4500',
                 locked_at = now(), locked_by = ${T.user}, baseline_client_total = 54000, baseline_internal_total = 59400
               where id = ${estimate}`;
    });
    expect(
      await rejects(as(app, T.id, (tx) => tx`update estimates set title = 'changed' where id = ${estimate}`)),
    ).toMatch(/baseline-locked and cannot change/);
    expect(
      await rejects(as(app, T.id, (tx) => tx`update estimates set stage = 'technical_review' where id = ${estimate}`)),
    ).toMatch(/baseline-locked/);
    expect(
      await rejects(as(app, T.id, (tx) => tx`
        insert into estimate_lines (tenant_id, estimate_id, line_no, description, unit) values (${T.id}, ${estimate}, '9', 'sneak', 'ea')`)),
    ).toMatch(/frozen at stage baseline_locked/);
  });

  it('cannot delete estimates and other tenants cannot see them', async () => {
    expect(await rejects(as(app, T.id, (tx) => tx`delete from estimates where id = ${estimate}`))).toMatch(/permission denied/);
    const seen = await as(app, OTHER.id, (tx) => tx`select id from estimates where id = ${estimate}`);
    expect(seen).toHaveLength(0);
  });
});
