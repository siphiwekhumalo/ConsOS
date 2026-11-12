import { useEffect, useState } from 'react';
import { CheckCircle2, FileText, PackageCheck, Pencil, Plus, Send, ShoppingCart, Trash2, Undo2, XCircle } from 'lucide-react';
import { api, type Me, type OrderLineInput, type Party, type Project, type PurchaseOrder } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, zar } from '../../lib/format';
import { FormDialog, useAction } from '../../components/forms';
import { Alert, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Skeleton, Table, Td, Textarea, Th, Tr } from '../../components/ui';
import { OrderLinesEditor, StatusBadge, blankOrderLine, today } from './shared';

const BUYERS = ['owner', 'admin', 'project_manager', 'finance'];
const DELIVERY: Record<string, string> = { none: 'Not delivered', part_received: 'Part delivered', received: 'Delivered' };

export function Orders({ me, suppliers, projects, accounts }: { me: Me; suppliers: Party[]; projects: Project[]; accounts: { id: string; code: string; name: string }[] }) {
  const [status, setStatus] = useState('');
  const orders = useAsync(() => api.procurement.orders({ status: status || undefined }), [status]);
  const [editing, setEditing] = useState<PurchaseOrder | 'new' | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  return (
    <>
      <Card padded={false}>
        <div className="p-5 pb-4">
          <CardHeader
            title="Purchase orders"
            subtitle="Raise a requisition, get it approved within your limits, receive the goods, then match the supplier’s invoice."
            actions={
              <>
                <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Status">
                  <option value="">All statuses</option>
                  {['draft', 'submitted', 'approved', 'closed', 'cancelled'].map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
                </Select>
                <Button size="sm" icon={Plus} disabled={!suppliers.length} title={suppliers.length ? undefined : 'Add a supplier first'} onClick={() => setEditing('new')}>New order</Button>
              </>
            }
          />
        </div>
        {!orders.data ? <Skeleton className="m-5 h-24" /> : orders.data.length === 0 ? (
          <EmptyState icon={ShoppingCart} title="No purchase orders">Site teams raise requisitions here; they become orders once approved.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Order</Th><Th>Supplier</Th><Th>Date</Th><Th>Status</Th><Th>Delivery</Th><Th right>Excl. VAT</Th></tr></thead>
            <tbody>
              {orders.data.map((o) => (
                <Tr key={o.id} onClick={() => setViewing(o.id)}>
                  <Td mono>{o.number}</Td>
                  <Td className="font-medium">{o.supplierName}</Td>
                  <Td className="text-ink-2">{date(o.orderDate)}</Td>
                  <Td><StatusBadge status={o.status} label={o.status === 'submitted' ? 'awaiting approval' : undefined} /></Td>
                  <Td className="text-ink-2">{o.status === 'approved' || o.status === 'closed' ? DELIVERY[o.delivery ?? 'none'] : '—'}</Td>
                  <Td right>{zar(o.subtotal, true)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <OrderDialog order={editing} onClose={() => setEditing(null)} onSaved={(o) => { void orders.reload(); setViewing(o.id); }} suppliers={suppliers} projects={projects} accounts={accounts} />
      <OrderDetail id={viewing} me={me} onClose={() => setViewing(null)} onChanged={() => void orders.reload()} onEdit={(o) => { setViewing(null); setEditing(o); }} />
    </>
  );
}

function OrderDialog({ order, onClose, onSaved, suppliers, projects, accounts }: { order: PurchaseOrder | 'new' | null; onClose: () => void; onSaved: (o: PurchaseOrder) => void; suppliers: Party[]; projects: Project[]; accounts: { id: string; code: string; name: string }[] }) {
  const existing = order && order !== 'new' ? order : null;
  const [head, setHead] = useState({ supplierId: '', projectId: '', orderDate: today(), requiredBy: '', deliveryAddress: '', notes: '' });
  const [lines, setLines] = useState<OrderLineInput[]>([blankOrderLine()]);
  useEffect(() => {
    if (!order) return;
    if (order === 'new') {
      setHead({ supplierId: '', projectId: '', orderDate: today(), requiredBy: '', deliveryAddress: '', notes: '' });
      setLines([blankOrderLine()]);
      return;
    }
    setHead({ supplierId: order.supplierId, projectId: order.projectId ?? '', orderDate: order.orderDate, requiredBy: order.requiredBy ?? '', deliveryAddress: order.deliveryAddress ?? '', notes: order.notes });
    setLines((order.lines ?? []).map((l) => ({ description: l.description, unit: l.unit, quantity: String(Number(l.quantity)), unitPrice: l.unitPrice, vatRate: String(Number(l.vatRate)), projectId: l.projectId, costCodeId: l.costCodeId, category: l.category, accountId: l.accountId })));
  }, [order]);

  return (
    <FormDialog
      open={order !== null}
      onClose={onClose}
      title={existing ? `Edit ${existing.number}` : 'New purchase order'}
      description="Saved as a draft. Submit it for approval when it is ready."
      submitLabel="Save draft"
      wide
      onSubmit={async () => {
        const body = { ...head, projectId: head.projectId || null, requiredBy: head.requiredBy || null, deliveryAddress: head.deliveryAddress || null, lines };
        onSaved(existing ? await api.procurement.updateOrder(existing.id, body) : await api.procurement.addOrder(body));
      }}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Supplier" className="sm:col-span-2">
          <Select value={head.supplierId} onChange={(e) => setHead({ ...head, supplierId: e.target.value })} required>
            <option value="">Choose…</option>
            {suppliers.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}{s.bbbeeLevel ? ` · B-BBEE L${s.bbbeeLevel}` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Order date"><Input type="date" value={head.orderDate} onChange={(e) => setHead({ ...head, orderDate: e.target.value })} required /></Field>
        <Field label="Required on site by"><Input type="date" value={head.requiredBy} onChange={(e) => setHead({ ...head, requiredBy: e.target.value })} /></Field>
        <Field label="Project (for delivery and reporting)" className="sm:col-span-2">
          <Select
            value={head.projectId}
            onChange={(e) => {
              const projectId = e.target.value;
              setHead({ ...head, projectId });
              // Default empty lines to the chosen project.
              setLines(lines.map((l) => (l.description || l.costCodeId ? l : { ...l, projectId: projectId || null, category: projectId ? 'material' : null, accountId: null })));
            }}
          >
            <option value="">None</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
        </Field>
        <Field label="Delivery address" className="sm:col-span-2"><Input value={head.deliveryAddress} onChange={(e) => setHead({ ...head, deliveryAddress: e.target.value })} maxLength={500} /></Field>
      </div>
      <OrderLinesEditor lines={lines} onChange={setLines} projects={projects} accounts={accounts} />
      <Field label="Notes to supplier"><Textarea rows={2} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} maxLength={2000} /></Field>
    </FormDialog>
  );
}

function OrderDetail({ id, me, onClose, onChanged, onEdit }: { id: string | null; me: Me; onClose: () => void; onChanged: () => void; onEdit: (o: PurchaseOrder) => void }) {
  const [po, setPo] = useState<PurchaseOrder>();
  const [receiving, setReceiving] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [closing, setClosing] = useState<'closed' | 'cancelled' | null>(null);
  const [reason, setReason] = useState('');
  const action = useAction();
  const hasFinance = me.modules.includes('mod_finance');
  const role = me.user.role;
  const isBuyer = BUYERS.includes(role);

  useEffect(() => {
    setPo(undefined);
    action.setError(null);
    if (id) void api.procurement.order(id).then(setPo);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: PurchaseOrder) => { setPo(next); onChanged(); };
  const move = (to: 'submitted' | 'draft' | 'approved') => action.run(async () => update(await api.procurement.transitionOrder(po!.id, to)));

  return (
    <Dialog open={id !== null} onClose={onClose} title={po ? `${po.number} · ${po.supplierName}` : 'Purchase order'} description={po ? `${date(po.orderDate)} · ${zar(po.total, true)} incl. VAT` : undefined} wide>
      {!po ? <Skeleton className="h-48" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={po.status} label={po.status === 'submitted' ? 'awaiting approval' : undefined} />
            {po.requiredBy && <span className="text-xs text-ink-3">Required by {date(po.requiredBy)}</span>}
            {po.closeReason && <span className="text-xs text-ink-3">· {po.closeReason}</span>}
            <div className="ml-auto flex flex-wrap gap-1.5">
              {po.status === 'draft' && (
                <>
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => onEdit(po)}>Edit</Button>
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void action.run(async () => { await api.procurement.deleteOrder(po.id); onChanged(); onClose(); })}>Delete</Button>
                  <Button size="sm" icon={Send} loading={action.busy} onClick={() => void move('submitted')}>Submit for approval</Button>
                </>
              )}
              {po.status === 'submitted' && (
                <>
                  <Button size="sm" variant="ghost" icon={Undo2} onClick={() => void move('draft')}>Return to draft</Button>
                  {role !== 'site_foreman' && <Button size="sm" icon={CheckCircle2} loading={action.busy} onClick={() => void move('approved')}>Approve</Button>}
                </>
              )}
              {po.status === 'approved' && (
                <>
                  <Button size="sm" variant="secondary" icon={PackageCheck} onClick={() => setReceiving(true)}>Receive goods</Button>
                  {isBuyer && hasFinance && <Button size="sm" variant="secondary" icon={FileText} onClick={() => setInvoicing(true)}>Capture invoice</Button>}
                  {isBuyer && <Button size="sm" variant="ghost" onClick={() => { setReason(''); setClosing('closed'); }}>Close</Button>}
                </>
              )}
              {isBuyer && (po.status === 'draft' || po.status === 'submitted' || po.status === 'approved') && (
                <Button size="sm" variant="ghost" icon={XCircle} onClick={() => { setReason(''); setClosing('cancelled'); }}>Cancel</Button>
              )}
            </div>
          </div>
          {action.error && <Alert>{action.error}</Alert>}

          <div className="overflow-x-auto rounded-lg border border-line">
            <Table>
              <thead><tr><Th>Item</Th><Th right>Ordered</Th><Th right>Received</Th><Th right>Invoiced</Th><Th right>Price</Th><Th right>Amount</Th></tr></thead>
              <tbody>
                {po.lines?.map((l) => (
                  <Tr key={l.id}>
                    <Td>{l.description}<div className="text-xs text-ink-3">{l.unit}</div></Td>
                    <Td right>{Number(l.ordered)}</Td>
                    <Td right className={Number(l.outstanding) > 0 && Number(l.received) > 0 ? 'text-warning-ink' : undefined}>{Number(l.received)}</Td>
                    <Td right className="text-ink-2">{Number(l.invoiced)}</Td>
                    <Td right>{zar(l.unitPrice, true)}</Td>
                    <Td right>{zar(l.amount, true)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          <dl className="grid grid-cols-3 gap-3 text-sm">
            <div><dt className="text-xs text-ink-3">Excl. VAT</dt><dd className="num font-medium">{zar(po.subtotal, true)}</dd></div>
            <div><dt className="text-xs text-ink-3">VAT</dt><dd className="num">{zar(po.vatTotal, true)}</dd></div>
            <div><dt className="text-xs text-ink-3">Still committed</dt><dd className="num">{zar(po.committed, true)}</dd></div>
          </dl>
          {(po.receipts?.length ?? 0) > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Deliveries</h4>
              <ul className="text-sm text-ink-2">{po.receipts!.map((g) => <li key={g.id}>{g.number} · {date(g.receivedOn)}{g.deliveryNote ? ` · delivery note ${g.deliveryNote}` : ''}</li>)}</ul>
            </div>
          )}
          {(po.invoices?.length ?? 0) > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Supplier invoices</h4>
              <ul className="text-sm text-ink-2">{po.invoices!.map((i) => <li key={i.id}>{i.invoiceNo} · {date(i.invoiceDate)} · {zar(i.total, true)} · <span className="capitalize">{i.status.replace('_', ' ')}</span></li>)}</ul>
              {po.invoices!.some((i) => i.status === 'draft') && <p className="mt-1 text-xs text-ink-3">Draft invoices are approved under Finance › Payables, where the three-way match is checked.</p>}
            </div>
          )}

          <ReceiveDialog po={receiving ? po : null} onClose={() => setReceiving(false)} onDone={update} />
          <InvoiceDialog po={invoicing ? po : null} onClose={() => setInvoicing(false)} onDone={update} />
          <FormDialog
            open={closing !== null}
            onClose={() => setClosing(null)}
            title={closing === 'closed' ? `Close ${po.number}` : `Cancel ${po.number}`}
            description={closing === 'closed' ? 'Nothing more will be delivered or committed. Undelivered quantities are released from the project commitment.' : 'Use for orders that will not go ahead. An order with deliveries must be closed instead.'}
            submitLabel={closing === 'closed' ? 'Close order' : 'Cancel order'}
            danger={closing === 'cancelled'}
            onSubmit={async () => update(await api.procurement.transitionOrder(po.id, closing!, reason || undefined))}
          >
            <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} required={po.status !== 'draft'} maxLength={500} /></Field>
          </FormDialog>
        </div>
      )}
    </Dialog>
  );
}

function ReceiveDialog({ po, onClose, onDone }: { po: PurchaseOrder | null; onClose: () => void; onDone: (po: PurchaseOrder) => void }) {
  const [qty, setQty] = useState<Record<string, string>>({});
  const [head, setHead] = useState({ receivedOn: today(), deliveryNote: '' });
  useEffect(() => {
    if (!po) return;
    setHead({ receivedOn: today(), deliveryNote: '' });
    setQty(Object.fromEntries((po.lines ?? []).map((l) => [l.id, String(Number(l.outstanding))])));
  }, [po]);
  return (
    <FormDialog
      open={po !== null}
      onClose={onClose}
      title={po ? `Receive goods on ${po.number}` : ''}
      description="Record what actually arrived. You cannot receive more than was ordered."
      submitLabel="Record delivery"
      onSubmit={async () =>
        onDone(await api.procurement.receive(po!.id, { ...head, deliveryNote: head.deliveryNote || undefined, lines: Object.entries(qty).filter(([, q]) => Number(q) > 0).map(([poLineId, quantity]) => ({ poLineId, quantity })) }))
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Received on"><Input type="date" value={head.receivedOn} onChange={(e) => setHead({ ...head, receivedOn: e.target.value })} required /></Field>
        <Field label="Supplier delivery note no."><Input value={head.deliveryNote} onChange={(e) => setHead({ ...head, deliveryNote: e.target.value })} maxLength={60} /></Field>
      </div>
      {po?.lines?.map((l) => (
        <div key={l.id} className="grid grid-cols-[1fr_8rem] items-center gap-3 text-sm">
          <span>{l.description} <span className="text-ink-3">· {Number(l.outstanding)} {l.unit} outstanding</span></span>
          <Input inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} pattern="\d{1,15}(\.\d{1,3})?" aria-label={`Quantity received for ${l.description}`} />
        </div>
      ))}
    </FormDialog>
  );
}

function InvoiceDialog({ po, onClose, onDone }: { po: PurchaseOrder | null; onClose: () => void; onDone: (po: PurchaseOrder) => void }) {
  const [head, setHead] = useState({ invoiceNo: '', invoiceDate: today() });
  const [lines, setLines] = useState<Record<string, { quantity: string; unitPrice: string }>>({});
  useEffect(() => {
    if (!po) return;
    setHead({ invoiceNo: '', invoiceDate: today() });
    setLines(Object.fromEntries((po.lines ?? []).map((l) => [l.id, { quantity: String(Number(l.toInvoice)), unitPrice: l.unitPrice }])));
  }, [po]);
  return (
    <FormDialog
      open={po !== null}
      onClose={onClose}
      title={po ? `Supplier invoice against ${po.number}` : ''}
      description="Quantities default to what was received but not yet invoiced. Enter the invoice as the supplier billed it; Payables checks it against the order and the deliveries when it is approved."
      submitLabel="Save draft invoice"
      wide
      onSubmit={async () =>
        onDone(await api.procurement.invoiceOrder(po!.id, { ...head, lines: Object.entries(lines).filter(([, l]) => Number(l.quantity) > 0).map(([poLineId, l]) => ({ poLineId, quantity: l.quantity, unitPrice: l.unitPrice })) }))
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Supplier's invoice no."><Input value={head.invoiceNo} onChange={(e) => setHead({ ...head, invoiceNo: e.target.value })} required maxLength={60} /></Field>
        <Field label="Invoice date"><Input type="date" value={head.invoiceDate} onChange={(e) => setHead({ ...head, invoiceDate: e.target.value })} required /></Field>
      </div>
      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_7rem_8rem] gap-3 text-xs font-medium text-ink-3"><span>Item</span><span>Qty billed</span><span>Unit price billed</span></div>
        {po?.lines?.map((l) => (
          <div key={l.id} className="grid grid-cols-[1fr_7rem_8rem] items-center gap-3 text-sm">
            <span>{l.description} <span className="text-ink-3">· {Number(l.toInvoice)} to invoice at {zar(l.unitPrice, true)}</span></span>
            <Input inputMode="decimal" value={lines[l.id]?.quantity ?? ''} onChange={(e) => setLines({ ...lines, [l.id]: { ...lines[l.id]!, quantity: e.target.value } })} pattern="\d{1,15}(\.\d{1,3})?" aria-label="Quantity billed" />
            <Input inputMode="decimal" value={lines[l.id]?.unitPrice ?? ''} onChange={(e) => setLines({ ...lines, [l.id]: { ...lines[l.id]!, unitPrice: e.target.value } })} pattern="\d{1,16}(\.\d{1,2})?" aria-label="Unit price billed" />
          </div>
        ))}
      </div>
    </FormDialog>
  );
}
