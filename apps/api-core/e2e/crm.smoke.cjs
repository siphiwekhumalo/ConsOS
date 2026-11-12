// End-to-end smoke test of phase 6 (CRM & tenders) through the real API.
// Usage: node crm.smoke.cjs <repoRoot> <apiBase> <ownerDbUrl> <jwtSecret>
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const [repo, base, ownerUrl, secret] = process.argv.slice(2);
const postgres = createRequire(`${repo}/packages/db/package.json`)('postgres');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ ...claims, iss: 'constructos', iat: now, exp: now + 900, sat: now });
  return `${head}.${body}.${crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

let failures = 0;
const tokens = {};
async function call(who, method, path, body, expectStatus) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  const ok = expectStatus ? res.status === expectStatus : res.ok;
  if (!ok) {
    failures++;
    console.log(`FAIL ${who} ${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  }
  return json;
}
function check(label, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` ${detail}`}`);
}
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString();
const day = (n) => inDays(n).slice(0, 10);

(async () => {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const tenant = crypto.randomUUID();
  const users = { owner: crypto.randomUUID(), pm: crypto.randomUUID(), finance: crypto.randomUUID(), foreman: crypto.randomUUID() };
  const roles = { owner: 'owner', pm: 'project_manager', finance: 'finance', foreman: 'site_foreman' };
  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`insert into tenants (id, slug, name, active_modules) values (${tenant}, ${'crm-' + Date.now().toString(36)}, 'CRM', ${['mod_commercial', 'mod_crm']})`;
    for (const k of Object.keys(users)) {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${users[k]}, ${tenant}, ${k + '@crm.test'}, ${k}, 'x', ${roles[k]})`;
    }
  });
  await sql.end();
  for (const k of Object.keys(users)) tokens[k] = jwt({ sub: users[k], tid: tenant, role: roles[k] });

  // ---- clients and contacts
  await call('foreman', 'GET', '/crm/accounts', undefined, 403);
  let acc = await call('pm', 'POST', '/crm/accounts', { name: 'Sasol Secunda', sector: 'petrochemical', province: 'MP' });
  acc = await call('pm', 'POST', `/crm/accounts/${acc.id}/contacts`, { fullName: 'Lerato Khumalo', jobTitle: 'Contracts manager', email: 'lerato@example.com', isPrimary: true });
  acc = await call('pm', 'POST', `/crm/accounts/${acc.id}/contacts`, { fullName: 'Pieter Botha', jobTitle: 'Engineer', isPrimary: true });
  check('client with one primary contact', acc.contacts.length === 2 && acc.contacts.filter((c) => c.isPrimary).length === 1 && acc.contacts[0].fullName === 'Pieter Botha' && acc.accountManagerName === 'pm');

  // ---- opportunity 1: tender, priced in Commercial Intake, won
  let o1 = await call('pm', 'POST', '/crm/opportunities', { customerId: acc.id, title: 'Unit 4 boiler re-lagging', tenderRef: 'SSE-2026-118', estimatedValue: '2000000.00', briefingOn: inDays(1), closingAt: inDays(5), cidbGradeRequired: '7ce', source: 'etender_portal' });
  check('opportunity created as a lead at 10%', o1.number === 'OPP-0001' && o1.stage === 'lead' && o1.probability === 10 && o1.cidbGradeRequired === '7CE');
  await call('pm', 'POST', `/crm/opportunities/${o1.id}/estimate`, undefined, 400); // must be qualified first
  o1 = await call('pm', 'POST', `/crm/opportunities/${o1.id}/transition`, { to: 'qualifying' });
  o1 = await call('pm', 'POST', `/crm/opportunities/${o1.id}/estimate`);
  check('pricing starts an estimate and moves to tendering', o1.stage === 'tendering' && o1.estimate?.ref === 'SSE-2026-118' && o1.probability === 40);
  const est = o1.estimate.id;
  await call('pm', 'POST', `/estimates/${est}/lines`, { lineNo: '1', description: 'Re-lag boiler casing', unit: 'm2', clientQty: '400', clientRate: '5000.00', internalQty: '400', internalRate: '5000.00' });
  await call('pm', 'POST', `/estimates/${est}/transition`, { to: 'technical_review' });
  await call('finance', 'POST', `/estimates/${est}/transition`, { to: 'client_approval' });
  o1 = await call('pm', 'POST', `/crm/opportunities/${o1.id}/transition`, { to: 'submitted' });
  await call('owner', 'POST', `/estimates/${est}/transition`, { to: 'baseline_locked', clientApprovalRef: 'PO-450011' });
  await call('pm', 'POST', `/crm/opportunities/${o1.id}/transition`, { to: 'won' }); // awarded value defaults to the estimate
  o1 = await call('pm', 'GET', `/crm/opportunities/${o1.id}`);
  check('won tender links the project created by the baseline lock', o1.stage === 'won' && o1.awardedValue === '2000000.00' && o1.project?.code === 'SSE-2026-118', JSON.stringify([o1.stage, o1.awardedValue, o1.project]));
  await call('pm', 'PATCH', `/crm/opportunities/${o1.id}`, { title: 'x' }, 409);

  // ---- opportunity 2: lost
  let o2 = await call('pm', 'POST', '/crm/opportunities', { customerId: acc.id, title: 'Tank farm cladding', stage: 'qualifying', estimatedValue: '1000000.00' });
  await call('pm', 'POST', `/crm/opportunities/${o2.id}/transition`, { to: 'tendering' });
  await call('pm', 'POST', `/crm/opportunities/${o2.id}/transition`, { to: 'submitted' });
  await call('pm', 'POST', `/crm/opportunities/${o2.id}/transition`, { to: 'lost' }, 400);
  o2 = await call('pm', 'POST', `/crm/opportunities/${o2.id}/transition`, { to: 'lost', closeReason: 'Price 8% above the winner', competitor: 'Competitor X' });
  check('lost with reason and competitor', o2.stage === 'lost' && o2.competitor === 'Competitor X');

  // ---- opportunity 3: open, closing soon
  await call('pm', 'POST', '/crm/opportunities', { customerId: acc.id, title: 'Steam line insulation', estimatedValue: '500000.00', closingAt: inDays(3) });

  // ---- activities and follow-ups
  await call('pm', 'POST', '/crm/activities', { customerId: acc.id, kind: 'meeting', occurredOn: day(1), summary: 'future' }, 400);
  const act = await call('pm', 'POST', '/crm/activities', { customerId: acc.id, opportunityId: o2.id, kind: 'call', occurredOn: day(-3), summary: 'Debrief on lost tender', nextStep: 'Send revised rates', followUpOn: day(-1) });

  let dash = await call('finance', 'GET', '/crm/dashboard');
  check('pipeline: open value and weighted value', dash.pipeline.openCount === 1 && dash.pipeline.openValue === '500000.00' && dash.pipeline.weightedValue === '50000.00', JSON.stringify(dash.pipeline));
  check('win rate by number and value', dash.winRate.won === 1 && dash.winRate.lost === 1 && dash.winRate.byCount === '50.0' && dash.winRate.byValue === '66.7', JSON.stringify(dash.winRate));
  check('closing date flagged', dash.deadlines.length === 1 && dash.deadlines[0].kind === 'closing' && dash.deadlines[0].opportunity.title === 'Steam line insulation', JSON.stringify(dash.deadlines.map((d) => [d.kind, d.opportunity.title])));
  check('overdue follow-up shown', dash.followUps.length === 1 && dash.followUps[0].overdue === true);
  await call('pm', 'POST', `/crm/activities/${act.id}/done`);
  dash = await call('finance', 'GET', '/crm/dashboard');
  check('done follow-up cleared', dash.followUps.length === 0);

  const list = await call('pm', 'GET', '/crm/accounts');
  check('account list shows open pipeline and last activity', list[0].openOpportunities === 1 && list[0].openValue === '500000.00' && list[0].lastActivity === day(-3), JSON.stringify(list[0]));

  console.log(failures === 0 ? '\nALL CRM SMOKE CHECKS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
