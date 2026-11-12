// End-to-end check of session refresh rules through the real API.
// Usage: node auth.smoke.cjs <repoRoot> <apiBase> <ownerDbUrl> <jwtSecret>
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const [repo, base, ownerUrl, secret] = process.argv.slice(2);
const postgres = createRequire(`${repo}/packages/db/package.json`)('postgres');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token as the API issues it; `iat`/`exp`/`sat` overridable to simulate time passing. */
function jwt(claims, { iat, exp } = {}) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss: 'constructos', iat: iat ?? now, exp: exp ?? now + 900, ...claims });
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());

let failures = 0;
async function call(token, method, path, expectStatus) {
  const res = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  const json = await res.json().catch(() => ({}));
  if (expectStatus && res.status !== expectStatus) {
    failures++;
    console.log(`FAIL ${method} ${path} -> ${res.status} (expected ${expectStatus}) ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { status: res.status, json };
}
function check(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${detail}`}`);
}

(async () => {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const tenant = crypto.randomUUID();
  const user = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`insert into tenants (id, slug, name) values (${tenant}, ${'auth-' + Date.now().toString(36)}, 'Auth')`;
    await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${user}, ${tenant}, 'pm@auth.test', 'PM', 'x', 'project_manager')`;
  });
  const now = Math.floor(Date.now() / 1000);

  const fresh = jwt({ sub: user, tid: tenant, role: 'project_manager', sat: now - 3600 });
  const r1 = await call(fresh, 'POST', '/auth/refresh', 200);
  const t1 = decode(r1.json.accessToken);
  check('refresh issues a new token and keeps the sign-in time', t1.sat === now - 3600 && t1.exp > now + 800, JSON.stringify(t1));
  await call(r1.json.accessToken, 'GET', '/me', 200);

  const old = jwt({ sub: user, tid: tenant, role: 'project_manager', sat: now - 13 * 3600 });
  const r2 = await call(old, 'POST', '/auth/refresh', 401);
  check('sessions cannot be extended past 12 hours', /time limit/.test(r2.json.message ?? ''), r2.json.message);

  const legacy = jwt({ sub: user, tid: tenant, role: 'project_manager' }, { iat: now - 60 });
  await call(legacy, 'POST', '/auth/refresh', 200); // tokens issued before this change fall back to iat

  const expired = jwt({ sub: user, tid: tenant, role: 'project_manager', sat: now - 1000 }, { iat: now - 1000, exp: now - 100 });
  await call(expired, 'POST', '/auth/refresh', 401);
  await call(expired, 'GET', '/me', 401);

  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`update users set role = 'viewer' where id = ${user}`;
  });
  const r3 = await call(fresh, 'POST', '/auth/refresh', 200);
  check('a role change applies at the next refresh', decode(r3.json.accessToken).role === 'viewer');

  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`update users set is_active = false where id = ${user}`;
  });
  const r4 = await call(fresh, 'POST', '/auth/refresh', 401);
  check('a deactivated user cannot refresh', /no longer active/.test(r4.json.message ?? ''), r4.json.message);
  await sql.end();

  console.log(failures === 0 ? '\nALL AUTH SMOKE CHECKS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
