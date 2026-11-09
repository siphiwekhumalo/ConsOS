/**
 * Least-privilege guarantees for the sync and AI service roles.
 * Required env: DATABASE_URL_OWNER (roles get dev logins via `pnpm db:dev-roles`).
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';

const OWNER_URL = process.env.DATABASE_URL_OWNER;

function roleUrl(role: string, password: string) {
  const u = new URL(OWNER_URL!);
  u.username = role;
  u.password = password;
  return u.toString();
}

async function errorText(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected rejection');
}

const run = Date.now().toString(36);
const A = { id: randomUUID(), slug: `svc-a-${run}`, user: randomUUID(), project: randomUUID() };
const B = { id: randomUUID(), slug: `svc-b-${run}`, user: randomUUID(), project: randomUUID() };

let owner: postgres.Sql;
let syncDb: postgres.Sql;
let aiDb: postgres.Sql;

async function asTenant<T>(db: postgres.Sql, tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
  return db.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

describe.skipIf(!OWNER_URL)('service roles', () => {
  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const [role, pw] of [['constructos_sync', 'sync_local_dev'], ['constructos_ai', 'ai_local_dev']]) {
      await owner.unsafe(`ALTER ROLE ${role} LOGIN PASSWORD '${pw}'`);
    }
    for (const t of [A, B]) {
      await asTenant(owner, t.id, async (tx) => {
        await tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`;
        await tx`insert into users (id, tenant_id, email, full_name, password_hash, role)
                 values (${t.user}, ${t.id}, 'f@example.test', 'Foreman', 'x', 'site_foreman')`;
        await tx`insert into projects (id, tenant_id, code, name) values (${t.project}, ${t.id}, 'P-1', 'P')`;
      });
    }
    syncDb = postgres(roleUrl('constructos_sync', 'sync_local_dev'), { max: 1, onnotice: () => {} });
    aiDb = postgres(roleUrl('constructos_ai', 'ai_local_dev'), { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await Promise.all([syncDb?.end({ timeout: 5 }), aiDb?.end({ timeout: 5 })]);
    await owner?.end({ timeout: 5 });
  });

  it('sync role writes diary entries for its tenant and gets a change sequence', async () => {
    const id = randomUUID();
    const [row] = await asTenant(syncDb, A.id, (tx) => tx`
      insert into site_diary_entries (id, tenant_id, project_id, entry_date, created_by, work_completed)
      values (${id}, ${A.id}, ${A.project}, current_date, ${A.user}, 'Poured slab level 2')
      returning version, change_seq`);
    expect(row!.version).toBe(1);
    expect(Number(row!.change_seq)).toBeGreaterThan(0);

    const [updated] = await asTenant(syncDb, A.id, (tx) => tx`
      update site_diary_entries set delays = 'Rain 2h' where id = ${id} returning version, change_seq`);
    expect(updated!.version).toBe(2);
    expect(Number(updated!.change_seq)).toBeGreaterThan(Number(row!.change_seq));
  });

  it("sync role cannot attach a diary entry to another tenant's project", async () => {
    const msg = await errorText(asTenant(syncDb, A.id, (tx) => tx`
      insert into site_diary_entries (id, tenant_id, project_id, entry_date, created_by)
      values (${randomUUID()}, ${A.id}, ${B.project}, current_date, ${A.user})`));
    expect(msg).toMatch(/foreign key/);
  });

  it('sync role cannot read users, files or modify projects', async () => {
    expect(await errorText(asTenant(syncDb, A.id, (tx) => tx`select * from users`))).toMatch(/permission denied/);
    expect(await errorText(asTenant(syncDb, A.id, (tx) => tx`select * from files`))).toMatch(/permission denied/);
    expect(
      await errorText(asTenant(syncDb, A.id, (tx) => tx`update projects set name = 'x'`)),
    ).toMatch(/permission denied/);
  });

  it('AI role is read-only on business data', async () => {
    const rows = await asTenant(aiDb, A.id, (tx) => tx`select id from projects`);
    expect(rows.map((r) => r.id)).toEqual([A.project]);
    expect(
      await errorText(asTenant(aiDb, A.id, (tx) => tx`update site_diary_entries set delays = 'x'`)),
    ).toMatch(/permission denied/);
    expect(
      await errorText(asTenant(aiDb, A.id, (tx) => tx`insert into projects (tenant_id, code, name) values (${A.id}, 'X', 'X')`)),
    ).toMatch(/permission denied/);
    expect(await errorText(asTenant(aiDb, A.id, (tx) => tx`select * from users`))).toMatch(/permission denied/);
  });

  it('AI role can record jobs only within its tenant', async () => {
    const [job] = await asTenant(aiDb, A.id, (tx) => tx`
      insert into ai_jobs (tenant_id, kind, requested_by) values (${A.id}, 'boq_extraction', ${A.user})
      returning id, status`);
    expect(job!.status).toBe('queued');
    const crossTenant = await asTenant(aiDb, B.id, (tx) => tx`select id from ai_jobs where id = ${job!.id}`);
    expect(crossTenant).toHaveLength(0);
    expect(
      await errorText(asTenant(aiDb, A.id, (tx) => tx`
        insert into ai_jobs (tenant_id, kind, requested_by) values (${B.id}, 'boq_extraction', ${B.user})`)),
    ).toMatch(/row-level security/);
  });
});
