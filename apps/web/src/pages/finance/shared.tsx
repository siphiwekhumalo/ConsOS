import { useEffect, useState } from 'react';
import { api, type Account, type Party, type PartyInput } from '../../api';
import { zar } from '../../lib/format';
import { AmountInput, FormDialog } from '../../components/forms';
import { Badge, Field, Input, Select, Table, Td, Th, Tr } from '../../components/ui';

export const today = () => new Date().toISOString().slice(0, 10);
export const neg = (v: string | null | undefined) => Boolean(v && v.startsWith('-'));
/** Display-only subtraction of two decimal strings, in cents (no float drift at 2dp). */
export const minus = (a: string, b: string) => ((Math.round(Number(a) * 100) - Math.round(Number(b) * 100)) / 100).toFixed(2);

const STATUS_TONE: Record<string, 'neutral' | 'brand' | 'good' | 'warning' | 'critical'> = {
  draft: 'neutral',
  approved: 'brand',
  issued: 'brand',
  part_paid: 'warning',
  paid: 'good',
  void: 'critical',
};

export function InvoiceStatus({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>
      <span className="capitalize">{status.replace('_', ' ')}</span>
    </Badge>
  );
}

export const overdue = (dueDate: string, status: string) =>
  (status === 'approved' || status === 'issued' || status === 'part_paid') && dueDate < today();

/** Create or edit a supplier or customer. */
export function PartyDialog({
  kind,
  party,
  open,
  onClose,
  onSaved,
  via = 'finance',
}: {
  kind: 'supplier' | 'customer';
  party: Party | null;
  open: boolean;
  onClose: () => void;
  onSaved: (p: Party) => void;
  /** Which module's endpoints to use for suppliers. */
  via?: 'finance' | 'procurement';
}) {
  const blank = { name: '', vatNumber: '', registrationNo: '', email: '', phone: '', paymentTermsDays: '30', billingAddress: '', bbbeeLevel: '', bbbeeExpiry: '', cidbGrading: '', isSubcontractor: false };
  const [form, setForm] = useState(blank);
  useEffect(() => {
    if (!open) return;
    setForm(
      party
        ? {
            name: party.name,
            vatNumber: party.vatNumber ?? '',
            registrationNo: party.registrationNo ?? '',
            email: party.email ?? '',
            phone: party.phone ?? '',
            paymentTermsDays: String(party.paymentTermsDays),
            billingAddress: party.billingAddress ?? '',
            bbbeeLevel: party.bbbeeLevel ? String(party.bbbeeLevel) : '',
            bbbeeExpiry: party.bbbeeExpiry ?? '',
            cidbGrading: party.cidbGrading ?? '',
            isSubcontractor: party.isSubcontractor ?? false,
          }
        : blank,
    );
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const body: PartyInput = {
    name: form.name,
    vatNumber: form.vatNumber || null,
    registrationNo: form.registrationNo || null,
    email: form.email || null,
    phone: form.phone || null,
    paymentTermsDays: Number(form.paymentTermsDays || 30),
    ...(kind === 'customer'
      ? { billingAddress: form.billingAddress || null }
      : {
          bbbeeLevel: form.bbbeeLevel ? Number(form.bbbeeLevel) : null,
          bbbeeExpiry: form.bbbeeExpiry || null,
          cidbGrading: form.cidbGrading || null,
          isSubcontractor: form.isSubcontractor,
        }),
  };
  const suppliersApi = via === 'procurement' ? api.procurement : api.finance;
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={party ? `Edit ${party.name}` : `New ${kind}`}
      submitLabel={party ? 'Save' : `Add ${kind}`}
      wide
      onSubmit={async () => {
        const saved =
          kind === 'supplier'
            ? party ? await suppliersApi.updateSupplier(party.id, body) : await suppliersApi.addSupplier(body)
            : party ? await api.finance.updateCustomer(party.id, body) : await api.finance.addCustomer(body);
        onSaved(saved);
      }}
    >
      <Field label="Name"><Input value={form.name} onChange={set('name')} required maxLength={200} /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="VAT number" hint="10 digits, starts with 4"><Input value={form.vatNumber} onChange={set('vatNumber')} pattern="4\d{9}" /></Field>
        <Field label="Company registration"><Input value={form.registrationNo} onChange={set('registrationNo')} maxLength={40} /></Field>
        <Field label="Payment terms (days)"><Input type="number" min={0} max={365} value={form.paymentTermsDays} onChange={set('paymentTermsDays')} /></Field>
        <Field label="Email"><Input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={set('phone')} maxLength={40} /></Field>
      </div>
      {kind === 'customer' && <Field label="Billing address"><Input value={form.billingAddress} onChange={set('billingAddress')} maxLength={500} /></Field>}
      {kind === 'supplier' && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="B-BBEE level" hint="Blank if non-compliant or unknown">
            <Select value={form.bbbeeLevel} onChange={set('bbbeeLevel')}>
              <option value="">None</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((l) => <option key={l} value={l}>Level {l}</option>)}
            </Select>
          </Field>
          <Field label="Certificate expires"><Input type="date" value={form.bbbeeExpiry} onChange={set('bbbeeExpiry')} /></Field>
          <Field label="CIDB grading" hint="e.g. 6CE"><Input value={form.cidbGrading} onChange={(e) => setForm({ ...form, cidbGrading: e.target.value.toUpperCase() })} pattern="[1-9][A-Z]{1,3}" /></Field>
          <label className="flex items-center gap-2 text-sm text-ink sm:col-span-3">
            <input type="checkbox" checked={form.isSubcontractor} onChange={(e) => setForm({ ...form, isSubcontractor: e.target.checked })} /> Subcontractor (can be given subcontracts with payment certificates)
          </label>
        </div>
      )}
    </FormDialog>
  );
}

/**
 * Pay a supplier (out) or record money received from a customer (in), allocated
 * across that party's open invoices.
 */
export function PaymentDialog({
  direction,
  open,
  onClose,
  onSaved,
  parties,
  banks,
  openInvoices,
  initialPartyId,
}: {
  direction: 'in' | 'out';
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  parties: Party[];
  banks: Account[];
  openInvoices: { id: string; partyId: string; label: string; dueDate: string; outstanding: string }[];
  initialPartyId?: string;
}) {
  const [partyId, setPartyId] = useState('');
  const [bankId, setBankId] = useState('');
  const [date, setDate] = useState(today());
  const [reference, setReference] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) return;
    setPartyId(initialPartyId ?? '');
    setBankId(banks[0]?.id ?? '');
    setDate(today());
    setReference('');
    setAlloc({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const invoices = openInvoices.filter((i) => i.partyId === partyId);
  const total = Object.values(alloc).reduce((s, v) => s + Math.round(Number(v || 0) * 100), 0) / 100;
  const word = direction === 'out' ? 'Payment' : 'Receipt';

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={direction === 'out' ? 'Pay a supplier' : 'Record money received'}
      description={direction === 'out' ? 'Settles the invoices you allocate it to. Posts Dr trade payables, Cr bank.' : 'Settles the invoices you allocate it to. Posts Dr bank, Cr trade receivables.'}
      submitLabel={`Record ${word.toLowerCase()} of ${zar(total.toFixed(2), true)}`}
      wide
      onSubmit={async () => {
        const allocations = Object.entries(alloc)
          .filter(([, v]) => Number(v) > 0)
          .map(([invoiceId, amount]) => ({ invoiceId, amount }));
        if (allocations.length === 0) throw new Error('Allocate the payment to at least one invoice');
        await api.finance.addPayment({ direction, partyId, bankAccountId: bankId, paymentDate: date, reference: reference || undefined, allocations });
        onSaved();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={direction === 'out' ? 'Supplier' : 'Customer'}>
          <Select value={partyId} onChange={(e) => { setPartyId(e.target.value); setAlloc({}); }} required>
            <option value="">Choose…</option>
            {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Bank account">
          <Select value={bankId} onChange={(e) => setBankId(e.target.value)} required>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
          </Select>
        </Field>
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Reference" hint="As it will show on the bank statement"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
      </div>
      {partyId && (
        invoices.length === 0 ? (
          <p className="text-sm text-ink-2">No open invoices for this {direction === 'out' ? 'supplier' : 'customer'}.</p>
        ) : (
          <div className="rounded-lg border border-line">
            <Table>
              <thead><tr><Th>Invoice</Th><Th>Due</Th><Th right>Outstanding</Th><Th right>Allocate</Th></tr></thead>
              <tbody>
                {invoices.map((i) => (
                  <Tr key={i.id}>
                    <Td className="font-medium">{i.label}</Td>
                    <Td className="text-ink-2">{i.dueDate}</Td>
                    <Td right>{zar(i.outstanding, true)}</Td>
                    <Td className="w-44">
                      <div className="flex items-center gap-1">
                        <AmountInput value={alloc[i.id] ?? ''} onChange={(v) => setAlloc({ ...alloc, [i.id]: v })} />
                        <button type="button" className="text-xs font-medium text-brand" onClick={() => setAlloc({ ...alloc, [i.id]: i.outstanding })}>All</button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )
      )}
    </FormDialog>
  );
}
