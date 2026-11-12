// End-to-end smoke test of phase 3 (procurement) through the real API.
// Usage: node smoke-procurement.cjs <repoRoot> <apiBase> <ownerDbUrl> <jwtSecret>
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
  const users = { owner: crypto.randomUUID(), pm: crypto.randomUUID(), foreman: crypto.randomUUID() };
  const project = crypto.randomUUID();
  await sql.begin(async (tx) => {
    await tx`select set_config('app.current_tenant', ${tenant}, true)`;
    await tx`insert into tenants (id, slug, name, active_modules) values (${tenant}, ${'proc-' + Date.now().toString(36)}, 'Proc', ${['mod_commercial', 'mod_finance', 'mod_procurement']})`;
    for (const [k, role] of [['owner', 'owner'], ['pm', 'project_manager'], ['foreman', 'site_foreman']]) {
      await tx`insert into users (id, tenant_id, email, full_name, password_hash, role) values (${users[k]}, ${tenant}, ${k + '@proc.test'}, ${k}, 'x', ${role})`;
    }
    await tx`insert into projects (id, tenant_id, code, name, contract_value) values (${project}, ${tenant}, 'PR-1', 'Proc project', 5000000)`;
  });
  await sql.end();
  tokens.owner = jwt({ sub: users.owner, tid: tenant, role: 'owner' });
  tokens.pm = jwt({ sub: users.pm, tid: tenant, role: 'project_manager' });
  tokens.foreman = jwt({ sub: users.foreman, tid: tenant, role: 'site_foreman' });

  await call('owner', 'POST', '/finance/setup');
  const accounts = await call('owner', 'GET', '/finance/accounts');
  const acc = (code) => accounts.find((a) => a.code === code);
  let controls = await call('owner', 'POST', `/projects/${project}/cost-codes`, { code: '200', description: 'Insulation', budget: '100000.00' });
  controls = await call('owner', 'POST', `/projects/${project}/cost-codes`, { code: '300', description: 'Cladding (subcontract)', budget: '1000000.00' });
  const code = controls.costCodes.find((c) => c.code === '200').id;
  const scCode = controls.costCodes.find((c) => c.code === '300').id;
  const sup = await call('owner', 'POST', '/finance/suppliers', { name: 'Insulate SA', vatNumber: '4123456789', bbbeeLevel: 1, bbbeeExpiry: '2027-06-30', isSubcontractor: true });
  const sup2 = await call('owner', 'POST', '/finance/suppliers', { name: 'Budget Lagging', bbbeeLevel: 4 });

  // ---- what a site foreman can see without access to the books
  const fSup = await call('foreman', 'GET', '/procurement/suppliers');
  const fCodes = await call('foreman', 'GET', `/procurement/projects/${project}/cost-codes`);
  const fAcc = await call('foreman', 'GET', '/procurement/accounts');
  check('foreman reads suppliers, cost codes and accounts', fSup.length === 2 && fCodes.length === 2 && fCodes[0].budget === undefined && fAcc.every((a) => a.balance === undefined), JSON.stringify([fSup.length, fCodes.length]));
  await call('foreman', 'GET', '/finance/accounts', undefined, 403);
  await call('foreman', 'POST', '/procurement/suppliers', { name: 'Nope' }, 403);
  const pmSup = await call('pm', 'POST', '/procurement/suppliers', { name: 'PM Supplies', cidbGrading: '6ce' });
  check('procurement can add suppliers', pmSup.cidbGrading === '6CE', pmSup.cidbGrading);

  // ---- requisition by a site foreman, approval limits
  const projLine = (description, quantity, unitPrice) => ({ description, unit: 'm2', quantity, unitPrice, vatRate: '15', projectId: project, costCodeId: code, category: 'material' });
  let po = await call('foreman', 'POST', '/procurement/purchase-orders', { supplierId: sup.id, projectId: project, orderDate: '2026-11-02', lines: [projLine('Mineral wool 50mm', '100', '450.00'), projLine('Aluminium cladding', '10', '1000.00')] });
  check('PO totals', po.subtotal === '55000.00' && po.total === '63250.00' && po.number === 'PO-00001', JSON.stringify([po.subtotal, po.total, po.number]));
  await call('foreman', 'POST', `/procurement/purchase-orders/${po.id}/transition`, { to: 'submitted' });
  await call('pm', 'POST', `/procurement/purchase-orders/${po.id}/transition`, { to: 'approved' }, 403);
  await call('foreman', 'POST', `/procurement/purchase-orders/${po.id}/transition`, { to: 'approved' }, 403);
  po = await call('owner', 'POST', `/procurement/purchase-orders/${po.id}/transition`, { to: 'approved' });
  check('owner approves over the PM limit', po.status === 'approved');
  controls = await call('owner', 'GET', `/projects/${project}/controls`);
  check('approved PO is a commitment', controls.costCodes.find((c) => c.code === '200').committed === '55000.00', controls.costCodes.find((c) => c.code === '200').committed);

  // ---- goods received
  const [l1, l2] = po.lines;
  po = await call('foreman', 'POST', `/procurement/purchase-orders/${po.id}/receive`, { receivedOn: '2026-11-04', deliveryNote: 'DN-881', lines: [{ poLineId: l1.id, quantity: '60' }, { poLineId: l2.id, quantity: '10' }] });
  check('GRN recorded', po.receipts.length === 1 && po.lines[0].received === '60.000' && po.lines[0].outstanding === '40.000');
  // Regression: a zero on a fully received line must be ignored, not rejected by the database.
  po = await call('foreman', 'POST', `/procurement/purchase-orders/${po.id}/receive`, { receivedOn: '2026-11-05', lines: [{ poLineId: l1.id, quantity: '5' }, { poLineId: l2.id, quantity: '0' }] });
  check('zero-quantity lines are skipped when receiving', po.lines[0].received === '65.000' && po.receipts.length === 2, JSON.stringify(po.lines?.map((l) => l.received)));
  const list = await call('owner', 'GET', '/procurement/purchase-orders');
  check('delivery status only counts real receipts', list.find((o) => o.id === po.id)?.delivery === 'part_received');
  await call('foreman', 'POST', `/procurement/purchase-orders/${po.id}/receive`, { receivedOn: '2026-11-05', lines: [{ poLineId: l1.id, quantity: '50' }] }, 400);

  // ---- invoice against the order: three-way match
  let r = await call('owner', 'POST', `/procurement/purchase-orders/${po.id}/invoice`, { invoiceNo: 'IS-1001', invoiceDate: '2026-11-06', lines: [{ poLineId: l1.id, quantity: '60' }, { poLineId: l2.id, quantity: '10' }] });
  let inv = await call('owner', 'POST', `/finance/supplier-invoices/${r.invoiceId}/approve`, {});
  check('matched invoice approved', inv.status === 'approved' && inv.total === '42550.00', JSON.stringify([inv.status, inv.total]));
  controls = await call('owner', 'GET', `/projects/${project}/controls`);
  let row = controls.costCodes.find((c) => c.code === '200');
  check('cost moves from committed to actual', row.cost === '37000.00' && row.committed === '18000.00', JSON.stringify([row.cost, row.committed]));
  r = await call('owner', 'POST', `/procurement/purchase-orders/${po.id}/invoice`, { invoiceNo: 'IS-1002', invoiceDate: '2026-11-07', lines: [{ poLineId: l1.id, quantity: '10' }] });
  const blocked = await call('owner', 'POST', `/finance/supplier-invoices/${r.invoiceId}/approve`, {}, 400);
  check('over-billing blocked by the three-way match', /invoiced 70.000 but only 65.000 received/.test(blocked.message), blocked.message);
  inv = await call('owner', 'POST', `/finance/supplier-invoices/${r.invoiceId}/approve`, { matchOverrideReason: 'Delivery DN-902 not yet captured on site' });
  check('override approves with a reason', inv.status === 'approved');
  await call('owner', 'PATCH', `/finance/supplier-invoices/${r.invoiceId}`, { lines: [] }, 400);

  po = await call('owner', 'POST', `/procurement/purchase-orders/${po.id}/transition`, { to: 'closed', reason: 'Balance not required' });
  controls = await call('owner', 'GET', `/projects/${project}/controls`);
  check('closing the PO releases the commitment', controls.costCodes.find((c) => c.code === '200').committed === '0.00');

  // ---- RFQ → award → PO
  let rfq = await call('pm', 'POST', '/procurement/rfqs', { title: 'Pipe lagging phase 2', projectId: project, closingDate: '2026-11-20', items: [{ description: 'Lagging 25mm', unit: 'm', quantity: '200' }, { description: 'Bands', unit: 'ea', quantity: '400' }] });
  const [i1, i2] = rfq.items;
  rfq = await call('pm', 'POST', `/procurement/rfqs/${rfq.id}/quotes`, { supplierId: sup.id, quoteRef: 'Q-77', prices: { [i1.id]: '120.00', [i2.id]: '5.00' } }); // 26 000
  rfq = await call('pm', 'POST', `/procurement/rfqs/${rfq.id}/quotes`, { supplierId: sup2.id, prices: { [i1.id]: '110.00', [i2.id]: '4.00' } }); // 23 600
  check('quotes ranked', rfq.quotes[0].supplierId === sup2.id && rfq.quotes[0].total === '23600.00' && rfq.quotes[1].rank === 2, JSON.stringify(rfq.quotes.map((q) => [q.supplierName, q.total, q.rank])));
  const pricier = rfq.quotes.find((q) => q.supplierId === sup.id);
  await call('pm', 'POST', `/procurement/rfqs/${rfq.id}/award`, { quoteId: pricier.id, costCodeId: code }, 400);
  rfq = await call('pm', 'POST', `/procurement/rfqs/${rfq.id}/award`, { quoteId: pricier.id, costCodeId: code, note: 'Shorter lead time; site deadline 30 Nov' });
  check('award drafts a PO', rfq.status === 'awarded' && Boolean(rfq.purchaseOrderId));
  const awarded = await call('pm', 'GET', `/procurement/purchase-orders/${rfq.purchaseOrderId}`);
  check('awarded PO uses quote prices', awarded.subtotal === '26000.00' && awarded.rfqId === rfq.id, awarded.subtotal);
  await call('pm', 'POST', `/procurement/rfqs/${rfq.id}/quotes`, { supplierId: sup2.id, prices: { [i1.id]: '1.00' } }, 400);

  // ---- subcontract → certificate → invoice
  let sc = await call('pm', 'POST', '/procurement/subcontracts', { projectId: project, supplierId: sup.id, ref: 'SC-01', scope: 'Cladding', costCodeId: scCode, contractValue: '1000000.00' });
  sc = await call('pm', 'POST', `/procurement/subcontracts/${sc.id}/transition`, { to: 'active' });
  controls = await call('owner', 'GET', `/projects/${project}/controls`);
  check('active subcontract is committed', controls.costCodes.find((c) => c.code === '300').committed === '1000000.00');
  sc = await call('pm', 'POST', `/procurement/subcontracts/${sc.id}/certificates`, { periodEnd: '2026-11-30', workDoneToDate: '200000.00' });
  const cert = sc.certificates[0];
  check('certificate figures', cert.retentionToDate === '10000.00' && cert.amountDue === '190000.00', JSON.stringify([cert.retentionToDate, cert.amountDue]));
  await call('pm', 'POST', `/procurement/subcontracts/${sc.id}/certificates/${cert.id}/certify`, {}, 403);
  const certified = await call('owner', 'POST', `/procurement/subcontracts/${sc.id}/certificates/${cert.id}/certify`, { invoiceNo: 'IS-SC-01' });
  const scInv = await call('owner', 'GET', `/finance/supplier-invoices/${certified.supplierInvoiceId}`);
  check('certificate drafts the invoice net of retention', scInv.subtotal === '190000.00' && scInv.vatTotal === '28500.00' && scInv.lines.length === 2, JSON.stringify([scInv.subtotal, scInv.vatTotal]));
  await call('owner', 'POST', `/finance/supplier-invoices/${scInv.id}/approve`, {});
  controls = await call('owner', 'GET', `/projects/${project}/controls`);
  row = controls.costCodes.find((c) => c.code === '300');
  check('subcontract cost and remaining commitment', row.cost === '200000.00' && row.committed === '800000.00', JSON.stringify([row.cost, row.committed]));
  const tb = await call('owner', 'GET', '/finance/reports/trial-balance?asAt=2026-12-31');
  const ret = tb.rows.find((x) => x.code === '2150');
  check('retention payable credited', ret && ret.credit === '10000.00' && tb.balanced, JSON.stringify(ret));

  // ---- B-BBEE
  const bb = await call('owner', 'GET', '/procurement/reports/bbbee?from=2026-01-01&to=2026-12-31');
  // Insulate SA (level 1, 135%): 37 000 + 4 500 + 190 000 excl. VAT.
  check('B-BBEE spend', bb.totalSpend === '231500.00' && bb.recognisedSpend === '312525.00', JSON.stringify([bb.totalSpend, bb.recognisedSpend]));

  console.log(failures === 0 ? '\nALL PROCUREMENT SMOKE CHECKS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
