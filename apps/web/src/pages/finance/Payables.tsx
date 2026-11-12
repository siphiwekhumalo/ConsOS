import { useEffect, useMemo, useState } from 'react';
import { Banknote, Building2, CheckCircle2, FileText, Pencil, Plus, Trash2, XCircle } from 'lucide-react';
import { api, type Account, type CostCategory, type CostCodeRow, type Party, type Project, type Role, type SupplierInvoice, type SupplierInvoiceLine } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, sentence, zar } from '../../lib/format';
import { AmountInput, FormDialog, useAction } from '../../components/forms';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Select, Skeleton, StatusPill, Table, Tabs, Td, Textarea, Th, Tr } from '../../components/ui';
import { InvoiceStatus, PartyDialog, PaymentDialog, minus, overdue, today } from './shared';

type Sub = 'invoices' | 'suppliers' | 'payments';
const APPROVERS: Role[] = ['owner', 'admin', 'finance'];
const CATEGORIES: CostCategory[] = ['labour', 'material', 'plant', 'subcontract', 'overhead', 'other'];

export function Payables({ role }: { role: Role }) {
  const [sub, setSub] = useState<Sub>('invoices');
  const invoices = useAsync(() => api.finance.supplierInvoices(), []);
  const suppliers = useAsync(() => api.finance.suppliers(), []);
  const accounts = useAsync(() => api.finance.accounts(), []);
  const payments = useAsync(() => (APPROVERS.includes(role) ? api.finance.payments('out') : Promise.resolve([])), []);
  const projects = useAsync(() => api.projects(), []);
  const [editing, setEditing] = useState<SupplierInvoice | 'new' | null>(null);
  const [party, setParty] = useState<Party | 'new' | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<SupplierInvoice | null>(null);
  const [reason, setReason] = useState('');
  const action = useAction();
  const canApprove = APPROVERS.includes(role);
  const reload = () => Promise.all([invoices.reload(), payments.reload()]);
  const [mismatch, setMismatch] = useState<{ invoice: SupplierInvoice; message: string } | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  /** Approve; if the three-way match fails, offer an override with a recorded reason. */
  const approve = (i: SupplierInvoice) =>
    action.run(async () => {
      try {
        await api.finance.approveSupplierInvoice(i.id);
        await invoices.reload();
      } catch (err) {
        const message = (err as Error).message;
        if (/received|order price/.test(message)) {
          setOverrideReason('');
          setMismatch({ invoice: i, message });
          return;
        }
        throw err;
      }
    });

  const open = (invoices.data ?? []).filter((i) => i.status === 'approved' || i.status === 'part_paid');
  const owed = open.reduce((s, i) => s + Number(minus(i.total, i.amountPaid)), 0);
  const overdueCount = open.filter((i) => overdue(i.dueDate, i.status)).length;

  return (
    <div className="space-y-6">
      <Tabs<Sub>
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'invoices', label: 'Supplier invoices', icon: FileText, count: invoices.data?.length },
          { id: 'suppliers', label: 'Suppliers', icon: Building2, count: suppliers.data?.length },
          ...(canApprove ? [{ id: 'payments' as Sub, label: 'Payments made', icon: Banknote, count: payments.data?.length }] : []),
        ]}
      />
      {action.error && <Alert>{action.error}</Alert>}

      {sub === 'invoices' && (
        <Card padded={false}>
          <div className="p-5 pb-4">
            <CardHeader
              title="Supplier invoices"
              subtitle={`${zar(owed.toFixed(2))} owed on ${open.length} approved invoice${open.length === 1 ? '' : 's'}${overdueCount ? ` · ${overdueCount} overdue` : ''}`}
              actions={
                <>
                  {canApprove && <Button size="sm" variant="secondary" icon={Banknote} disabled={open.length === 0} onClick={() => setPaying('')}>Pay supplier</Button>}
                  <Button size="sm" icon={Plus} disabled={!suppliers.data?.length} title={suppliers.data?.length ? undefined : 'Add a supplier first'} onClick={() => setEditing('new')}>Capture invoice</Button>
                </>
              }
            />
          </div>
          {!invoices.data ? <Skeleton className="m-5 h-24" /> : invoices.data.length === 0 ? (
            <EmptyState icon={FileText} title="No supplier invoices yet">Capture invoices as they arrive. Lines coded to a project land in that project’s cost ledger when approved.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Supplier</Th><Th>Invoice</Th><Th>Date</Th><Th>Due</Th><Th>Status</Th><Th right>Total</Th><Th right>Outstanding</Th><Th /></tr></thead>
              <tbody>
                {invoices.data.map((i) => (
                  <Tr key={i.id}>
                    <Td className="font-medium">{i.supplierName}</Td>
                    <Td mono>{i.invoiceNo}</Td>
                    <Td className="whitespace-nowrap text-ink-2">{date(i.invoiceDate)}</Td>
                    <Td className="whitespace-nowrap">
                      {overdue(i.dueDate, i.status) ? <StatusPill status="critical">{date(i.dueDate)}</StatusPill> : <span className="text-ink-2">{date(i.dueDate)}</span>}
                    </Td>
                    <Td><InvoiceStatus status={i.status} /></Td>
                    <Td right>{zar(i.total, true)}</Td>
                    <Td right className="text-ink-2">{i.status === 'void' || i.status === 'draft' ? '—' : zar(minus(i.total, i.amountPaid), true)}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        {i.status === 'draft' && (
                          <>
                            <Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" onClick={() => setEditing(i)} />
                            <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={() => void action.run(async () => { await api.finance.deleteSupplierInvoice(i.id); await invoices.reload(); })} />
                            {canApprove && <Button size="sm" icon={CheckCircle2} loading={action.busy} onClick={() => void approve(i)}>Approve</Button>}
                          </>
                        )}
                        {canApprove && (i.status === 'approved' || i.status === 'part_paid') && (
                          <Button size="sm" variant="secondary" onClick={() => setPaying(i.supplierId)}>Pay</Button>
                        )}
                        {canApprove && i.status === 'approved' && (
                          <Button size="sm" variant="ghost" icon={XCircle} onClick={() => { setReason(''); setVoiding(i); }}>Void</Button>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {sub === 'suppliers' && (
        <PartyTable title="Suppliers" parties={suppliers.data} onAdd={() => setParty('new')} onEdit={setParty} />
      )}

      {sub === 'payments' && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Payments made" subtitle="Each payment posts Dr trade payables, Cr bank, and can be matched on the bank statement." /></div>
          {payments.data?.length === 0 ? <EmptyState icon={Banknote} title="No payments yet" /> : (
            <Table>
              <thead><tr><Th>No.</Th><Th>Date</Th><Th>Supplier</Th><Th>Bank</Th><Th>Reference</Th><Th right>Amount</Th></tr></thead>
              <tbody>
                {payments.data?.map((p) => (
                  <Tr key={p.id}>
                    <Td mono>{p.number}</Td>
                    <Td className="text-ink-2">{date(p.paymentDate)}</Td>
                    <Td className="font-medium">{p.partyName}</Td>
                    <Td className="text-ink-2">{p.bankName}</Td>
                    <Td className="text-ink-2">{p.reference ?? '—'}</Td>
                    <Td right>{zar(p.amount, true)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <SupplierInvoiceDialog
        invoice={editing}
        onClose={() => setEditing(null)}
        onSaved={() => void invoices.reload()}
        suppliers={suppliers.data ?? []}
        accounts={accounts.data ?? []}
        projects={projects.data ?? []}
      />
      <PartyDialog kind="supplier" party={party === 'new' ? null : party} open={party !== null} onClose={() => setParty(null)} onSaved={() => void suppliers.reload()} />
      <PaymentDialog
        direction="out"
        open={paying !== null}
        initialPartyId={paying || undefined}
        onClose={() => setPaying(null)}
        onSaved={() => void reload()}
        parties={suppliers.data ?? []}
        banks={(accounts.data ?? []).filter((a) => a.isBank && a.isActive)}
        openInvoices={open.map((i) => ({ id: i.id, partyId: i.supplierId, label: i.invoiceNo, dueDate: i.dueDate, outstanding: minus(i.total, i.amountPaid) }))}
      />
      <FormDialog
        open={mismatch !== null}
        onClose={() => setMismatch(null)}
        title={mismatch ? `Invoice ${mismatch.invoice.invoiceNo} does not match its order` : ''}
        description="The three-way match compares the invoice with the purchase order and the goods received. Approve anyway only if you have checked why it differs; the reason is kept with the invoice and in the audit trail."
        submitLabel="Approve with override"
        danger
        onSubmit={async () => { await api.finance.approveSupplierInvoice(mismatch!.invoice.id, overrideReason); await invoices.reload(); }}
      >
        <Alert tone="warning">{mismatch?.message}</Alert>
        <Field label="Reason for approving"><Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} required maxLength={500} placeholder="e.g. Delivery DN-902 received but not yet captured" /></Field>
      </FormDialog>
      <FormDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title={voiding ? `Void invoice ${voiding.invoiceNo}` : ''}
        description="Posts a reversing journal dated today and reverses any project costs it created. The invoice stays on record as void."
        submitLabel="Void invoice"
        danger
        onSubmit={async () => { await api.finance.voidSupplierInvoice(voiding!.id, reason); await invoices.reload(); }}
      >
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={250} placeholder="e.g. Duplicate of LS-1043" /></Field>
      </FormDialog>
    </div>
  );
}

export function PartyTable({ title, parties, onAdd, onEdit }: { title: string; parties?: Party[]; onAdd: () => void; onEdit: (p: Party) => void }) {
  return (
    <Card padded={false}>
      <div className="p-5 pb-4"><CardHeader title={title} actions={<Button size="sm" icon={Plus} onClick={onAdd}>Add</Button>} /></div>
      {parties?.length === 0 ? <EmptyState icon={Building2} title={`No ${title.toLowerCase()} yet`} /> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>VAT number</Th><Th>Email</Th><Th>Phone</Th><Th right>Terms</Th><Th /></tr></thead>
          <tbody>
            {parties?.map((p) => (
              <Tr key={p.id}>
                <Td className="font-medium">{p.name}{!p.isActive && <span className="ml-2 text-xs text-ink-3">inactive</span>}</Td>
                <Td mono>{p.vatNumber ?? '—'}</Td>
                <Td className="text-ink-2">{p.email ?? '—'}</Td>
                <Td className="text-ink-2">{p.phone ?? '—'}</Td>
                <Td right className="text-ink-2">{p.paymentTermsDays} days</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" icon={Pencil} aria-label={`Edit ${p.name}`} onClick={() => onEdit(p)} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// =========================================================================== invoice editor

type LineForm = { description: string; amount: string; vatRate: string; mode: 'project' | 'account'; projectId: string; costCodeId: string; category: CostCategory; accountId: string };
const blankLine = (): LineForm => ({ description: '', amount: '', vatRate: '15', mode: 'project', projectId: '', costCodeId: '', category: 'material', accountId: '' });

function SupplierInvoiceDialog({
  invoice,
  onClose,
  onSaved,
  suppliers,
  accounts,
  projects,
}: {
  invoice: SupplierInvoice | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
  suppliers: Party[];
  accounts: Account[];
  projects: Project[];
}) {
  const existing = invoice && invoice !== 'new' ? invoice : null;
  const [head, setHead] = useState({ supplierId: '', invoiceNo: '', invoiceDate: today(), dueDate: '', notes: '' });
  const [lines, setLines] = useState<LineForm[]>([blankLine()]);
  const [codes, setCodes] = useState<Record<string, CostCodeRow[]>>({});
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.isActive && !a.isBank && (a.type === 'expense' || a.type === 'asset') && !['ar_control', 'ap_control', 'vat_input', 'vat_output'].includes(a.systemKey ?? '')), [accounts]);

  useEffect(() => {
    if (!invoice) return;
    if (invoice === 'new') {
      setHead({ supplierId: '', invoiceNo: '', invoiceDate: today(), dueDate: '', notes: '' });
      setLines([blankLine()]);
      return;
    }
    void api.finance.supplierInvoice(invoice.id).then((full) => {
      setHead({ supplierId: full.supplierId, invoiceNo: full.invoiceNo, invoiceDate: full.invoiceDate, dueDate: full.dueDate, notes: full.notes });
      setLines((full.lines ?? []).map((l) => ({
        description: l.description,
        amount: l.amount,
        vatRate: String(Number(l.vatRate)),
        mode: l.projectId ? 'project' : 'account',
        projectId: l.projectId ?? '',
        costCodeId: l.costCodeId ?? '',
        category: l.category ?? 'material',
        accountId: l.accountId ?? '',
      })));
    });
  }, [invoice]);

  // Cost codes for every project used on the invoice.
  useEffect(() => {
    for (const pid of new Set(lines.map((l) => l.projectId).filter(Boolean))) {
      if (!codes[pid]) void api.controls(pid).then((c) => setCodes((prev) => ({ ...prev, [pid]: c.costCodes })), () => setCodes((prev) => ({ ...prev, [pid]: [] })));
    }
  }, [lines, codes]);

  const setLine = (i: number, patch: Partial<LineForm>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const cents = (v: string) => Math.round(Number(v || 0) * 100);
  const subtotal = lines.reduce((s, l) => s + cents(l.amount), 0);
  const vat = lines.reduce((s, l) => s + Math.round((cents(l.amount) * Number(l.vatRate)) / 100), 0);

  const payload = (): SupplierInvoiceLine[] =>
    lines.map((l) => ({
      description: l.description,
      amount: l.amount,
      vatRate: l.vatRate,
      projectId: l.mode === 'project' ? l.projectId : null,
      costCodeId: l.mode === 'project' ? l.costCodeId : null,
      category: l.mode === 'project' ? l.category : null,
      accountId: l.mode === 'account' ? l.accountId : null,
    }));

  return (
    <FormDialog
      open={invoice !== null}
      onClose={onClose}
      title={existing ? `Edit invoice ${existing.invoiceNo}` : 'Capture supplier invoice'}
      description="Saved as a draft. Approving it posts it to the ledger and to project costs."
      submitLabel={existing ? 'Save draft' : 'Save as draft'}
      wide
      onSubmit={async () => {
        const body = { ...head, dueDate: head.dueDate || undefined, lines: payload() };
        if (existing) await api.finance.updateSupplierInvoice(existing.id, { ...body, dueDate: head.dueDate || existing.dueDate });
        else await api.finance.addSupplierInvoice(body);
        onSaved();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Supplier" className="sm:col-span-2">
          <Select value={head.supplierId} onChange={(e) => setHead({ ...head, supplierId: e.target.value })} required>
            <option value="">Choose…</option>
            {suppliers.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Their invoice no."><Input value={head.invoiceNo} onChange={(e) => setHead({ ...head, invoiceNo: e.target.value })} required maxLength={60} /></Field>
        <Field label="Invoice date"><Input type="date" value={head.invoiceDate} onChange={(e) => setHead({ ...head, invoiceDate: e.target.value })} required /></Field>
      </div>

      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={i} className="rounded-lg border border-line p-3">
            <div className="grid gap-3 sm:grid-cols-[2fr_1fr_5rem_auto]">
              <Input placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} required maxLength={300} />
              <AmountInput value={l.amount} onChange={(amount) => setLine(i, { amount })} allowNegative required />
              <Select value={l.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })} aria-label="VAT rate">
                <option value="15">15%</option>
                <option value="0">0%</option>
              </Select>
              <Button type="button" variant="ghost" icon={Trash2} aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, n) => n !== i))} />
            </div>
            <div className="mt-2 grid gap-3 sm:grid-cols-[8rem_1fr_1fr_1fr]">
              <Select value={l.mode} onChange={(e) => setLine(i, { mode: e.target.value as LineForm['mode'] })} aria-label="Line type">
                <option value="project">Project cost</option>
                <option value="account">Overhead</option>
              </Select>
              {l.mode === 'project' ? (
                <>
                  <Select value={l.projectId} onChange={(e) => setLine(i, { projectId: e.target.value, costCodeId: '' })} required aria-label="Project">
                    <option value="">Project…</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
                  </Select>
                  <Select value={l.costCodeId} onChange={(e) => setLine(i, { costCodeId: e.target.value })} required aria-label="Cost code">
                    <option value="">{l.projectId && codes[l.projectId]?.length === 0 ? 'No cost codes on this project' : 'Cost code…'}</option>
                    {(codes[l.projectId] ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}
                  </Select>
                  <Select value={l.category} onChange={(e) => setLine(i, { category: e.target.value as CostCategory })} aria-label="Category">
                    {CATEGORIES.map((c) => <option key={c} value={c}>{sentence(c)}</option>)}
                  </Select>
                </>
              ) : (
                <Select value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} required className="sm:col-span-3" aria-label="Account">
                  <option value="">Expense account…</option>
                  {expenseAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </Select>
              )}
            </div>
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => setLines([...lines, blankLine()])}>Add line</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Notes"><Textarea rows={2} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} maxLength={2000} /></Field>
        <dl className="min-w-56 space-y-1 self-end text-sm">
          <div className="flex justify-between gap-6"><dt className="text-ink-3">Excl. VAT</dt><dd className="num">{zar((subtotal / 100).toFixed(2), true)}</dd></div>
          <div className="flex justify-between gap-6"><dt className="text-ink-3">VAT</dt><dd className="num">{zar((vat / 100).toFixed(2), true)}</dd></div>
          <div className="flex justify-between gap-6 border-t border-line pt-1 font-semibold"><dt>Total</dt><dd className="num">{zar(((subtotal + vat) / 100).toFixed(2), true)}</dd></div>
        </dl>
      </div>
    </FormDialog>
  );
}
