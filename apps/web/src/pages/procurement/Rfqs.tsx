import { useEffect, useState } from 'react';
import { Award, FileQuestion, Plus, Trash2, XCircle } from 'lucide-react';
import { api, type CostCategory, type Party, type Project, type Rfq, type RfqQuote } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, sentence, zar } from '../../lib/format';
import { AmountInput, FormDialog, useAction } from '../../components/forms';
import { Alert, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Skeleton, StatusPill, Table, Td, Textarea, Th, Tr, cx } from '../../components/ui';
import { CATEGORIES, StatusBadge, today, useCostCodes } from './shared';

type FullRfq = Rfq & { quotes: RfqQuote[] };

export function Rfqs({ suppliers, projects, accounts }: { suppliers: Party[]; projects: Project[]; accounts: { id: string; code: string; name: string }[] }) {
  const rfqs = useAsync(() => api.procurement.rfqs(), []);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <>
      <Card padded={false}>
        <div className="p-5 pb-4">
          <CardHeader title="Requests for quotation" subtitle="Ask several suppliers to price the same items, compare like for like, and award the order." actions={<Button size="sm" icon={Plus} onClick={() => setCreating(true)}>New RFQ</Button>} />
        </div>
        {!rfqs.data ? <Skeleton className="m-5 h-24" /> : rfqs.data.length === 0 ? <EmptyState icon={FileQuestion} title="No RFQs yet" /> : (
          <Table>
            <thead><tr><Th>RFQ</Th><Th>Title</Th><Th>Closes</Th><Th>Status</Th><Th right>Quotes</Th></tr></thead>
            <tbody>
              {rfqs.data.map((r) => (
                <Tr key={r.id} onClick={() => setViewing(r.id)}>
                  <Td mono>{r.number}</Td>
                  <Td className="font-medium">{r.title}</Td>
                  <Td className="text-ink-2">{date(r.closingDate)}</Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td right>{typeof r.quotes === 'number' ? r.quotes : r.quotes.length}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NewRfqDialog open={creating} onClose={() => setCreating(false)} projects={projects} onSaved={(r) => { void rfqs.reload(); setViewing(r.id); }} />
      <RfqDetail id={viewing} onClose={() => setViewing(null)} onChanged={() => void rfqs.reload()} suppliers={suppliers} accounts={accounts} />
    </>
  );
}

function NewRfqDialog({ open, onClose, projects, onSaved }: { open: boolean; onClose: () => void; projects: Project[]; onSaved: (r: FullRfq) => void }) {
  const blankItem = { description: '', unit: 'ea', quantity: '' };
  const [head, setHead] = useState({ title: '', projectId: '', closingDate: '' });
  const [items, setItems] = useState([blankItem]);
  useEffect(() => { if (open) { setHead({ title: '', projectId: '', closingDate: '' }); setItems([blankItem]); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog open={open} onClose={onClose} title="New request for quotation" submitLabel="Create RFQ" wide onSubmit={async () => onSaved(await api.procurement.addRfq({ ...head, projectId: head.projectId || null, items }))}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Title" className="sm:col-span-3"><Input value={head.title} onChange={(e) => setHead({ ...head, title: e.target.value })} required maxLength={200} /></Field>
        <Field label="Project" className="sm:col-span-2">
          <Select value={head.projectId} onChange={(e) => setHead({ ...head, projectId: e.target.value })}>
            <option value="">None (overhead)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
          </Select>
        </Field>
        <Field label="Quotes due"><Input type="date" value={head.closingDate} min={today()} onChange={(e) => setHead({ ...head, closingDate: e.target.value })} required /></Field>
      </div>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1fr_5rem_7rem_auto] gap-2">
            <Input placeholder="Item description" value={it.description} onChange={(e) => setItems(items.map((x, n) => (n === i ? { ...x, description: e.target.value } : x)))} required maxLength={300} />
            <Input placeholder="Unit" value={it.unit} onChange={(e) => setItems(items.map((x, n) => (n === i ? { ...x, unit: e.target.value } : x)))} required maxLength={20} />
            <Input placeholder="Quantity" inputMode="decimal" value={it.quantity} onChange={(e) => setItems(items.map((x, n) => (n === i ? { ...x, quantity: e.target.value } : x)))} required pattern="\d{1,15}(\.\d{1,3})?" />
            <Button type="button" variant="ghost" icon={Trash2} aria-label="Remove item" disabled={items.length === 1} onClick={() => setItems(items.filter((_, n) => n !== i))} />
          </div>
        ))}
        <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => setItems([...items, blankItem])}>Add item</Button>
      </div>
    </FormDialog>
  );
}

function RfqDetail({ id, onClose, onChanged, suppliers, accounts }: { id: string | null; onClose: () => void; onChanged: () => void; suppliers: Party[]; accounts: { id: string; code: string; name: string }[] }) {
  const [rfq, setRfq] = useState<FullRfq>();
  const [quoting, setQuoting] = useState(false);
  const [awarding, setAwarding] = useState<RfqQuote | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAction();
  useEffect(() => { setRfq(undefined); setNotice(null); if (id) void api.procurement.rfq(id).then(setRfq); }, [id]);
  const update = (r: FullRfq) => { setRfq(r); onChanged(); };
  const lowest = (itemId: string) => Math.min(...(rfq?.quotes ?? []).map((q) => Number(q.prices[itemId] ?? Infinity)));

  return (
    <Dialog open={id !== null} onClose={onClose} title={rfq ? `${rfq.number} · ${rfq.title}` : 'RFQ'} description={rfq ? `Quotes due ${date(rfq.closingDate)}` : undefined} wide>
      {!rfq ? <Skeleton className="h-48" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={rfq.status} />
            {rfq.awardNote && <span className="text-xs text-ink-3">{rfq.awardNote}</span>}
            {rfq.status === 'open' && (
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="secondary" icon={Plus} onClick={() => setQuoting(true)}>Record quote</Button>
                <Button size="sm" variant="ghost" icon={XCircle} onClick={() => { setReason(''); setCancelling(true); }}>Cancel RFQ</Button>
              </div>
            )}
          </div>
          {notice && <Alert tone="good">{notice}</Alert>}
          {action.error && <Alert>{action.error}</Alert>}
          {rfq.quotes.length === 0 ? <EmptyState icon={FileQuestion} title="No quotes recorded yet" /> : (
            <div className="overflow-x-auto rounded-lg border border-line">
              <Table>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    {rfq.quotes.map((q) => (
                      <Th key={q.id} right>
                        <span className="normal-case">{q.supplierName}</span>
                        {q.bbbeeLevel && <div className="font-normal normal-case">B-BBEE L{q.bbbeeLevel}</div>}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rfq.items?.map((it) => (
                    <Tr key={it.id}>
                      <Td>{it.description}<div className="text-xs text-ink-3">{Number(it.quantity)} {it.unit}</div></Td>
                      {rfq.quotes.map((q) => (
                        <Td key={q.id} right className={cx(q.prices[it.id] !== undefined && Number(q.prices[it.id]) === lowest(it.id) && 'font-semibold text-good-ink')}>
                          {q.prices[it.id] !== undefined ? zar(q.prices[it.id], true) : <span className="text-ink-3">not priced</span>}
                        </Td>
                      ))}
                    </Tr>
                  ))}
                  <Tr className="font-semibold">
                    <Td>Total (excl. VAT)</Td>
                    {rfq.quotes.map((q) => <Td key={q.id} right>{zar(q.total, true)}</Td>)}
                  </Tr>
                  <Tr>
                    <Td className="text-ink-3">Lead time · validity</Td>
                    {rfq.quotes.map((q) => <Td key={q.id} right className="text-xs text-ink-2">{q.leadTimeDays !== null ? `${q.leadTimeDays} days` : '—'} · {q.validUntil ? date(q.validUntil) : '—'}</Td>)}
                  </Tr>
                  <Tr>
                    <Td />
                    {rfq.quotes.map((q) => (
                      <Td key={q.id} right>
                        <div className="flex flex-col items-end gap-1.5">
                          {q.rank === 1 ? <StatusPill status="good">Lowest</StatusPill> : q.complete ? <span className="text-xs text-ink-3">Rank {q.rank}</span> : <StatusPill status="warning">Incomplete</StatusPill>}
                          {rfq.status === 'open' && (
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove quote" onClick={() => void action.run(async () => update(await api.procurement.removeQuote(rfq.id, q.id)))} />
                              <Button size="sm" icon={Award} disabled={!q.complete} onClick={() => setAwarding(q)}>Award</Button>
                            </div>
                          )}
                          {rfq.awardedQuoteId === q.id && <StatusPill status="good">Awarded</StatusPill>}
                        </div>
                      </Td>
                    ))}
                  </Tr>
                </tbody>
              </Table>
            </div>
          )}
          <QuoteDialog rfq={quoting ? rfq : null} suppliers={suppliers} onClose={() => setQuoting(false)} onDone={update} />
          <AwardDialog rfq={rfq} quote={awarding} accounts={accounts} onClose={() => setAwarding(null)} onDone={(r) => { update(r); setNotice('Awarded. The purchase order is saved as a draft under Purchase orders, ready to submit for approval.'); }} />
          <FormDialog open={cancelling} onClose={() => setCancelling(false)} title={`Cancel ${rfq.number}`} submitLabel="Cancel RFQ" danger onSubmit={async () => update(await api.procurement.cancelRfq(rfq.id, reason))}>
            <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} /></Field>
          </FormDialog>
        </div>
      )}
    </Dialog>
  );
}

function QuoteDialog({ rfq, suppliers, onClose, onDone }: { rfq: FullRfq | null; suppliers: Party[]; onClose: () => void; onDone: (r: FullRfq) => void }) {
  const [head, setHead] = useState({ supplierId: '', quoteRef: '', validUntil: '', leadTimeDays: '' });
  const [prices, setPrices] = useState<Record<string, string>>({});
  useEffect(() => { if (rfq) { setHead({ supplierId: '', quoteRef: '', validUntil: '', leadTimeDays: '' }); setPrices({}); } }, [rfq]);
  return (
    <FormDialog
      open={rfq !== null}
      onClose={onClose}
      title="Record a quote"
      description="Leave an item blank if the supplier did not price it. Recording a second quote from the same supplier replaces the first."
      submitLabel="Save quote"
      wide
      onSubmit={async () =>
        onDone(await api.procurement.addQuote(rfq!.id, {
          supplierId: head.supplierId,
          quoteRef: head.quoteRef || undefined,
          validUntil: head.validUntil || undefined,
          leadTimeDays: head.leadTimeDays ? Number(head.leadTimeDays) : undefined,
          prices: Object.fromEntries(Object.entries(prices).filter(([, v]) => v !== '')),
        }))
      }
    >
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Supplier" className="sm:col-span-2">
          <Select value={head.supplierId} onChange={(e) => setHead({ ...head, supplierId: e.target.value })} required>
            <option value="">Choose…</option>
            {suppliers.filter((s) => s.isActive).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Quote ref"><Input value={head.quoteRef} onChange={(e) => setHead({ ...head, quoteRef: e.target.value })} maxLength={60} /></Field>
        <Field label="Lead time (days)"><Input type="number" min={0} value={head.leadTimeDays} onChange={(e) => setHead({ ...head, leadTimeDays: e.target.value })} /></Field>
        <Field label="Valid until"><Input type="date" value={head.validUntil} onChange={(e) => setHead({ ...head, validUntil: e.target.value })} /></Field>
      </div>
      {rfq?.items?.map((it) => (
        <div key={it.id} className="grid grid-cols-[1fr_9rem] items-center gap-3 text-sm">
          <span>{it.description} <span className="text-ink-3">· {Number(it.quantity)} {it.unit}</span></span>
          <AmountInput value={prices[it.id] ?? ''} onChange={(v) => setPrices({ ...prices, [it.id]: v })} />
        </div>
      ))}
    </FormDialog>
  );
}

function AwardDialog({ rfq, quote, accounts, onClose, onDone }: { rfq: FullRfq; quote: RfqQuote | null; accounts: { id: string; code: string; name: string }[]; onClose: () => void; onDone: (r: FullRfq) => void }) {
  const { codes, ensure } = useCostCodes();
  const [form, setForm] = useState({ note: '', costCodeId: '', category: 'material' as CostCategory, accountId: '' });
  useEffect(() => { if (quote) { setForm({ note: '', costCodeId: '', category: 'material', accountId: '' }); if (rfq.projectId) ensure(rfq.projectId); } }, [quote]); // eslint-disable-line react-hooks/exhaustive-deps
  const notCheapest = quote !== null && quote.rank !== 1;
  return (
    <FormDialog
      open={quote !== null}
      onClose={onClose}
      title={quote ? `Award to ${quote.supplierName}` : ''}
      description={quote ? `${zar(quote.total, true)} excl. VAT. A draft purchase order is created at these prices.` : undefined}
      submitLabel="Award and draft order"
      onSubmit={async () => onDone(await api.procurement.award(rfq.id, { quoteId: quote!.id, note: form.note || undefined, costCodeId: form.costCodeId || null, category: form.category, accountId: form.accountId || null }))}
    >
      {rfq.projectId ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Charge to cost code">
            <Select value={form.costCodeId} onChange={(e) => setForm({ ...form, costCodeId: e.target.value })} required>
              <option value="">Choose…</option>
              {(codes[rfq.projectId] ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}
            </Select>
          </Field>
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as CostCategory })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{sentence(c)}</option>)}
            </Select>
          </Field>
        </div>
      ) : (
        <Field label="Charge to account">
          <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} required>
            <option value="">Choose…</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </Field>
      )}
      {notCheapest && <Alert tone="warning">This is not the lowest complete quote. Record why it was chosen; the note is kept in the audit trail.</Alert>}
      <Field label={notCheapest ? 'Reason for choosing this quote' : 'Note (optional)'}><Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} required={notCheapest} maxLength={2000} /></Field>
    </FormDialog>
  );
}
