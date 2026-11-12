import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, FileUp, Landmark, Link2, Sparkles, Unlink, Wand2 } from 'lucide-react';
import { api, type Account, type BankWorkspace } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, zar } from '../../lib/format';
import { FormDialog, useAction } from '../../components/forms';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Select, Skeleton, Stat, Table, Td, Th, Tr } from '../../components/ui';
import { neg } from './shared';

export function Banking() {
  const accounts = useAsync(() => api.finance.accounts(), []);
  const banks = (accounts.data ?? []).filter((a) => a.isBank);
  const [bankId, setBankId] = useState('');
  const [ws, setWs] = useState<BankWorkspace>();
  const [notice, setNotice] = useState<string | null>(null);
  const [posting, setPosting] = useState<BankWorkspace['unmatchedStatement'][number] | null>(null);
  const [matching, setMatching] = useState<BankWorkspace['unmatchedStatement'][number] | null>(null);
  const action = useAction();
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!bankId && banks[0]) setBankId(banks[0].id);
  }, [banks, bankId]);
  useEffect(() => {
    if (bankId) void api.finance.bank(bankId).then(setWs, () => setWs(undefined));
  }, [bankId]);

  const importFile = (file?: File) =>
    file &&
    action.run(async () => {
      setNotice(null);
      const lines = parseStatementCsv(await file.text());
      const next = await api.finance.importStatement(bankId, lines);
      setWs(next);
      setNotice(`${next.imported} line${next.imported === 1 ? '' : 's'} imported${next.duplicates ? `, ${next.duplicates} already imported earlier` : ''}.`);
    });

  if (accounts.data && banks.length === 0) return <EmptyState icon={Landmark} title="No bank accounts">Add an asset account marked as a bank account under Ledger.</EmptyState>;
  if (!ws) return <Skeleton className="h-72" />;
  const reconciled = ws.reconciledBalance === ws.statementTotal && ws.unmatchedStatement.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Bank account" className="w-72">
          <Select value={bankId} onChange={(e) => setBankId(e.target.value)}>
            {banks.map((b) => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
          </Select>
        </Field>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" icon={FileUp} loading={action.busy} onClick={() => picker.current?.click()}>Import statement (CSV)</Button>
          <Button icon={Wand2} loading={action.busy} disabled={!ws.unmatchedStatement.length} onClick={() => void action.run(async () => { const next = await api.finance.autoMatch(bankId); setWs(next); setNotice(`${next.matched} line${next.matched === 1 ? '' : 's'} matched automatically.`); })}>Auto-match</Button>
          <input ref={picker} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
      </div>
      {action.error && <Alert>{action.error}</Alert>}
      {notice && <Alert tone="good">{notice}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Balance per ledger" icon={Landmark} value={zar(ws.bookBalance, true)} />
        <Stat label="Balance per statements" icon={FileUp} value={zar(ws.statementTotal, true)} hint={ws.lastStatementDate ? `to ${date(ws.lastStatementDate)}` : 'nothing imported yet'} />
        <Stat label="In ledger, not yet on statement" icon={ArrowLeftRight} value={zar(ws.outstanding.inLedgerNotOnStatement, true)} hint={`${ws.unmatchedLedger.length} entries`} />
        <Stat
          label="Reconciliation"
          icon={Link2}
          value={reconciled ? 'Reconciled' : zar(ws.outstanding.onStatementNotInLedger, true)}
          hint={reconciled ? 'every statement line is matched' : `${ws.unmatchedStatement.length} statement lines to match`}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="On the statement, not in the ledger" subtitle="Match each to a ledger entry, or post it (bank charges, interest, debit orders)." /></div>
          {ws.unmatchedStatement.length === 0 ? <EmptyState icon={Sparkles} title="All statement lines matched" /> : (
            <Table>
              <thead><tr><Th>Date</Th><Th>Description</Th><Th right>Amount</Th><Th /></tr></thead>
              <tbody>
                {ws.unmatchedStatement.map((l) => (
                  <Tr key={l.id}>
                    <Td className="whitespace-nowrap text-ink-2">{date(l.txnDate)}</Td>
                    <Td>{l.description}{l.reference && <div className="text-xs text-ink-3">{l.reference}</div>}</Td>
                    <Td right className={neg(l.amount) ? 'text-critical-ink' : 'text-good-ink'}>{zar(l.amount, true)}</Td>
                    <Td className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="secondary" onClick={() => setMatching(l)}>Match</Button>
                        <Button size="sm" variant="ghost" onClick={() => setPosting(l)}>Post</Button>
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="In the ledger, not on the statement" subtitle="Payments and receipts the bank has not shown yet." /></div>
          {ws.unmatchedLedger.length === 0 ? <EmptyState icon={Sparkles} title="Nothing outstanding" /> : (
            <Table>
              <thead><tr><Th>Date</Th><Th>Journal</Th><Th>Description</Th><Th right>Amount</Th></tr></thead>
              <tbody>
                {ws.unmatchedLedger.map((l) => (
                  <Tr key={l.id}>
                    <Td className="whitespace-nowrap text-ink-2">{date(l.entryDate)}</Td>
                    <Td mono>J{l.journalNo}</Td>
                    <Td>{l.description}</Td>
                    <Td right className={neg(l.amount) ? 'text-critical-ink' : 'text-good-ink'}>{zar(l.amount, true)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      {ws.recentlyMatched.length > 0 && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Recently matched" /></div>
          <Table>
            <thead><tr><Th>Date</Th><Th>Description</Th><Th right>Amount</Th><Th /></tr></thead>
            <tbody>
              {ws.recentlyMatched.slice(0, 20).map((l) => (
                <Tr key={l.id}>
                  <Td className="text-ink-2">{date(l.txnDate)}</Td>
                  <Td>{l.description}</Td>
                  <Td right>{zar(l.amount, true)}</Td>
                  <Td className="text-right"><Button size="sm" variant="ghost" icon={Unlink} onClick={() => void action.run(async () => setWs(await api.finance.unmatch(l.id)))}>Unmatch</Button></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <MatchDialog line={matching} candidates={ws.unmatchedLedger} onClose={() => setMatching(null)} onDone={setWs} />
      <PostDialog line={posting} accounts={accounts.data ?? []} bankId={bankId} onClose={() => setPosting(null)} onDone={setWs} />
    </div>
  );
}

function MatchDialog({ line, candidates, onClose, onDone }: { line: BankWorkspace['unmatchedStatement'][number] | null; candidates: BankWorkspace['unmatchedLedger']; onClose: () => void; onDone: (ws: BankWorkspace) => void }) {
  const [choice, setChoice] = useState('');
  const same = line ? candidates.filter((c) => Number(c.amount) === Number(line.amount)) : [];
  useEffect(() => setChoice(same[0]?.id ?? ''), [line]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog
      open={line !== null}
      onClose={onClose}
      title="Match statement line"
      description={line ? `${date(line.txnDate)} · ${line.description} · ${zar(line.amount, true)}` : undefined}
      submitLabel="Match"
      onSubmit={async () => onDone(await api.finance.match(line!.id, choice))}
    >
      {same.length === 0 ? (
        <Alert tone="warning">No unmatched ledger entry for exactly {line && zar(line.amount, true)}. Record the payment or receipt first, or post this line directly.</Alert>
      ) : (
        <Field label="Ledger entry">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)} required>
            {same.map((c) => <option key={c.id} value={c.id}>{c.entryDate} · J{c.journalNo} · {c.description}</option>)}
          </Select>
        </Field>
      )}
    </FormDialog>
  );
}

function PostDialog({ line, accounts, bankId, onClose, onDone }: { line: BankWorkspace['unmatchedStatement'][number] | null; accounts: Account[]; bankId: string; onClose: () => void; onDone: (ws: BankWorkspace) => void }) {
  const choices = accounts.filter((a) => a.isActive && a.id !== bankId && !['ar_control', 'ap_control'].includes(a.systemKey ?? ''));
  const [accountId, setAccountId] = useState('');
  const [description, setDescription] = useState('');
  useEffect(() => {
    if (!line) return;
    setAccountId(choices.find((a) => a.systemKey === 'bank_charges')?.id ?? '');
    setDescription(line.description);
  }, [line]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog
      open={line !== null}
      onClose={onClose}
      title="Post statement line"
      description="Creates the ledger entry against another account and matches it. Customer receipts and supplier payments belong under Receivables and Payables, so they settle invoices."
      submitLabel="Post and match"
      onSubmit={async () => onDone(await api.finance.postStatementLine(line!.id, accountId, description))}
    >
      <Field label="Account">
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
          <option value="">Choose…</option>
          {choices.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
        </Select>
      </Field>
      <Field label="Description"><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
    </FormDialog>
  );
}

// =========================================================================== CSV

/**
 * Read a bank statement CSV with a header row. Recognises date, description /
 * narrative, reference, and either one amount column or separate debit and
 * credit columns. Dates: YYYY-MM-DD, YYYY/MM/DD, DD/MM/YYYY or YYYYMMDD.
 */
export function parseStatementCsv(text: string) {
  const rows = text.split(/\r?\n/).filter((r) => r.trim()).map(splitCsv);
  const headerAt = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /amount|debit|credit/i.test(c)));
  if (headerAt < 0) throw new Error('The CSV needs a header row with a Date column and an Amount (or Debit and Credit) column');
  const header = rows[headerAt]!.map((h) => h.toLowerCase());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const iDate = col(/date/);
  const iDesc = col(/desc|narr|detail|particular|transaction/);
  const iRef = col(/ref/);
  const iAmount = col(/^amount|amount$/);
  const iDebit = col(/debit/);
  const iCredit = col(/credit/);
  if (iDesc < 0) throw new Error('The CSV needs a Description column');
  const out = rows.slice(headerAt + 1).flatMap((r) => {
    const txnDate = toIso(r[iDate] ?? '');
    if (!txnDate) return [];
    let amount = iAmount >= 0 ? (r[iAmount] ?? '') : '';
    if (iAmount < 0) {
      const dr = (r[iDebit] ?? '').replace(/[\s,R-]/g, '');
      const cr = (r[iCredit] ?? '').replace(/[\s,R]/g, '');
      amount = Number(dr) ? `-${dr}` : cr;
    }
    if (!amount || Number(amount.replace(/[^\d.-]/g, '')) === 0) return [];
    return [{ txnDate, description: (r[iDesc] ?? '').slice(0, 300) || 'Bank transaction', reference: iRef >= 0 ? (r[iRef] ?? '').slice(0, 100) || undefined : undefined, amount }];
  });
  if (out.length === 0) throw new Error('No transactions found in the file');
  return out;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function toIso(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`; // South African banks: day first
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
