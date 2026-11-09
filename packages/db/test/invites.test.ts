/**
 * Invitation guarantees: tokens are stored only as hashes, are single-use,
 * expire, are found without a tenant context only through auth_find_invite,
 * and stay tenant-isolated. Invited users cannot log in.
 * Required env: DATABASE_URL_OWNER, DATABASE_URL_APP
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { createDb, createInvite, findInvite, findLogin, hashInviteToken, withTenant, type DbHandle } from '../src';

const OWNER_URL = process.env.DATABASE_URL_OWNER;
const APP_URL = process.env.DATABASE_URL_APP;
const run = Date.now().toString(36);
const A = { id: randomUUID(), slug: `inv-a-${run}`, admin: randomUUID(), invitee: randomUUID() };
const B = { id: randomUUID(), slug: `inv-b-${run}` };

let owner: postgres.Sql;
let app: DbHandle;

describe.skipIf(!OWNER_URL || !APP_URL)('user invitations', () => {
  beforeAll(async () => {
    await migrate(OWNER_URL!, () => {});
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    for (const t of [A, B]) {
      await owner.begin(async (tx) => {
        await tx`select set_config('app.current_tenant', ${t.id}, true)`;
        await tx`insert into tenants (id, slug, name) values (${t.id}, ${t.slug}, ${t.slug})`;
      });
    }
    await owner.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${A.id}, true)`;
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role)
               values (${A.admin}, ${A.id}, 'admin@x.test', 'Admin', 'x', 'admin')`;
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role, is_active)
               values (${A.invitee}, ${A.id}, 'new@x.test', 'New Person', null, 'site_foreman', false)`;
    });
    app = createDb(APP_URL!, { max: 2 });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.end({ timeout: 5 });
  });

  it('stores only the hash, and the raw token finds the invite without a tenant context', async () => {
    const { token } = await withTenant(app.db, A.id, (tx) =>
      createInvite(tx, { tenantId: A.id, userId: A.invitee, purpose: 'invite', createdBy: A.admin }),
    );
    const stored = await withTenant(app.db, A.id, (tx) =>
      tx.execute<{ token_hash: Buffer }>(sql`select token_hash from user_invites where user_id = ${A.invitee} and used_at is null`),
    );
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0]!.token_hash).equals(hashInviteToken(token))).toBe(true);
    expect(Buffer.from(stored[0]!.token_hash).toString('utf8')).not.toContain(token);

    const found = await findInvite(app.db, token);
    expect(found).toMatchObject({ tenantId: A.id, userId: A.invitee, email: 'new@x.test', tenantSlug: A.slug, purpose: 'invite' });
    expect(await findInvite(app.db, `${token.slice(0, -2)}xx`)).toBeNull();
    expect(await findInvite(app.db, 'not a token')).toBeNull();
  });

  it('issuing a new invite spends the previous one', async () => {
    const first = await withTenant(app.db, A.id, (tx) =>
      createInvite(tx, { tenantId: A.id, userId: A.invitee, purpose: 'invite', createdBy: A.admin }),
    );
    const second = await withTenant(app.db, A.id, (tx) =>
      createInvite(tx, { tenantId: A.id, userId: A.invitee, purpose: 'reset', createdBy: A.admin }),
    );
    expect(await findInvite(app.db, first.token)).toBeNull();
    expect((await findInvite(app.db, second.token))?.purpose).toBe('reset');
  });

  it('expired invites are not found', async () => {
    const { token } = await withTenant(app.db, A.id, (tx) =>
      createInvite(tx, { tenantId: A.id, userId: A.invitee, purpose: 'invite', createdBy: A.admin }),
    );
    await owner.begin(async (tx) => {
      await tx`select set_config('app.current_tenant', ${A.id}, true)`;
      await tx`update user_invites set expires_at = now() - interval '1 minute' where token_hash = ${hashInviteToken(token)}`;
    });
    expect(await findInvite(app.db, token)).toBeNull();
  });

  it('invited users without a password cannot log in', async () => {
    expect(await findLogin(app.db, A.slug, 'new@x.test')).toBeNull(); // inactive until accepted
  });

  it('invites are tenant-isolated and invisible without a tenant context', async () => {
    const none = await app.db.execute(sql`select id from user_invites`);
    expect(none).toHaveLength(0);
    const fromB = await withTenant(app.db, B.id, (tx) => tx.execute(sql`select id from user_invites where user_id = ${A.invitee}`));
    expect(fromB).toHaveLength(0);
    // Tenant B cannot create an invite for tenant A's user.
    await expect(
      withTenant(app.db, B.id, (tx) => createInvite(tx, { tenantId: A.id, userId: A.invitee, purpose: 'invite', createdBy: null })),
    ).rejects.toThrow();
  });

  it('the app role cannot delete invites', async () => {
    await expect(withTenant(app.db, A.id, (tx) => tx.execute(sql`delete from user_invites`))).rejects.toThrow();
  });
});
