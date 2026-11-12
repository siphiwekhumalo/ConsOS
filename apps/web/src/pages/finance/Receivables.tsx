import { useEffect, useMemo, useState } from 'react';
import { Banknote, Building2, FileText, Pencil, Plus, Receipt, Send, Trash2, XCircle } from 'lucide-react';
import { api, type Account, type CustomerInvoice, type Party, type Project, type ValuationView } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, zar } from '../../lib/format';
import { AmountInput, FormDialog, useAction } from '../../components/forms';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Select, Skeleton, StatusPill, Table, Tabs, Td, Textarea, Th, Tr } from '../../components/ui';
import { InvoiceStatus, PartyDialog, PaymentDialog, minus, overdue, today } from './shared';
import { PartyTable } from './Payables';

type Sub = 'invoices' | 'customers' | 'receipts';

export function Receivables() {
  const [sub, setSub] = useState<Sub>('invoices');
  const invoices = useAsync(() => api.finance.customerInvoices(), []);
  const customers = useAsync(() => api.finance.customers(), []);
  const accounts = useAsync(() => api.finance.accounts(), []);
  const receipts = useAsync(() => api.finance.payments('in'), []);
  const projects = useAsync(() => api.projects(), []);
  const [editing, setEditing] = useState<CustomerInvoice | 'new' | null>(null);
  const [fromValuation, setFromValuation] = useState(false);
  const [party, setParty] = useState<Party | 'new' | null>(null);
  const [receiving, setReceiving] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<CustomerInvoice | null>(null);
  const [reason, setReason] = useState('');
  const action = useAction();

  const open = (invoices.data ?? []).filter((i) => i.status === 'issued' || i.status === 'part_paid');
  const owed = open.reduce((s, i) => s + Number(minus(i.total, i.amountPaid)), 0);
  const overdueCount = open.filter((i) => overdue(i.dueDate, i.status)).length;

  return (
    <div className="space-y-6">
      <Tabs<Sub>
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'invoices', label: 'Tax invoices', icon: FileText, count: invoices.data?.length },
          { id: 'customers', label: 'Customers', icon: Building2, count: customers.data?.length },
          { id: 'receipts', label: 'Money received', icon: Banknote, count: receipts.data?.length },
        ]}
      />
      {action.error && <Alert>{action.error}</Alert>}

      {sub === 'invoices' && (
        <Card padded={false}>
          <div className="p-5 pb-4">
            <CardHeader
              title="Tax invoices"
              subtitle={`${zar(owed.toFixed(2))} owed by customers on ${open.length} invoice${open.length === 1 ? '' : 's'}${overdueCount ? ` · ${overdueCount} overdue` : ''}`}
              actions={
                <>
                  <Button size="sm" variant="secondary" icon={Banknote} disabled={open.length === 0} onClick={() => setReceiving('')}>Record receipt</Button>
                  <Button size="sm" variant="secondary" icon={Receipt} disabled={!customers.data?.length} onClick={() => setFromValuation(true)}>Invoice a valuation</Button>
                  <Button size="sm" icon={Plus} disabled={!customers.data?.length} title={customers.data?.length ? undefined : 'Add a customer first'} onClick={() => setEditing('new')}>New invoice</Button>
                </>
              }
            />
          </div>
          {!invoices.data ? <Skeleton className="m-5 h-24" /> : invoices.data.length === 0 ? (
            <EmptyState icon={FileText} title="No invoices yet">Invoice each certified valuation, or raise an invoice for other work. Numbers are assigned in sequence when issued.</EmptyState>
          ) : (
            <Table>
              <thead><tr><Th>Number</Th><Th>Customer</Th><Th>Date</Th><Th>Due</Th><Th>Status</Th><Th right>Total</Th><Th right>Outstanding</Th><Th /></tr></thead>
              <tbody>
                {invoices.data.map((i) => (
                  <Tr key={i.id}>
                    <Td mono>{i.number}{i.valuationId && <div className="font-sans text-xs text-ink-3">Valuation{i.customerRef ? ` ${i.customerRef}` : ''}</div>}</Td>
                    <Td className="font-medium">{i.customerName}</Td>
                    <Td className="whitespace-nowrap text-ink-2">{date(i.invoiceDate)}</Td>
                    <Td className="whitespace-nowrap">{overdue(i.dueDate, i.status) ? <StatusPill status="critical">{date(i.dueDate)}</StatusPill> : <span className="text-ink-2">{date(i.dueDate)}</span>}</Td>
                    <Td><InvoiceStatus status={i.status} /></Td>
                    <Td right>{zar(i.total, true)}</Td>
                    <Td right className="text-ink-2">{i.status === 'void' || i.status === 'draft' ? '—' : zar(minus(i.total, i.amountPaid), true)}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        {i.status === 'draft' && (
                          <>
                            {!i.valuationId && <Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" onClick={() => setEditing(i)} />}
                            <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={() => void action.run(async () => { await api.finance.deleteCustomerInvoice(i.id); await invoices.reload(); })} />
                            <Button size="sm" icon={Send} loading={action.busy} onClick={() => void action.run(async () => { await api.finance.issueCustomerInvoice(i.id); await invoices.reload(); })}>Issue</Button>
                          </>
                        )}
                        {(i.status === 'issued' || i.status === 'part_paid') && <Button size="sm" variant="secondary" onClick={() => setReceiving(i.customerId)}>Receive</Button>}
                        {i.status === 'issued' && <Button size="sm" variant="ghost" icon={XCircle} onClick={() => { setReason(''); setVoiding(i); }}>Void</Button>}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {sub === 'customers' && <PartyTable title="Customers" parties={customers.data} onAdd={() => setParty('new')} onEdit={setParty} />}

      {sub === 'receipts' && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Money received" subtitle="A receipt that settles a valuation invoice in full marks that payment certificate paid." /></div>
          {receipts.data?.length === 0 ? <EmptyState icon={Banknote} title="No receipts yet" /> : (
            <Table>
              <thead><tr><Th>No.</Th><Th>Date</Th><Th>Customer</Th><Th>Bank</Th><Th>Reference</Th><Th right>Amount</Th></tr></thead>
              <tbody>
                {receipts.data?.map((p) => (
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

      <CustomerInvoiceDialog invoice={editing} onClose={() => setEditing(null)} onSaved={() => void invoices.reload()} customers={customers.data ?? []} accounts={accounts.data ?? []} projects={projects.data ?? []} />
      <ValuationInvoiceDialog open={fromValuation} onClose={() => setFromValuation(false)} onSaved={() => void invoices.reload()} customers={customers.data ?? []} projects={projects.data ?? []} invoices={invoices.data ?? []} />
      <PartyDialog kind="customer" party={party === 'new' ? null : party} open={party !== null} onClose={() => setParty(null)} onSaved={() => void customers.reload()} />
      <PaymentDialog
        direction="in"
        open={receiving !== null}
        initialPartyId={receiving || undefined}
        onClose={() => setReceiving(null)}
        onSaved={() => void Promise.all([invoices.reload(), receipts.reload()])}
        parties={customers.data ?? []}
        banks={(accounts.data ?? []).filter((a) => a.isBank && a.isActive)}
        openInvoices={open.map((i) => ({ id: i.id, partyId: i.customerId, label: i.number, dueDate: i.dueDate, outstanding: minus(i.total, i.amountPaid) }))}
      />
      <FormDialog
        open={voiding !== null}
        onClose={() => setVoiding(null)}
        title={voiding ? `Cancel ${voiding.number}` : ''}
        description="Posts a credit note (a reversing journal dated today). The invoice number stays used and the invoice is kept as void."
        submitLabel="Cancel invoice"
        danger
        onSubmit={async () => { await api.finance.voidCustomerInvoice(voiding!.id, reason); await invoices.reload(); }}
      >
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={250} /></Field>
      </FormDialog>
    </div>
  );
}

// =========================================================================== editors

type LineForm = { description: string; accountId: string; amount: string; vatRate: string };

function CustomerInvoiceDialog({ invoice, onClose, onSaved, customers, accounts, projects }: { invoice: CustomerInvoice | 'new' | null; onClose: () => void; onSaved: () => void; customers: Party[]; accounts: Account[]; projects: Project[] }) {
  const existing = invoice && invoice !== 'new' ? invoice : null;
  const income = useMemo(() => accounts.filter((a) => a.isActive && (a.type === 'income' || a.systemKey === 'retention_receivable')), [accounts]);
  const defaultAccount = income.find((a) => a.systemKey === 'contract_revenue')?.id ?? income[0]?.id ?? '';
  const blankLine = (): LineForm => ({ description: '', accountId: defaultAccount, amount: '', vatRate: '15' });
  const [head, setHead] = useState({ customerId: '', invoiceDate: today(), dueDate: '', projectId: '', customerRef: '', notes: '' });
  const [lines, setLines] = useState<LineForm[]>([]);

  useEffect(() => {
    if (!invoice) return;
    if (invoice === 'new') {
      setHead({ customerId: '', invoiceDate: today(), dueDate: '', projectId: '', customerRef: '', notes: '' });
      setLines([blankLine()]);
      return;
    }
    void api.finance.customerInvoice(invoice.id).then((full) => {
      setHead({ customerId: full.customerId, invoiceDate: full.invoiceDate, dueDate: full.dueDate, projectId: full.projectId ?? '', customerRef: full.customerRef ?? '', notes: full.notes });
      setLines((full.lines ?? []).map((l) => ({ description: l.description, accountId: l.accountId, amount: l.amount, vatRate: String(Number(l.vatRate)) })));
    });
  }, [invoice]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (i: number, patch: Partial<LineForm>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const cents = (v: string) => Math.round(Number(v || 0) * 100);
  const subtotal = lines.reduce((s, l) => s + cents(l.amount), 0);
  const vat = lines.reduce((s, l) => s + Math.round((cents(l.amount) * Number(l.vatRate)) / 100), 0);

  return (
    <FormDialog
      open={invoice !== null}
      onClose={onClose}
      title={existing ? 'Edit draft invoice' : 'New tax invoice'}
      description="Saved as a draft. Issuing it assigns the next invoice number and posts it to the ledger."
      submitLabel="Save draft"
      wide
      onSubmit={async () => {
        const body = { customerId: head.customerId, invoiceDate: head.invoiceDate, projectId: head.projectId || null, customerRef: head.customerRef || null, notes: head.notes, lines };
        if (existing) await api.finance.updateCustomerInvoice(existing.id, { ...body, dueDate: head.dueDate || existing.dueDate });
        else await api.finance.addCustomerInvoice({ ...body, dueDate: head.dueDate || undefined });
        onSaved();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Customer" className="sm:col-span-2">
          <Select value={head.customerId} onChange={(e) => setHead({ ...head, customerId: e.target.value })} required>
            <option value="">Choose…</option>
            {customers.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Invoice date"><Input type="date" value={head.invoiceDate} onChange={(e) => setHead({ ...head, invoiceDate: e.target.value })} required /></Field>
        <Field label="Due date" hint="Blank: customer terms"><Input type="date" value={head.dueDate} onChange={(e) => setHead({ ...head, dueDate: e.target.value })} /></Field>
        <Field label="Project" className="sm:col-span-2">
          <Select value={head.projectId} onChange={(e) => setHead({ ...head, projectId: e.target.value })}>
            <option value="">None</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
        </Field>
        <Field label="Customer order / PO" className="sm:col-span-2"><Input value={head.customerRef} onChange={(e) => setHead({ ...head, customerRef: e.target.value })} maxLength={100} /></Field>
      </div>
      <div className="space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1.4fr_1fr_5rem_auto]">
            <Input placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} required maxLength={300} />
            <Select value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} required aria-label="Account">
              {income.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </Select>
            <AmountInput value={l.amount} onChange={(amount) => setLine(i, { amount })} allowNegative required />
            <Select value={l.vatRate} onChange={(e) => setLine(i, { vatRate: e.target.value })} aria-label="VAT rate">
              <option value="15">15%</option>
              <option value="0">0%</option>
            </Select>
            <Button type="button" variant="ghost" icon={Trash2} aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, n) => n !== i))} />
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => setLines([...lines, blankLine()])}>Add line</Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Field label="Notes (printed on the invoice)"><Textarea rows={2} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} maxLength={2000} /></Field>
        <dl className="min-w-56 space-y-1 self-end text-sm">
          <div className="flex justify-between gap-6"><dt className="text-ink-3">Excl. VAT</dt><dd className="num">{zar((subtotal / 100).toFixed(2), true)}</dd></div>
          <div className="flex justify-between gap-6"><dt className="text-ink-3">VAT</dt><dd className="num">{zar((vat / 100).toFixed(2), true)}</dd></div>
          <div className="flex justify-between gap-6 border-t border-line pt-1 font-semibold"><dt>Total</dt><dd className="num">{zar(((subtotal + vat) / 100).toFixed(2), true)}</dd></div>
        </dl>
      </div>
    </FormDialog>
  );
}

function ValuationInvoiceDialog({ open, onClose, onSaved, customers, projects, invoices }: { open: boolean; onClose: () => void; onSaved: () => void; customers: Party[]; projects: Project[]; invoices: CustomerInvoice[] }) {
  const [projectId, setProjectId] = useState('');
  const [valuations, setValuations] = useState<ValuationView[]>([]);
  const [valuationId, setValuationId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(today());
  useEffect(() => {
    if (open) { setProjectId(''); setValuations([]); setValuationId(''); setCustomerId(''); setInvoiceDate(today()); }
  }, [open]);
  useEffect(() => {
    if (!projectId) return setValuations([]);
    const invoiced = new Set(invoices.filter((i) => i.valuationId && i.status !== 'void').map((i) => i.valuationId));
    void api.controls(projectId).then(
      (c) => setValuations(c.valuations.filter((v) => (v.status === 'certified' || v.status === 'paid') && !invoiced.has(v.id))),
      () => setValuations([]),
    );
  }, [projectId, invoices]);
  const v = valuations.find((x) => x.id === valuationId);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Invoice a certified valuation"
      description="Drafts the tax invoice for the payment certificate: work done this period less retention, plus 15% VAT on the amount due."
      submitLabel="Create draft invoice"
      onSubmit={async () => { await api.finance.invoiceValuation({ valuationId, customerId, invoiceDate }); onSaved(); }}
    >
      <Field label="Project">
        <Select value={projectId} onChange={(e) => { setProjectId(e.target.value); setValuationId(''); }} required>
          <option value="">Choose…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
        </Select>
      </Field>
      <Field label="Certificate" hint={projectId && valuations.length === 0 ? 'No certified valuations waiting to be invoiced on this project' : undefined}>
        <Select value={valuationId} onChange={(e) => setValuationId(e.target.value)} required disabled={!valuations.length}>
          <option value="">Choose…</option>
          {valuations.map((x) => <option key={x.id} value={x.id}>Valuation {x.valuationNo} · {x.certificateRef} · due {zar(x.amountDue, true)}</option>)}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer">
          <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
            <option value="">Choose…</option>
            {customers.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Invoice date"><Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} required /></Field>
      </div>
      {v && <Alert tone="info">Amount due excl. VAT {zar(v.amountDue, true)} · VAT {zar((Math.round(Number(v.amountDue) * 15) / 100).toFixed(2), true)} (approximately; worked out exactly per line).</Alert>}
    </FormDialog>
  );
}
