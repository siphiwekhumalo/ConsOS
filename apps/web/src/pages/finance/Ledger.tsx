import { useEffect, useState } from 'react';
import { BookOpen, Lock, Plus, Settings, Trash2, Undo2 } from 'lucide-react';
import { api, type Account, type AccountLedger, type AccountType, type FinanceSettings, type JournalView, type Role } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, label, zar } from '../../lib/format';
import { AmountInput, FormDialog } from '../../components/forms';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Skeleton, Table, Tabs, Td, Th, Tr, cx } from '../../components/ui';
import { neg, today } from './shared';

type Sub = 'accounts' | 'journals' | 'settings';
const TYPES: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];

export function Ledger({ role, settings, onSettings }: { role: Role; settings: FinanceSettings; onSettings: (s: FinanceSettings) => void }) {
  const [sub, setSub] = useState<Sub>('accounts');
  const accounts = useAsync(() => api.finance.accounts(), []);
  const journals = useAsync(() => api.finance.journals(), []);
  const [viewing, setViewing] = useState<Account | null>(null);
  const [adding, setAdding] = useState(false);
  const [journaling, setJournaling] = useState(false);
  const [reversing, setReversing] = useState<JournalView | null>(null);
  const [reason, setReason] = useState('');

  return (
    <div className="space-y-6">
      <Tabs<Sub>
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'accounts', label: 'Chart of accounts', icon: BookOpen, count: accounts.data?.length },
          { id: 'journals', label: 'Journals', icon: Undo2, count: journals.data?.length },
          { id: 'settings', label: 'Settings & period lock', icon: Settings },
        ]}
      />

      {sub === 'accounts' && (
        <Card padded={false}>
          <div className="p-5 pb-4">
            <CardHeader title="Chart of accounts" subtitle="Balances to date in each account's natural direction. Select an account to see its postings." actions={<Button size="sm" icon={Plus} onClick={() => setAdding(true)}>Account</Button>} />
          </div>
          {!accounts.data ? <Skeleton className="m-5 h-40" /> : (
            <Table>
              <thead><tr><Th>Code</Th><Th>Name</Th><Th>Type</Th><Th right>Balance</Th><Th /></tr></thead>
              <tbody>
                {accounts.data.map((a) => (
                  <Tr key={a.id} onClick={() => setViewing(a)} className={cx(!a.isActive && 'opacity-50')}>
                    <Td mono>{a.code}</Td>
                    <Td className="font-medium">
                      {a.name}
                      {a.isBank && <Badge className="ml-2" tone="brand">Bank</Badge>}
                      {a.systemKey && <Badge className="ml-2">System</Badge>}
                      {!a.isActive && <Badge className="ml-2">Inactive</Badge>}
                    </Td>
                    <Td className="capitalize text-ink-2">{a.type}</Td>
                    <Td right className={neg(a.balance) ? 'text-critical-ink' : undefined}>{a.hasPostings ? zar(a.balance, true) : '—'}</Td>
                    <Td className="text-right" >
                      {!a.systemKey && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => { e.stopPropagation(); void api.finance.updateAccount(a.id, { isActive: !a.isActive }).then(() => accounts.reload()); }}
                        >
                          {a.isActive ? 'Deactivate' : 'Activate'}
                        </Button>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {sub === 'journals' && (
        <Card padded={false}>
          <div className="p-5 pb-4">
            <CardHeader
              title="Journals"
              subtitle="Every posting, newest first. Journals are never edited: correct a manual journal by reversing it. Document journals are corrected by voiding the document."
              actions={<Button size="sm" icon={Plus} onClick={() => setJournaling(true)}>Manual journal</Button>}
            />
          </div>
          {journals.data?.length === 0 ? <EmptyState icon={BookOpen} title="No journals yet" /> : (
            <div className="divide-y divide-line">
              {journals.data?.map((j) => (
                <div key={j.id} className="px-5 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-ink-3">J{j.journalNo}</span>
                    <span className="text-sm font-medium text-ink">{j.description}</span>
                    <Badge>{label(j.source)}</Badge>
                    {j.reversed && <Badge tone="warning">Reversed</Badge>}
                    <span className="ml-auto text-xs text-ink-3">{date(j.entryDate)}</span>
                    {(j.source === 'manual' || j.source === 'bank') && !j.reversed && !j.reversesId && (
                      <Button size="sm" variant="ghost" icon={Undo2} onClick={() => { setReason(''); setReversing(j); }}>Reverse</Button>
                    )}
                  </div>
                  <table className="mt-2 w-full text-[13px]">
                    <tbody>
                      {j.lines.map((l) => (
                        <tr key={l.id}>
                          <td className={cx('py-0.5 text-ink-2', Number(l.credit) > 0 && 'pl-6')}>{l.accountCode} · {l.accountName}{l.description ? <span className="text-ink-3"> — {l.description}</span> : null}</td>
                          <td className="num w-32 text-right">{Number(l.debit) > 0 ? zar(l.debit, true) : ''}</td>
                          <td className="num w-32 text-right">{Number(l.credit) > 0 ? zar(l.credit, true) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {sub === 'settings' && <SettingsCard role={role} settings={settings} onSaved={onSettings} />}

      <AccountLedgerDialog account={viewing} onClose={() => setViewing(null)} />
      <AddAccountDialog open={adding} onClose={() => setAdding(false)} onSaved={() => void accounts.reload()} />
      <JournalDialog open={journaling} onClose={() => setJournaling(false)} accounts={accounts.data ?? []} onSaved={() => void Promise.all([journals.reload(), accounts.reload()])} />
      <FormDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title={reversing ? `Reverse journal J${reversing.journalNo}` : ''}
        description="Posts the exact opposite entry, dated today. Both stay on record."
        submitLabel="Post reversal"
        danger
        onSubmit={async () => { await api.finance.reverseJournal(reversing!.id, reason); await Promise.all([journals.reload(), accounts.reload()]); }}
      >
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={250} /></Field>
      </FormDialog>
    </div>
  );
}

function SettingsCard({ role, settings, onSaved }: { role: Role; settings: FinanceSettings; onSaved: (s: FinanceSettings) => void }) {
  const [form, setForm] = useState({ lockedThrough: settings.lockedThrough ?? '', vatNumber: settings.vatNumber ?? '', fiscalYearStartMonth: String(settings.fiscalYearStartMonth) });
  const [msg, setMsg] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const save = async () => {
    setMsg(null);
    try {
      onSaved(await api.finance.updateSettings({ lockedThrough: form.lockedThrough || null, vatNumber: form.vatNumber || null, fiscalYearStartMonth: Number(form.fiscalYearStartMonth) }));
      setMsg({ tone: 'good', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'critical', text: (err as Error).message });
    }
  };
  return (
    <Card className="max-w-2xl space-y-4">
      <CardHeader title="Finance settings" subtitle="Closing a period stops anything being posted on or before that date. Only an owner can re-open a closed period." />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Books closed up to" hint={settings.lockedThrough ? `Currently ${date(settings.lockedThrough)}` : 'Nothing closed yet'}>
          <Input type="date" value={form.lockedThrough} onChange={(e) => setForm({ ...form, lockedThrough: e.target.value })} />
        </Field>
        <Field label="VAT number"><Input value={form.vatNumber} onChange={(e) => setForm({ ...form, vatNumber: e.target.value })} pattern="4\d{9}" /></Field>
        <Field label="Financial year starts">
          <Select value={form.fiscalYearStartMonth} onChange={(e) => setForm({ ...form, fiscalYearStartMonth: e.target.value })}>
            {months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </Select>
        </Field>
      </div>
      {role !== 'owner' && settings.lockedThrough && <p className="text-xs text-ink-3">You can move the lock date forward; moving it back needs an owner.</p>}
      {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      <div className="flex justify-end"><Button icon={Lock} onClick={() => void save()}>Save settings</Button></div>
    </Card>
  );
}

function AccountLedgerDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<AccountLedger>();
  useEffect(() => {
    if (!account) return;
    setData(undefined);
    void api.finance.accountLedger(account.id, from || undefined, to || undefined).then(setData);
  }, [account, from, to]);
  return (
    <Dialog open={account !== null} onClose={onClose} title={account ? `${account.code} · ${account.name}` : ''} description="Postings with a running balance" wide>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      {!data ? <Skeleton className="h-40" /> : (
        <div className="max-h-[55vh] overflow-auto rounded-lg border border-line">
          <Table>
            <thead><tr><Th>Date</Th><Th>Journal</Th><Th>Description</Th><Th right>Debit</Th><Th right>Credit</Th><Th right>Balance</Th></tr></thead>
            <tbody>
              <Tr><Td className="text-ink-3" /><Td /><Td className="text-ink-3">Opening balance</Td><Td /><Td /><Td right>{zar(data.openingBalance, true)}</Td></Tr>
              {data.lines.map((l) => (
                <Tr key={l.id}>
                  <Td className="whitespace-nowrap text-ink-2">{date(l.entryDate)}</Td>
                  <Td mono>J{l.journalNo}</Td>
                  <Td>{l.description}</Td>
                  <Td right>{Number(l.debit) > 0 ? zar(l.debit, true) : ''}</Td>
                  <Td right>{Number(l.credit) > 0 ? zar(l.credit, true) : ''}</Td>
                  <Td right className="font-medium">{zar(l.balance, true)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Dialog>
  );
}

function AddAccountDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ code: '', name: '', type: 'expense' as AccountType, isBank: false });
  useEffect(() => { if (open) setForm({ code: '', name: '', type: 'expense', isBank: false }); }, [open]);
  return (
    <FormDialog open={open} onClose={onClose} title="New account" submitLabel="Add account" onSubmit={async () => { await api.finance.addAccount({ ...form, isBank: form.type === 'asset' && form.isBank }); onSaved(); }}>
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <Field label="Code" hint="5xxx expenses count as contract costs"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required pattern="[0-9A-Za-z.\-]{1,20}" /></Field>
        <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={200} /></Field>
      </div>
      <Field label="Type">
        <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AccountType })}>
          {TYPES.map((t) => <option key={t} value={t} className="capitalize">{t}</option>)}
        </Select>
      </Field>
      {form.type === 'asset' && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={form.isBank} onChange={(e) => setForm({ ...form, isBank: e.target.checked })} /> This is a bank account (statements can be imported and reconciled)
        </label>
      )}
    </FormDialog>
  );
}

type JLine = { accountId: string; debit: string; credit: string; description: string };

function JournalDialog({ open, onClose, accounts, onSaved }: { open: boolean; onClose: () => void; accounts: Account[]; onSaved: () => void }) {
  const blank = (): JLine => ({ accountId: '', debit: '', credit: '', description: '' });
  const [head, setHead] = useState({ entryDate: today(), description: '' });
  const [lines, setLines] = useState<JLine[]>([blank(), blank()]);
  useEffect(() => { if (open) { setHead({ entryDate: today(), description: '' }); setLines([blank(), blank()]); } }, [open]);
  const set = (i: number, patch: Partial<JLine>) => setLines(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const cents = (v: string) => Math.round(Number(v || 0) * 100);
  const dr = lines.reduce((s, l) => s + cents(l.debit), 0);
  const cr = lines.reduce((s, l) => s + cents(l.credit), 0);
  const active = accounts.filter((a) => a.isActive);
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Manual journal"
      description="For opening balances, accruals, depreciation and corrections. Debits must equal credits."
      submitLabel={dr === cr && dr > 0 ? 'Post journal' : 'Debits and credits must balance'}
      wide
      onSubmit={async () => {
        await api.finance.addJournal({
          ...head,
          lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: l.debit || undefined, credit: l.credit || undefined, description: l.description || undefined })),
        });
        onSaved();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <Field label="Date"><Input type="date" value={head.entryDate} onChange={(e) => setHead({ ...head, entryDate: e.target.value })} required /></Field>
        <Field label="Description"><Input value={head.description} onChange={(e) => setHead({ ...head, description: e.target.value })} required maxLength={300} /></Field>
      </div>
      <div className="space-y-2">
        <div className="grid grid-cols-[2fr_1fr_1fr_1.4fr_auto] gap-2 text-xs font-medium text-ink-3"><span>Account</span><span>Debit</span><span>Credit</span><span>Line note</span><span /></div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[2fr_1fr_1fr_1.4fr_auto] gap-2">
            <Select value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} aria-label="Account">
              <option value="">Account…</option>
              {active.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
            </Select>
            <AmountInput value={l.debit} onChange={(debit) => set(i, { debit, credit: debit ? '' : l.credit })} />
            <AmountInput value={l.credit} onChange={(credit) => set(i, { credit, debit: credit ? '' : l.debit })} />
            <Input value={l.description} onChange={(e) => set(i, { description: e.target.value })} maxLength={300} />
            <Button type="button" variant="ghost" icon={Trash2} aria-label="Remove line" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, n) => n !== i))} />
          </div>
        ))}
        <div className="flex items-center justify-between">
          <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => setLines([...lines, blank()])}>Add line</Button>
          <span className={cx('num text-sm', dr === cr ? 'text-good-ink' : 'text-critical-ink')}>
            Dr {zar((dr / 100).toFixed(2), true)} · Cr {zar((cr / 100).toFixed(2), true)}
          </span>
        </div>
      </div>
    </FormDialog>
  );
}
