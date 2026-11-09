/**
 * Tenant isolation guarantees. These run against a real Postgres (docker compose)
 * and connect as constructos_app — exactly what the API uses in production.
 *
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { createDb, findLogin, withTenant, TenantContextError, type DbHandle } from '../src';
import { projects, tenants, users } from '../src/schema';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;

const run = Date.now().toString(36);
const A = { id: randomUUID(), slug: `iso-a-${run}` };
const B = { id: randomUUID(), slug: `iso-b-${run}` };

let owner: postgres.Sql;
let app: DbHandle;
// Single-connection pool: proves the tenant setting cannot leak between
// transactions that reuse the same physical connection.
let appSingle: DbHandle;
let rawApp: postgres.Sql;

/**
 * Assert a query is rejected by Postgres with a message matching `pattern`.
 * Drizzle wraps driver errors ("Failed query: ...") and keeps the Postgres
 * error in `cause`, so walk the chain and assert on the real database error.
 */
async function expectPgRejection(promise: Promise<unknown>, pattern: RegExp) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the query to be rejected').toBeDefined();
  const messages: string[] = [];
  for (let e = caught as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.message) messages.push(e.message);
  }
  expect(messages.join(' | ')).toMatch(pattern);
}

async function seedTenant(t: { id: string; slug: string }, projectCode: string) {
  await owner.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${t.id}, true)`;
    await tx`insert into tenants (id, slug, name, active_modules)
             values (${t.id}, ${t.slug}, ${'Tenant ' + t.slug}, ${['mod_field']})`;
    await tx`insert into users (tenant_id, email, full_name, password_hash, role)
             values (${t.id}, 'pm@example.test', 'PM', 'not-a-real-hash', 'project_manager')`;
    await tx`insert into projects (tenant_id, code, name)
             values (${t.id}, ${projectCode}, ${'Project ' + projectCode})`;
  });
}

async function dropTenant(t: { id: string }) {
  await owner.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${t.id}, true)`;
    await tx`delete from projects where tenant_id = ${t.id}`;
    await tx`delete from users where tenant_id = ${t.id}`;
    await tx`delete from tenants where id = ${t.id}`;
  });
}

describe.skipIf(!OWNER_URL || !APP_URL)('tenant isolation (RLS)', () => {
  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    await seedTenant(A, 'A-1');
    await seedTenant(B, 'B-1');
    app = createDb(APP_URL!, { max: 4 });
    appSingle = createDb(APP_URL!, { max: 1 });
    rawApp = postgres(APP_URL!, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await Promise.all([app?.close(), appSingle?.close(), rawApp?.end({ timeout: 5 })]);
    if (owner) {
      await dropTenant(A);
      await dropTenant(B);
      await owner.end({ timeout: 5 });
    }
  });

  it('app role is not superuser and cannot bypass RLS', async () => {
    const [role] = await rawApp<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('fails closed with no tenant context: no rows visible', async () => {
    expect(await rawApp`select id from projects`).toHaveLength(0);
    expect(await rawApp`select id from tenants`).toHaveLength(0);
    expect(await rawApp`select id from users`).toHaveLength(0);
  });

  it('fails closed with no tenant context: inserts rejected', async () => {
    await expectPgRejection(
      rawApp`insert into projects (tenant_id, code, name) values (${A.id}, 'X-1', 'x')`,
      /violates row-level security policy/,
    );
  });

  it('each tenant sees only its own rows', async () => {
    const seenByA = await withTenant(app.db, A.id, (tx) => tx.select().from(projects));
    const seenByB = await withTenant(app.db, B.id, (tx) => tx.select().from(projects));
    expect(seenByA.map((p) => p.code)).toEqual(['A-1']);
    expect(seenByB.map((p) => p.code)).toEqual(['B-1']);

    const tenantRows = await withTenant(app.db, A.id, (tx) => tx.select().from(tenants));
    expect(tenantRows.map((t) => t.id)).toEqual([A.id]);
  });

  it('cannot read another tenant even when filtering by its id explicitly', async () => {
    const rows = await withTenant(app.db, A.id, (tx) =>
      tx.select().from(projects).where(eq(projects.tenantId, B.id)),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot insert rows into another tenant (WITH CHECK)', async () => {
    await expectPgRejection(
      withTenant(app.db, A.id, (tx) =>
        tx.insert(projects).values({ tenantId: B.id, code: 'EVIL-1', name: 'planted' }),
      ),
      /violates row-level security policy/,
    );
  });

  it('cannot update or move rows across tenants', async () => {
    const updated = await withTenant(app.db, A.id, (tx) =>
      tx
        .update(projects)
        .set({ name: 'hijacked' })
        .where(eq(projects.tenantId, B.id))
        .returning({ id: projects.id }),
    );
    expect(updated).toHaveLength(0);

    // Moving your own row into another tenant violates WITH CHECK.
    await expectPgRejection(
      withTenant(app.db, A.id, (tx) =>
        tx.update(projects).set({ tenantId: B.id }).where(eq(projects.code, 'A-1')),
      ),
      /violates row-level security policy/,
    );
  });

  it('tenant context does not leak to the next transaction on a pooled connection', async () => {
    await withTenant(appSingle.db, A.id, (tx) => tx.select().from(projects));
    const after = await appSingle.db.select().from(projects);
    expect(after).toHaveLength(0);
  });

  it('cannot switch off row security or assume privileged roles', async () => {
    await expectPgRejection(
      rawApp`set row_security = off; select * from projects`.simple(),
      /would be affected by row-level security policy/,
    );
    await expectPgRejection(rawApp`set role constructos_owner`, /permission denied to set role/);
    await expectPgRejection(rawApp`set role constructos_auth`, /permission denied to set role/);
  });

  it('app role cannot delete users or modify tenants', async () => {
    await expectPgRejection(
      withTenant(app.db, A.id, (tx) => tx.delete(users).where(eq(users.tenantId, A.id))),
      /permission denied for table users/,
    );
    await expectPgRejection(
      withTenant(app.db, A.id, (tx) =>
        tx.update(tenants).set({ activeModules: ['mod_payroll'] }).where(eq(tenants.id, A.id)),
      ),
      /permission denied for table tenants/,
    );
  });

  it('pre-auth lookup works without tenant context and is exact-match only', async () => {
    const login = await findLogin(app.db, A.slug, 'PM@Example.test');
    expect(login).toMatchObject({ tenantId: A.id, role: 'project_manager' });

    expect(await findLogin(app.db, A.slug, 'nobody@example.test')).toBeNull();
    expect(await findLogin(app.db, 'no-such-tenant', 'pm@example.test')).toBeNull();
    // Same email exists in both tenants — the slug decides which one.
    expect((await findLogin(app.db, B.slug, 'pm@example.test'))?.tenantId).toBe(B.id);
  });

  it('auth role table access is not reachable directly by the app', async () => {
    await expect(
      rawApp`select * from users where tenant_id = ${B.id}`,
    ).resolves.toHaveLength(0);
  });

  it('rejects malformed tenant ids before touching the database', async () => {
    await expect(
      withTenant(app.db, "x' or '1'='1", async () => 1),
    ).rejects.toBeInstanceOf(TenantContextError);
  });
});
