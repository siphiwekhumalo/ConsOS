// End-to-end smoke test of phase 4 (plant, HSE, quality) through the real API.
// Usage: node operations.smoke.cjs <repoRoot> <apiBase> <ownerDbUrl> <jwtSecret>
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const [repo, base, ownerUrl, secret] = process.argv.slice(2);
const postgres = createRequire(`${repo}/packages/db/package.json`)('postgres');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ ...claims, iss: 'constructos', iat: now, exp: now + 900 });
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
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

(async () => {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const tenant = crypto.randomUUID();
  const users = { owner: crypto.randomUUID(), pm: crypto.randomUUID(), pm2: crypto.randomUUID(), foreman: crypto.randomUUID(), viewer: crypto.randomUUID() };
  const roles = { owner: 'owner', pm: 'project_manager', pm2: 'project_manager', foreman: 'site_foreman', viewer: 'viewer' };
  const project = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`insert into tenants (id, slug, name, active_modules) values (${tenant}, ${'ops-' + Date.now().toString(36)}, 'Ops', ${['mod_commercial', 'mod_finance', 'mod_fleet', 'mod_hse']})`;
    for (const k of Object.keys(users)) {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${users[k]}, ${tenant}, ${k + '@ops.test'}, ${k}, 'x', ${roles[k]})`;
    }
    await tx`insert into projects (id, tenant_id, code, name, contract_value) values (${project}, ${tenant}, 'OP-1', 'Ops project', 2000000)`;
    // 20 diary days × 40 people → 800 shifts → 7 200 man-hours at 9 h.
    for (let i = 1; i <= 20; i++) {
      await tx`insert into site_diary_entries (id, tenant_id, project_id, entry_date, workforce_count, created_by) values (${crypto.randomUUID()}, ${tenant}, ${project}, ${daysAgo(i)}, 40, ${users.foreman})`;
    }
  });
  await sql.end();
  for (const k of Object.keys(users)) tokens[k] = jwt({ sub: users[k], tid: tenant, role: roles[k] });

  const controls = await call('owner', 'POST', `/projects/${project}/cost-codes`, { code: '400', description: 'Plant', budget: '200000.00' });
  const code = controls.costCodes[0].id;

  // ---- plant register, allocation, meter
  await call('foreman', 'POST', '/plant/assets', { assetNo: 'EX-01', name: 'x', category: 'earthmoving' }, 403);
  let asset = await call('pm', 'POST', '/plant/assets', { assetNo: 'EX-01', name: '20t excavator', category: 'earthmoving', meterUnit: 'hours', rateUnit: 'day', chargeRate: '4500.00', licenceExpiry: daysAgo(3) });
  check('asset created with expired licence flagged', asset.compliance?.[0]?.status === 'expired', JSON.stringify(asset.compliance));
  asset = await call('foreman', 'POST', `/plant/assets/${asset.id}/move`, { projectId: project, movedOn: daysAgo(5) });
  check('foreman sends plant to site', asset.status === 'on_site' && asset.project?.code === 'OP-1');
  asset = await call('foreman', 'POST', `/plant/assets/${asset.id}/meter`, { readOn: daysAgo(2), reading: '1240.0' });
  await call('foreman', 'POST', `/plant/assets/${asset.id}/meter`, { readOn: today, reading: '1239.0' }, 400);
  check('meter reading recorded', asset.meterReading === '1240.0', asset.meterReading);

  // ---- usage charged to the project
  const codes = await call('foreman', 'GET', `/plant/projects/${project}/cost-codes`);
  check('foreman reads cost codes (no budgets)', codes.length === 1 && codes[0].budget === undefined);
  asset = await call('foreman', 'POST', `/plant/assets/${asset.id}/usage`, { projectId: project, costCodeId: code, usedOn: daysAgo(1), quantity: '1', operatorName: 'S. Dlamini' });
  await call('foreman', 'POST', `/plant/assets/${asset.id}/usage`, { projectId: project, costCodeId: code, usedOn: daysAgo(1), quantity: '1' }, 400);
  let ctl = await call('owner', 'GET', `/projects/${project}/controls`);
  check('plant usage reaches project CVR', ctl.summary.costToDate === '4500.00' && ctl.costs[0].category === 'plant' && ctl.costs[0].source === 'plant', JSON.stringify([ctl.summary.costToDate, ctl.costs[0]?.source]));

  // ---- maintenance plan and breakdown
  asset = await call('pm', 'POST', `/plant/assets/${asset.id}/plans`, { description: '250-hour service', intervalMeter: '250.0', lastDoneMeter: '1000.0' });
  check('service due soon by hours', asset.plans[0].due.status === 'due_soon' && asset.plans[0].due.meterRemaining === '10.0', JSON.stringify(asset.plans[0].due));
  const list = await call('foreman', 'GET', '/plant/assets');
  check('register shows maintenance and utilisation', list[0].maintenance === 'due_soon' && list[0].utilisation30d === '3.3', JSON.stringify([list[0].maintenance, list[0].utilisation30d]));
  asset = await call('foreman', 'POST', `/plant/assets/${asset.id}/work-orders`, { kind: 'breakdown', description: 'Hydraulic hose burst', reportedOn: today, planId: asset.plans[0].id });
  check('breakdown takes the asset off site', asset.status === 'broken_down' && asset.currentProjectId === null);
  await call('foreman', 'POST', `/plant/assets/${asset.id}/move`, { projectId: project, movedOn: today }, 400);
  const wo = asset.workOrders[0];
  asset = await call('foreman', 'POST', `/plant/work-orders/${wo.id}/start`);
  asset = await call('foreman', 'POST', `/plant/work-orders/${wo.id}/complete`, { completedOn: today, workDone: 'Replaced hose; did 250h service', meterAtCompletion: '1262.0', labourCost: '1800.00', partsCost: '3400.00', downtimeHours: '6' });
  check('repair returns asset, resets plan, records cost', asset.status === 'available' && asset.plans[0].due.status === 'ok' && asset.plans[0].lastDoneMeter === '1262.0' && asset.totals.maintenanceCost === '5200.00', JSON.stringify([asset.status, asset.plans[0].due.status, asset.totals]));

  // ---- incidents
  await call('viewer', 'POST', '/hse/incidents', { occurredAt: new Date().toISOString(), type: 'near_miss', title: 'x', description: 'x' }, 403);
  let inc = await call('foreman', 'POST', '/hse/incidents', { projectId: project, occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), type: 'injury', severity: 'lost_time', daysLost: 16, title: 'Fall from scaffold', description: 'Worker fell 2m from an incomplete scaffold bay.', injuredPerson: 'T. Mokoena', location: 'Pipe rack B' });
  check('reportability flagged (OHSA s24 + COIDA)', inc.dolReportable === true && inc.coidaReportable === true && inc.number === 'INC-0001', JSON.stringify([inc.dolReportable, inc.coidaReportable]));
  await call('foreman', 'POST', '/hse/incidents', { projectId: project, occurredAt: new Date().toISOString(), type: 'near_miss', title: 'Dropped spanner', description: 'Spanner fell from height, nobody below.' });
  await call('foreman', 'POST', `/hse/incidents/${inc.id}/transition`, { to: 'investigating' });
  await call('pm', 'POST', `/hse/incidents/${inc.id}/transition`, { to: 'closed' }, 400); // no root cause
  inc = await call('pm', 'PATCH', `/hse/incidents/${inc.id}`, { rootCause: 'Scaffold handed over without inspection tag', immediateCause: 'Missing guardrail' });
  await call('foreman', 'POST', `/hse/incidents/${inc.id}/transition`, { to: 'closed' }, 403);
  await call('pm', 'POST', `/hse/incidents/${inc.id}/transition`, { to: 'closed' }, 400); // no corrective action
  const act = await call('pm', 'POST', '/hse/actions', { sourceType: 'incident', sourceId: inc.id, action: 'Scaff-tag system with daily inspection', ownerName: 'Scaffold supervisor', dueOn: today });
  await call('pm', 'POST', `/hse/incidents/${inc.id}/transition`, { to: 'closed' }, 400); // action still open
  await call('foreman', 'POST', `/hse/actions/${act.id}/complete`, { completedOn: today, note: 'Tags issued' });
  await call('pm', 'POST', `/hse/incidents/${inc.id}/reported`, { authority: 'dol', reportedOn: today });
  await call('pm', 'POST', `/hse/incidents/${inc.id}/reported`, { authority: 'coida', reportedOn: today });
  inc = await call('pm', 'POST', `/hse/incidents/${inc.id}/transition`, { to: 'closed' });
  check('incident closed after investigation', inc.status === 'closed' && inc.dolReportedOn === today);
  await call('pm', 'PATCH', `/hse/incidents/${inc.id}`, { daysLost: 1 }, 409);

  // ---- inspection → NCR
  const ins = await call('foreman', 'POST', '/hse/inspections', { projectId: project, kind: 'quality', title: 'Lagging QC', inspectedOn: today, items: [{ item: 'Joints sealed', result: 'fail', note: 'Gaps at bends' }, { item: 'Cladding overlap 50mm', result: 'pass' }, { item: 'Labels', result: 'na' }] });
  check('inspection outcome computed', ins.passed === false && ins.failedItems === 1, JSON.stringify([ins.passed, ins.failedItems]));
  let ncr = await call('foreman', 'POST', '/hse/ncrs', { projectId: project, inspectionId: ins.id, title: 'Unsealed lagging joints', description: 'Bends on line 4 not sealed', category: 'workmanship', severity: 'major', raisedOn: today, dueOn: daysAgo(-7) });
  await call('foreman', 'POST', `/hse/ncrs/${ncr.id}/transition`, { to: 'action_proposed' }, 400);
  ncr = await call('foreman', 'PATCH', `/hse/ncrs/${ncr.id}`, { correctiveAction: 'Re-seal all bends; add QC hold point', reworkCost: '3800.00' });
  ncr = await call('foreman', 'POST', `/hse/ncrs/${ncr.id}/transition`, { to: 'action_proposed' });
  await call('pm', 'POST', `/hse/ncrs/${ncr.id}/transition`, { to: 'closed' }, 400); // no root cause
  ncr = await call('pm', 'PATCH', `/hse/ncrs/${ncr.id}`, { rootCause: 'No hold point before cladding' });
  await call('foreman', 'POST', `/hse/ncrs/${ncr.id}/transition`, { to: 'closed' }, 403);
  ncr = await call('pm', 'POST', `/hse/ncrs/${ncr.id}/transition`, { to: 'closed' });
  check('NCR verified and closed by someone else', ncr.status === 'closed' && ncr.verifiedBy === users.pm);

  // ---- KPIs
  const k = await call('viewer', 'GET', `/hse/kpis?projectId=${project}`);
  check('LTIFR / TRIFR from diary man-hours', k.manHours === 7200 && k.lostTimeInjuries === 1 && k.ltifr === '138.89' && k.nearMisses === 1 && k.daysSinceLastLti === 3, JSON.stringify([k.manHours, k.ltifr, k.trifr, k.daysSinceLastLti]));
  check('open items', k.openNcrs === 0 && k.openActions === 0 && k.unreported === 0, JSON.stringify([k.openNcrs, k.openActions, k.unreported]));

  console.log(failures === 0 ? '\nALL OPERATIONS SMOKE CHECKS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
