// End-to-end smoke test of phase 2 (finance) through the real API.
// Usage: node smoke-finance.cjs <repoRoot> <apiBase> <ownerDbUrl> <jwtSecret>
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const [repo, base, ownerUrl, secret] = process.argv.slice(2);
const req = createRequire(`${repo}/packages/db/package.json`);
const postgres = req('postgres');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ ...claims, iss: 'constructos', iat: now, exp: now + 900 });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

let token;
let failures = 0;
async function call(method, path, body, expectStatus) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  const ok = expectStatus ? res.status === expectStatus : res.ok;
  if (!ok) {
    failures++;
    console.log(`FAIL ${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
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
  const user = crypto.randomUUID();
  const project = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`insert into tenants (id, slug, name, active_modules) values (${tenant}, ${'smoke-' + Date.now().toString(36)}, 'Smoke', ${['mod_commercial', 'mod_finance']})`;
    await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${user}, ${tenant}, 'owner@smoke.test', 'Owner', 'x', 'owner')`;
    await tx`insert into projects (id, tenant_id, code, name, contract_value) values (${project}, ${tenant}, 'SM-1', 'Smoke project', 1000000)`;
  });
  await sql.end();
  token = jwt({ sub: user, tid: tenant, role: 'owner' });

  // ---- setup
  const before = await call('GET', '/finance/settings');
  check('settings: not set up', before.setUp === false);
  await call('POST', '/finance/setup');
  await call('POST', '/finance/setup', undefined, 409);
  const accounts = await call('GET', '/finance/accounts');
  const acc = (code) => accounts.find((a) => a.code === code);
  check('default chart created', accounts.length >= 30 && acc('1000').isBank);

  // ---- project budget
  let controls = await call('POST', `/projects/${project}/cost-codes`, { code: '100', description: 'Materials', budget: '400000.00' });
  const code = controls.costCodes[0].id;

  // ---- AP: supplier invoice with a project line and an overhead line
  const supplier = await call('POST', '/finance/suppliers', { name: 'Lagging Supplies', paymentTermsDays: 30 });
  let si = await call('POST', '/finance/supplier-invoices', {
    supplierId: supplier.id, invoiceNo: 'LS-1', invoiceDate: '2026-11-02',
    lines: [
      { description: 'Mineral wool', amount: '10000.00', vatRate: '15', projectId: project, costCodeId: code, category: 'material' },
      { description: 'Courier', amount: '500.00', vatRate: '15', accountId: acc('6400').id },
    ],
  });
  check('AP draft totals', si.subtotal === '10500.00' && si.vatTotal === '1575.00' && si.total === '12075.00', JSON.stringify([si.subtotal, si.vatTotal, si.total]));
  si = await call('POST', `/finance/supplier-invoices/${si.id}/approve`);
  check('AP approved with journal', si.status === 'approved' && si.journalId);
  controls = await call('GET', `/projects/${project}/controls`);
  check('AP project line reached CVR', controls.summary.costToDate === '10000.00', controls.summary.costToDate);
  await call('PATCH', `/finance/supplier-invoices/${si.id}`, { notes: 'x' }, 400);

  // ---- AP: pay it
  const payOut = await call('POST', '/finance/payments', {
    direction: 'out', partyId: supplier.id, bankAccountId: acc('1000').id, paymentDate: '2026-11-05', reference: 'EFT1',
    allocations: [{ invoiceId: si.id, amount: '12075.00' }],
  });
  si = await call('GET', `/finance/supplier-invoices/${si.id}`);
  check('AP paid', si.status === 'paid' && si.payments.length === 1);
  await call('POST', '/finance/payments', { direction: 'out', partyId: supplier.id, bankAccountId: acc('1000').id, paymentDate: '2026-11-05', allocations: [{ invoiceId: si.id, amount: '1.00' }] }, 400);

  // ---- AP: second invoice, then void it (costs reversed)
  let si2 = await call('POST', '/finance/supplier-invoices', { supplierId: supplier.id, invoiceNo: 'LS-2', invoiceDate: '2026-11-03', lines: [{ description: 'Cladding', amount: '2000.00', projectId: project, costCodeId: code, category: 'material' }] });
  si2 = await call('POST', `/finance/supplier-invoices/${si2.id}/approve`);
  si2 = await call('POST', `/finance/supplier-invoices/${si2.id}/void`, { reason: 'Duplicate' });
  controls = await call('GET', `/projects/${project}/controls`);
  check('void reverses project cost', si2.status === 'void' && controls.summary.costToDate === '10000.00', controls.summary.costToDate);

  // ---- valuation -> tax invoice -> receipt -> valuation paid
  controls = await call('POST', `/projects/${project}/valuations`, { periodEnd: '2026-10-31', workDoneToDate: '200000.00' });
  let val = controls.valuations[0];
  await call('POST', `/projects/${project}/valuations/${val.id}/transition`, { to: 'submitted' });
  controls = await call('POST', `/projects/${project}/valuations/${val.id}/transition`, { to: 'certified', certificateRef: 'IPC-01', certifiedWorkDone: '200000.00' });
  val = controls.valuations[0];
  check('valuation 1 certified', val.status === 'certified' && val.amountDue === '190000.00', val.amountDue);
  const customer = await call('POST', '/finance/customers', { name: 'Mine Co', paymentTermsDays: 30 });
  let ci = await call('POST', '/finance/customer-invoices/from-valuation', { valuationId: val.id, customerId: customer.id, invoiceDate: '2026-11-06' });
  check('valuation invoice = amount due + VAT', ci.subtotal === '190000.00' && ci.vatTotal === '28500.00' && ci.total === '218500.00', JSON.stringify([ci.subtotal, ci.vatTotal, ci.total]));
  await call('POST', '/finance/customer-invoices/from-valuation', { valuationId: val.id, customerId: customer.id }, 400);
  ci = await call('POST', `/finance/customer-invoices/${ci.id}/issue`);
  check('tax invoice numbered', ci.status === 'issued' && ci.number === 'INV-000001', ci.number);
  const receipt = await call('POST', '/finance/payments', { direction: 'in', partyId: customer.id, bankAccountId: acc('1000').id, paymentDate: '2026-11-08', reference: 'MINECO', allocations: [{ invoiceId: ci.id, amount: '218500.00' }] });
  check('receipt marks valuation paid', JSON.stringify(receipt.valuationsPaid) === '[1]', JSON.stringify(receipt.valuationsPaid));
  controls = await call('GET', `/projects/${project}/controls`);
  check('CVR shows payment received', controls.summary.paidToDate === '190000.00' && controls.valuations[0].status === 'paid', controls.summary.paidToDate);

  // second valuation: retention movement on the invoice
  controls = await call('POST', `/projects/${project}/valuations`, { periodEnd: '2026-11-30', workDoneToDate: '300000.00' });
  const val2 = controls.valuations[0];
  await call('POST', `/projects/${project}/valuations/${val2.id}/transition`, { to: 'submitted' });
  await call('POST', `/projects/${project}/valuations/${val2.id}/transition`, { to: 'certified', certificateRef: 'IPC-02' });
  const ci2 = await call('POST', '/finance/customer-invoices/from-valuation', { valuationId: val2.id, customerId: customer.id, invoiceDate: '2026-12-01' });
  check('valuation 2 invoice nets retention', ci2.subtotal === '95000.00' && ci2.lines.length === 2, JSON.stringify(ci2.lines?.map((l) => l.amount)));

  // ---- manual journal + reversal
  const mj = await call('POST', '/finance/journals', { entryDate: '2026-11-01', description: 'Opening capital', lines: [{ accountId: acc('1000').id, debit: '500000.00' }, { accountId: acc('3000').id, credit: '500000.00' }] });
  await call('POST', '/finance/journals', { entryDate: '2026-11-01', description: 'Bad', lines: [{ accountId: acc('1000').id, debit: '1.00' }, { accountId: acc('3000').id, credit: '2.00' }] }, 400);
  const accrual = await call('POST', '/finance/journals', { entryDate: '2026-11-10', description: 'Accrual', lines: [{ accountId: acc('6100').id, debit: '3000.00' }, { accountId: acc('2300').id, credit: '3000.00' }] });
  await call('POST', `/finance/journals/${accrual.id}/reverse`, { reason: 'Wrong month', entryDate: '2026-11-10' });
  await call('POST', `/finance/journals/${accrual.id}/reverse`, { reason: 'again' }, 409);
  await call('POST', `/finance/journals/${si.journalId}/reverse`, { reason: 'no' }, 400);

  // ---- banking
  let bank = await call('POST', `/finance/bank/${acc('1000').id}/import`, {
    lines: [
      { txnDate: '2026-11-01', description: 'CAPITAL INTRO', amount: '500 000.00' },
      { txnDate: '2026-11-06', description: 'EFT LAGGING', amount: '-12,075.00' },
      { txnDate: '2026-11-09', description: 'MINE CO PAYMENT', amount: '218500.00 CR' },
      { txnDate: '2026-11-10', description: 'SERVICE FEE', amount: '(85.50)' },
    ],
  });
  check('statement imported', bank.imported === 4, JSON.stringify(bank.imported));
  const again = await call('POST', `/finance/bank/${acc('1000').id}/import`, { lines: [{ txnDate: '2026-11-10', description: 'SERVICE FEE', amount: '(85.50)' }] });
  check('re-import is ignored', again.imported === 0 && again.duplicates === 1);
  bank = await call('POST', `/finance/bank/${acc('1000').id}/auto-match`);
  check('auto-match 3 of 4', bank.matched === 3, String(bank.matched));
  const fee = bank.unmatchedStatement.find((l) => l.description === 'SERVICE FEE');
  bank = await call('POST', `/finance/bank/lines/${fee.id}/post`, { accountId: acc('6800').id });
  check('bank fully reconciled', bank.unmatchedStatement.length === 0 && bank.unmatchedLedger.length === 0 && bank.reconciledBalance === bank.statementTotal, JSON.stringify([bank.reconciledBalance, bank.statementTotal, bank.unmatchedLedger.length]));
  check('book = statement', bank.bookBalance === '706339.50', bank.bookBalance);

  // ---- reports
  const tb = await call('GET', '/finance/reports/trial-balance?asAt=2026-12-31');
  check('trial balance balances', tb.balanced === true, JSON.stringify([tb.totalDebit, tb.totalCredit]));
  const bs = await call('GET', '/finance/reports/balance-sheet?asAt=2026-12-31');
  check('balance sheet balances', bs.balanced === true, JSON.stringify([bs.assets?.total, bs.liabilitiesAndEquity]));
  const is = await call('GET', '/finance/reports/income-statement?from=2026-11-01&to=2026-11-30');
  check('income statement', is.revenue.total === '200000.00' && is.costOfSales.total === '10000.00' && is.netProfit === '189414.50', JSON.stringify([is.revenue.total, is.costOfSales.total, is.operatingExpenses.total, is.netProfit]));
  const vat = await call('GET', '/finance/reports/vat?from=2026-11-01&to=2026-11-30');
  check('VAT201', vat.outputVat === '28500.00' && vat.inputVat === '1575.00' && vat.netVat === '26925.00', JSON.stringify(vat));
  const ar = await call('GET', '/finance/reports/aged-receivables?asAt=2026-12-31');
  check('aged receivables empty (paid; invoice 2 is a draft)', ar.totals.total === '0.00', ar.totals.total);
  const ledger = await call('GET', `/finance/accounts/${acc('1000').id}/ledger?from=2026-11-06`);
  check('account ledger opening balance', ledger.openingBalance === '487925.00', ledger.openingBalance);

  // ---- period lock
  await call('PATCH', '/finance/settings', { lockedThrough: '2026-11-30' });
  await call('POST', '/finance/journals', { entryDate: '2026-11-15', description: 'Late', lines: [{ accountId: acc('6100').id, debit: '1.00' }, { accountId: acc('1000').id, credit: '1.00' }] }, 400);

  // ---- portfolio CVR still works with finance data
  const portfolio = await call('GET', '/controls/portfolio');
  check('portfolio CVR', portfolio.totals.costToDate === '10000.00', portfolio.totals?.costToDate);

  console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
