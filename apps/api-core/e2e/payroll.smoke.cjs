// End-to-end smoke test of phase 5 (HR & payroll) through the real API.
// Usage: node payroll.smoke.cjs <repoRoot> <apiBase> <ownerDbUrl> <jwtSecret>
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

(async () => {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  const tenant = crypto.randomUUID();
  const users = { owner: crypto.randomUUID(), finance: crypto.randomUUID(), pm: crypto.randomUUID(), foreman: crypto.randomUUID() };
  const roles = { owner: 'owner', finance: 'finance', pm: 'project_manager', foreman: 'site_foreman' };
  const project = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`insert into tenants (id, slug, name, active_modules) values (${tenant}, ${'pay-' + Date.now().toString(36)}, 'Pay', ${['mod_commercial', 'mod_finance', 'mod_payroll']})`;
    for (const k of Object.keys(users)) {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${users[k]}, ${tenant}, ${k + '@pay.test'}, ${k}, 'x', ${roles[k]})`;
    }
    await tx`insert into projects (id, tenant_id, code, name, contract_value) values (${project}, ${tenant}, 'PY-1', 'Pay project', 1000000)`;
  });
  await sql.end();
  for (const k of Object.keys(users)) tokens[k] = jwt({ sub: users[k], tid: tenant, role: roles[k] });

  await call('owner', 'POST', '/finance/setup');
  const ctl = await call('owner', 'POST', `/projects/${project}/cost-codes`, { code: '100', description: 'Site labour', budget: '500000.00' });
  const code = ctl.costCodes[0].id;

  // ---- employees (pay and personal details are payroll-only)
  await call('pm', 'POST', '/payroll/employees', { employeeNo: 'X', firstName: 'x', lastName: 'x', occupation: 'x', employmentType: 'permanent', payBasis: 'monthly', rate: '1.00', startDate: '2025-01-01', private: { dateOfBirth: '1990-01-01', idNumber: '9001015800085' } }, 403);
  const salaried = await call('finance', 'POST', '/payroll/employees', { employeeNo: 'E001', firstName: 'Thandi', lastName: 'Mokoena', occupation: 'Site engineer', employmentType: 'permanent', payBasis: 'monthly', rate: '20000.00', startDate: '2024-03-01', private: { idNumber: '8506155800084', taxNumber: '0123456789', dateOfBirth: '1985-06-15' } });
  const hourly = await call('finance', 'POST', '/payroll/employees', { employeeNo: 'E002', firstName: 'Sipho', lastName: 'Ndlovu', occupation: 'Insulator', employmentType: 'fixed_term', payBasis: 'hourly', rate: '50.00', startDate: '2025-02-03', private: { idNumber: '9504105800081', dateOfBirth: '1995-04-10' } });
  check('finance sees personal details', salaried.private?.idNumber === '8506155800084' && salaried.rate === '20000.00');
  const asForeman = await call('foreman', 'GET', `/payroll/employees/${salaried.id}`);
  check('foreman sees no pay or personal details', asForeman.private === null && asForeman.rate === undefined && asForeman.firstName === 'Thandi');
  const fList = await call('foreman', 'GET', '/payroll/employees');
  check('employee list hides rates from site roles', fList.length === 2 && fList.every((e) => e.rate === undefined));
  await call('pm', 'POST', `/payroll/employees/${hourly.id}/certifications`, { kind: 'Working at heights', issuedOn: '2024-06-01', expiresOn: '2025-06-01' });
  const fList2 = await call('foreman', 'GET', '/payroll/employees');
  check('expired ticket flagged', fList2.find((e) => e.id === hourly.id).expiredCertifications[0] === 'Working at heights');

  // ---- timesheets: November 2025
  const weekdays = ['03', '04', '05', '06', '07', '10', '11', '12', '13', '14', '17', '18', '19', '20', '21', '24', '25', '26', '27', '28'];
  const entries = [
    ...weekdays.map((dd, i) => ({ employeeId: hourly.id, projectId: project, costCodeId: code, workDate: `2025-11-${dd}`, normalHours: '8', overtimeHours: i < 5 ? '2' : '0' })),
    { employeeId: hourly.id, projectId: project, costCodeId: code, workDate: '2025-11-02', sundayHours: '8' },
    ...weekdays.slice(0, 10).map((dd) => ({ employeeId: salaried.id, projectId: project, costCodeId: code, workDate: `2025-11-${dd}`, normalHours: '8' })),
  ];
  const cap = await call('foreman', 'POST', '/payroll/timesheets', { entries });
  check('crew time captured', cap.captured === 31, JSON.stringify(cap));
  await call('foreman', 'POST', '/payroll/timesheets', { entries: [{ employeeId: hourly.id, projectId: project, costCodeId: code, workDate: '2025-11-03', normalHours: '8' }] }, 400); // > 16 h
  const ts = await call('pm', 'GET', '/payroll/timesheets?from=2025-11-01&to=2025-11-30&status=submitted');
  await call('foreman', 'POST', '/payroll/timesheets/approve', { ids: ts.map((t) => t.id) }, 403);
  const appr = await call('pm', 'POST', '/payroll/timesheets/approve', { ids: ts.map((t) => t.id) });
  check('PM approves the crew’s time', appr.approved === 31);

  // ---- unpaid leave
  const lv = await call('foreman', 'POST', '/payroll/leave', { employeeId: salaried.id, kind: 'unpaid', startsOn: '2025-11-27', endsOn: '2025-11-28' });
  check('leave counts working days', lv.days === '2.0', lv.days);
  await call('pm', 'POST', `/payroll/leave/${lv.id}/decide`, { decision: 'approved' });

  // ---- pay run
  await call('finance', 'POST', '/payroll/pay-runs', { period: '2026-11', payDate: '2026-11-25' }, 400);
  let runRes = await call('finance', 'POST', '/payroll/pay-runs', { period: '2025-11', payDate: '2025-11-25' });
  const s1 = runRes.payslips.find((s) => s.employeeId === salaried.id);
  const s2 = runRes.payslips.find((s) => s.employeeId === hourly.id);
  check('salaried payslip (unpaid leave deducted)', s1 && s1.gross === '18153.85' && s1.paye === '1831.44' && s1.uifEmployee === '177.12' && s1.net === '16145.29' && s1.sdl === '181.54', JSON.stringify(s1 && [s1.gross, s1.paye, s1.uifEmployee, s1.net, s1.sdl]));
  check('hourly payslip (normal, overtime, Sunday)', s2 && s2.gross === '9550.00' && s2.paye === '282.75' && s2.net === '9171.75', JSON.stringify(s2 && [s2.gross, s2.paye, s2.net]));
  check('run totals', runRes.grossTotal === '27703.85' && runRes.payeTotal === '2114.19' && runRes.uifTotal === '545.24' && runRes.sdlTotal === '277.04' && runRes.netTotal === '25317.04', JSON.stringify([runRes.grossTotal, runRes.payeTotal, runRes.uifTotal, runRes.sdlTotal, runRes.netTotal]));
  await call('pm', 'GET', `/payroll/pay-runs/${runRes.id}`, undefined, 403);

  // An unapproved entry blocks finalisation.
  await call('foreman', 'POST', '/payroll/timesheets', { entries: [{ employeeId: salaried.id, projectId: project, costCodeId: code, workDate: '2025-11-17', normalHours: '8' }] });
  await call('finance', 'POST', `/payroll/pay-runs/${runRes.id}/finalise`, undefined, 400);
  const pending = await call('pm', 'GET', '/payroll/timesheets?from=2025-11-01&to=2025-11-30&status=submitted');
  await call('pm', 'POST', '/payroll/timesheets/reject', { ids: pending.map((t) => t.id) });

  runRes = await call('finance', 'POST', `/payroll/pay-runs/${runRes.id}/finalise`);
  check('pay run finalised with a journal', runRes.status === 'finalised' && Boolean(runRes.journalId));
  const controls = await call('owner', 'GET', `/projects/${project}/controls`);
  check('labour cost (incl. UIF and SDL) charged to the project', controls.summary.costToDate === '28253.51' && controls.costs.every((c) => c.category === 'labour' && c.source === 'payroll'), controls.summary.costToDate);
  const tb = await call('owner', 'GET', '/finance/reports/trial-balance?asAt=2025-12-31');
  const row = (c) => tb.rows.find((r) => r.code === c);
  check('payroll journal: labour Dr, PAYE/UIF/SDL and net wages Cr', tb.balanced && row('5000')?.debit === '28253.51' && row('2200')?.credit === '2936.47' && row('2250')?.credit === '25317.04', JSON.stringify([row('5000'), row('2200'), row('2250')]));
  await call('owner', 'POST', `/finance/journals/${runRes.journalId}/reverse`, { reason: 'try' }, 400);

  // ---- frozen month, EMP201
  await call('foreman', 'POST', '/payroll/timesheets', { entries: [{ employeeId: hourly.id, projectId: project, costCodeId: code, workDate: '2025-11-29', normalHours: '4' }] }, 409);
  const emp = await call('finance', 'GET', `/payroll/pay-runs/${runRes.id}/emp201`);
  check('EMP201 working paper', emp.total === '2936.47' && emp.dueOn === '2025-12-07', JSON.stringify([emp.total, emp.dueOn]));
  const bal = await call('pm', 'GET', `/payroll/employees/${salaried.id}`);
  check('leave balances shown', bal.leaveBalances.find((b) => b.kind === 'annual') !== undefined);

  console.log(failures === 0 ? '\nALL PAYROLL SMOKE CHECKS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
