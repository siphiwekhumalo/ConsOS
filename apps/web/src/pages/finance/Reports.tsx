import { useEffect, useState, type ReactNode } from 'react';
import { Download } from 'lucide-react';
import { api, type Ageing, type BalanceSheet, type IncomeStatement, type ReportSection, type TrialBalance, type VatReport } from '../../api';
import { date, zar } from '../../lib/format';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Skeleton, StatusPill, Table, Td, Th, Tr, cx, errorMessage } from '../../components/ui';
import { neg, today } from './shared';

type Report = 'income' | 'balance' | 'trial' | 'ar' | 'ap' | 'vat';
const REPORTS: { id: Report; label: string; range: boolean }[] = [
  { id: 'income', label: 'Income statement', range: true },
  { id: 'balance', label: 'Balance sheet', range: false },
  { id: 'trial', label: 'Trial balance', range: false },
  { id: 'ar', label: 'Aged receivables', range: false },
  { id: 'ap', label: 'Aged payables', range: false },
  { id: 'vat', label: 'VAT201 summary', range: true },
];
const AGE_COLS = [['current', 'Not yet due'], ['d1_30', '1–30 days'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90_plus', '90+']] as const;

type Data =
  | { kind: 'income'; r: IncomeStatement }
  | { kind: 'balance'; r: BalanceSheet }
  | { kind: 'trial'; r: TrialBalance }
  | { kind: 'ar' | 'ap'; r: Ageing }
  | { kind: 'vat'; r: VatReport };

export function Reports() {
  const [report, setReport] = useState<Report>('income');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(today());
  const [data, setData] = useState<Data>();
  const [error, setError] = useState<string | null>(null);
  const meta = REPORTS.find((r) => r.id === report)!;

  useEffect(() => {
    setData(undefined);
    setError(null);
    const f = from || undefined;
    const load: Promise<Data> =
      report === 'income' ? api.finance.incomeStatement(f, to).then((r) => ({ kind: 'income', r }))
      : report === 'balance' ? api.finance.balanceSheet(to).then((r) => ({ kind: 'balance', r }))
      : report === 'trial' ? api.finance.trialBalance(to).then((r) => ({ kind: 'trial', r }))
      : report === 'ar' ? api.finance.agedReceivables(to).then((r) => ({ kind: 'ar' as const, r }))
      : report === 'ap' ? api.finance.agedPayables(to).then((r) => ({ kind: 'ap' as const, r }))
      : api.finance.vat(f, to).then((r) => ({ kind: 'vat', r }));
    load.then(setData, (e) => setError(errorMessage(e)));
  }, [report, from, to]);

  const rows = data ? toRows(data) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Report" className="w-56">
          <Select value={report} onChange={(e) => setReport(e.target.value as Report)}>
            {REPORTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
        </Field>
        {meta.range && <Field label="From" hint={report === 'income' ? 'Blank: start of financial year' : 'Blank: start of month'}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>}
        <Field label={meta.range ? 'To' : 'As at'}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></Field>
        <Button className="ml-auto" variant="secondary" icon={Download} disabled={!rows.length} onClick={() => downloadCsv(`${meta.label} ${to}.csv`, rows)}>Download CSV</Button>
      </div>
      {error && <Alert>{error}</Alert>}
      {!data && !error && <Skeleton className="h-72" />}

      {data?.kind === 'income' && (
        <Statement title="Income statement" subtitle={`${date(data.r.from)} to ${date(data.r.to)}`}>
          <Section title="Revenue" s={data.r.revenue} />
          <Section title="Cost of sales (contract costs)" s={data.r.costOfSales} />
          <Total label={`Gross profit${data.r.grossMarginPct ? ` (${data.r.grossMarginPct}%)` : ''}`} value={data.r.grossProfit} />
          <Section title="Overheads" s={data.r.operatingExpenses} />
          <Total label="Net profit before tax" value={data.r.netProfit} strong />
        </Statement>
      )}

      {data?.kind === 'balance' && (
        <Statement title="Balance sheet" subtitle={`As at ${date(data.r.asAt)}`} check={data.r.balanced}>
          <Section title="Assets" s={data.r.assets} />
          <Section title="Liabilities" s={data.r.liabilities} />
          <Section title="Equity" s={{ rows: [...data.r.equity.rows, { id: 'profit', code: '', name: 'Accumulated profit (not yet closed to retained earnings)', amount: data.r.equity.accumulatedProfit }], total: data.r.equity.total }} />
          <Total label="Liabilities and equity" value={data.r.liabilitiesAndEquity} strong />
        </Statement>
      )}

      {data?.kind === 'trial' && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Trial balance" subtitle={`As at ${date(data.r.asAt)}`} actions={<StatusPill status={data.r.balanced ? 'good' : 'critical'}>{data.r.balanced ? 'Balances' : 'Out of balance'}</StatusPill>} /></div>
          <Table>
            <thead><tr><Th>Code</Th><Th>Account</Th><Th right>Debit</Th><Th right>Credit</Th></tr></thead>
            <tbody>
              {data.r.rows.map((r) => (
                <Tr key={r.id}><Td mono>{r.code}</Td><Td>{r.name}</Td><Td right>{Number(r.debit) ? zar(r.debit, true) : ''}</Td><Td right>{Number(r.credit) ? zar(r.credit, true) : ''}</Td></Tr>
              ))}
              <Tr className="font-semibold"><Td /><Td>Total</Td><Td right>{zar(data.r.totalDebit, true)}</Td><Td right>{zar(data.r.totalCredit, true)}</Td></Tr>
            </tbody>
          </Table>
        </Card>
      )}

      {(data?.kind === 'ar' || data?.kind === 'ap') && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title={data.kind === 'ar' ? 'Aged receivables' : 'Aged payables'} subtitle={`Outstanding at ${date(data.r.asAt)}, by days past due date`} /></div>
          <Table>
            <thead><tr><Th>{data.kind === 'ar' ? 'Customer' : 'Supplier'}</Th>{AGE_COLS.map(([k, l]) => <Th key={k} right>{l}</Th>)}<Th right>Total</Th></tr></thead>
            <tbody>
              {data.r.rows.map((r) => (
                <Tr key={r.partyId}>
                  <Td className="font-medium">{r.partyName}</Td>
                  {AGE_COLS.map(([k]) => <Td key={k} right className={cx(k !== 'current' && Number(r[k]) > 0 && 'text-critical-ink')}>{Number(r[k]) ? zar(r[k], true) : '—'}</Td>)}
                  <Td right className="font-semibold">{zar(r.total, true)}</Td>
                </Tr>
              ))}
              <Tr className="font-semibold"><Td>Total</Td>{AGE_COLS.map(([k]) => <Td key={k} right>{zar(data.r.totals[k], true)}</Td>)}<Td right>{zar(data.r.totals.total, true)}</Td></Tr>
            </tbody>
          </Table>
        </Card>
      )}

      {data?.kind === 'vat' && (
        <Statement title="VAT201 summary" subtitle={`${date(data.r.from)} to ${date(data.r.to)} · a working paper: check it before you submit on SARS eFiling`}>
          {[
            ['Standard-rated supplies (excl. VAT)', data.r.standardRatedSupplies],
            ['Zero-rated supplies', data.r.zeroRatedSupplies],
            ['Output VAT', data.r.outputVat],
            ['Standard-rated purchases (excl. VAT)', data.r.standardRatedPurchases],
            ['Input VAT', data.r.inputVat],
          ].map(([k, v]) => <Line key={k} label={k!} value={v!} />)}
          <Total label={neg(data.r.netVat) ? 'VAT refundable by SARS' : 'VAT payable to SARS'} value={data.r.netVat.replace('-', '')} strong />
        </Statement>
      )}
    </div>
  );
}

function Statement({ title, subtitle, check, children }: { title: string; subtitle: string; check?: boolean; children: ReactNode }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader title={title} subtitle={subtitle} actions={check !== undefined && <StatusPill status={check ? 'good' : 'critical'}>{check ? 'Balances' : 'Does not balance'}</StatusPill>} />
      <div className="mt-4 space-y-1 text-sm">{children}</div>
    </Card>
  );
}

function Section({ title, s }: { title: string; s: ReportSection }) {
  return (
    <div className="pb-2">
      <div className="pt-3 text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</div>
      {s.rows.length === 0 && <div className="py-1 text-ink-3">None</div>}
      {s.rows.map((r) => <Line key={r.id} label={`${r.code ? `${r.code} · ` : ''}${r.name}`} value={r.amount} indent />)}
      <Line label={`Total ${title.toLowerCase()}`} value={s.total} bold />
    </div>
  );
}

function Line({ label, value, indent, bold }: { label: string; value: string; indent?: boolean; bold?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-6 py-0.5', indent && 'pl-3', bold && 'border-t border-line pt-1 font-medium')}>
      <span className={indent ? 'text-ink-2' : 'text-ink'}>{label}</span>
      <span className={cx('num', neg(value) && 'text-critical-ink')}>{zar(value, true)}</span>
    </div>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx('flex justify-between gap-6 border-t-2 border-line-strong py-2', strong ? 'text-base font-semibold' : 'font-medium')}>
      <span>{label}</span>
      <span className={cx('num', neg(value) && 'text-critical-ink')}>{zar(value, true)}</span>
    </div>
  );
}

// =========================================================================== CSV export

function toRows(d: Data): (string | number)[][] {
  const section = (name: string, s: ReportSection) => [[name, '', ''], ...s.rows.map((r) => ['', `${r.code} ${r.name}`.trim(), r.amount]), [`Total ${name.toLowerCase()}`, '', s.total]];
  switch (d.kind) {
    case 'income':
      return [['Section', 'Account', 'Amount'], ...section('Revenue', d.r.revenue), ...section('Cost of sales', d.r.costOfSales), ['Gross profit', '', d.r.grossProfit], ...section('Overheads', d.r.operatingExpenses), ['Net profit', '', d.r.netProfit]];
    case 'balance':
      return [['Section', 'Account', 'Amount'], ...section('Assets', d.r.assets), ...section('Liabilities', d.r.liabilities), ...section('Equity', d.r.equity), ['', 'Accumulated profit', d.r.equity.accumulatedProfit], ['Liabilities and equity', '', d.r.liabilitiesAndEquity]];
    case 'trial':
      return [['Code', 'Account', 'Debit', 'Credit'], ...d.r.rows.map((r) => [r.code, r.name, r.debit, r.credit]), ['', 'Total', d.r.totalDebit, d.r.totalCredit]];
    case 'ar':
    case 'ap':
      return [['Party', ...AGE_COLS.map(([, l]) => l), 'Total'], ...d.r.rows.map((r) => [r.partyName, ...AGE_COLS.map(([k]) => r[k]), r.total]), ['Total', ...AGE_COLS.map(([k]) => d.r.totals[k]), d.r.totals.total]];
    case 'vat':
      return [['Item', 'Amount'], ['Standard-rated supplies', d.r.standardRatedSupplies], ['Zero-rated supplies', d.r.zeroRatedSupplies], ['Output VAT', d.r.outputVat], ['Standard-rated purchases', d.r.standardRatedPurchases], ['Input VAT', d.r.inputVat], ['Net VAT (positive = payable)', d.r.netVat]];
  }
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
