import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BarChart3, BookOpen, FileInput, FileOutput, FolderKanban, FunctionSquare, Landmark, Scale, TrendingUp, Wallet } from 'lucide-react';
import { api, type FinanceSettings, type Me, type Role } from '../api';
import { useAsync } from '../lib/useAsync';
import { zar } from '../lib/format';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, Progress, Skeleton, Stat, StatusPill, Table, Tabs, Td, Th, Tr, errorMessage } from '../components/ui';
import { ChartCard, TrendChart } from '../components/charts';
import { RulesEngine } from './RulesEngine';
import { Payables } from './finance/Payables';
import { Receivables } from './finance/Receivables';
import { Banking } from './finance/Banking';
import { Ledger } from './finance/Ledger';
import { Reports } from './finance/Reports';

type Tab = 'cvr' | 'payables' | 'receivables' | 'banking' | 'ledger' | 'reports' | 'rules';
const neg = (v: string | null) => Boolean(v && v.startsWith('-'));
const compact = (v: number) => (Math.abs(v) >= 1e6 ? `R${(v / 1e6).toFixed(1)}m` : `R${(v / 1e3).toFixed(0)}k`);
/** The general ledger, receivables, banking and reports are for finance and leadership. */
const LEDGER: Role[] = ['owner', 'admin', 'finance'];

export function Finance({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('cvr');
  const role = me.user.role;
  const ledger = LEDGER.includes(role);
  const [settings, setSettings] = useState<FinanceSettings>();
  const [setupError, setSetupError] = useState<string | null>(null);
  useEffect(() => {
    if (ledger) void api.finance.settings().then(setSettings, (e) => setSetupError(errorMessage(e)));
  }, [ledger]);
  const ready = settings?.setUp ?? false;
  const needsBooks = tab !== 'cvr' && tab !== 'rules';

  return (
    <div>
      <PageHeader
        title="Finance & CVR"
        description="Project cost-value reconciliation, and the company books: payables, receivables, banking, the general ledger and financial statements."
        eyebrow={<Badge tone="brand">Module 3</Badge>}
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'cvr', label: 'Portfolio CVR', icon: Scale },
          { id: 'payables', label: 'Payables', icon: FileInput },
          ...(ledger
            ? [
                { id: 'receivables' as Tab, label: 'Receivables', icon: FileOutput },
                { id: 'banking' as Tab, label: 'Banking', icon: Landmark },
                { id: 'ledger' as Tab, label: 'Ledger', icon: BookOpen },
                { id: 'reports' as Tab, label: 'Reports', icon: BarChart3 },
              ]
            : []),
          { id: 'rules', label: 'Rules engine', icon: FunctionSquare },
        ]}
      />

      {tab === 'rules' && <RulesEngine />}

      {needsBooks && ledger && !settings && !setupError && <Skeleton className="h-40" />}
      {needsBooks && setupError && <Alert>{setupError}</Alert>}
      {needsBooks && ledger && settings && !ready && (
        <Card className="max-w-2xl">
          <CardHeader title="Set up the books" subtitle="Creates a chart of accounts for a South African contractor: bank, receivables, retention, VAT input and output, payables, equity, contract revenue, contract costs by category (labour, materials, plant, subcontractors, site overheads) and overheads. You can add and rename accounts afterwards." />
          <div className="mt-4 flex justify-end">
            <Button icon={BookOpen} onClick={() => void api.finance.setup().then(setSettings, (e) => setSetupError(errorMessage(e)))}>Create chart of accounts</Button>
          </div>
        </Card>
      )}
      {needsBooks && !ledger && tab === 'payables' && <Payables role={role} />}
      {needsBooks && ready && (
        <>
          {tab === 'payables' && <Payables role={role} />}
          {tab === 'receivables' && <Receivables />}
          {tab === 'banking' && <Banking />}
          {tab === 'ledger' && <Ledger role={role} settings={settings!} onSettings={setSettings} />}
          {tab === 'reports' && <Reports />}
        </>
      )}

      {tab === 'cvr' && <PortfolioCvr />}
    </div>
  );
}

function PortfolioCvr() {
  const portfolio = useAsync(() => api.portfolio(), []);
  const t = portfolio.data?.totals;
  return (
        <>
          {portfolio.error && <Alert>{portfolio.error}</Alert>}
          {!t ? (
            <Skeleton className="h-72" />
          ) : (
            <>
              <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat label="Certified value to date" icon={TrendingUp} value={zar(t.certifiedValue)} hint={`of ${zar(t.revisedContractValue)} revised contract value`} />
                <Stat label="Actual cost to date" icon={Wallet} value={zar(t.costToDate)} hint="labour, material, plant, subcontract" />
                <Stat
                  label="Margin to date"
                  icon={Scale}
                  value={zar(t.marginToDate)}
                  delta={t.marginToDatePct ? { value: `${t.marginToDatePct}%`, good: !neg(t.marginToDate) } : undefined}
                  hint="of certified value"
                />
                <Stat label="Retention held by clients" icon={Landmark} value={zar(t.retentionHeld)} hint="released at completion" />
              </div>

              <ChartCard
                className="mb-6"
                title="Cost vs value, all projects"
                subtitle="Cumulative. When the lines cross, work is costing more than it earns."
                table={{ columns: ['Month', 'Certified value', 'Cost'], rows: portfolio.data!.monthly.map((m) => [m.month, zar(m.value), zar(m.cost)]) }}
              >
                {portfolio.data!.monthly.length === 0 ? (
                  <EmptyState icon={TrendingUp} title="Nothing to chart yet">Post costs and certify valuations on a project to see the trend.</EmptyState>
                ) : (
                  <TrendChart
                    data={portfolio.data!.monthly.map((m) => ({ month: m.month, value: Number(m.value), cost: Number(m.cost) }))}
                    xKey="month"
                    format={compact}
                    series={[
                      { key: 'value', label: 'Certified value', color: 'var(--series-1)' },
                      { key: 'cost', label: 'Actual cost', color: 'var(--series-2)' },
                    ]}
                  />
                )}
              </ChartCard>

              <Card padded={false}>
                <div className="p-5 pb-4">
                  <CardHeader title="CVR by project" subtitle="Forecast margin = revised contract value − (cost to date + remaining budget)" />
                </div>
                {portfolio.data!.projects.length === 0 ? (
                  <EmptyState icon={FolderKanban} title="No projects yet" />
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <Th>Project</Th>
                        <Th right>Revised contract</Th>
                        <Th right>Certified</Th>
                        <Th right>Cost</Th>
                        <Th right>Margin to date</Th>
                        <Th right>Forecast margin</Th>
                        <Th className="w-40">Cost vs budget</Th>
                        <Th>Watch</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {portfolio.data!.projects.map(({ project: p, summary: s, overrunCodes }) => {
                        const used = Number(s.costCompletePct ?? 0);
                        return (
                          <Tr key={p.id}>
                            <Td>
                              <Link to={`/projects/${p.id}`} className="hover:underline">
                                <span className="font-mono text-xs text-ink-3">{p.code}</span> <span className="ml-1.5 font-medium">{p.name}</span>
                              </Link>
                            </Td>
                            <Td right>{zar(s.revisedContractValue)}</Td>
                            <Td right>{zar(s.certifiedValue)}</Td>
                            <Td right>{zar(s.costToDate)}</Td>
                            <Td right className={neg(s.marginToDate) ? 'font-medium text-critical-ink' : undefined}>
                              {zar(s.marginToDate)}{s.marginToDatePct && <span className="ml-1 text-xs text-ink-3">{s.marginToDatePct}%</span>}
                            </Td>
                            <Td right className={neg(s.forecastMargin) ? 'font-medium text-critical-ink' : undefined}>
                              {zar(s.forecastMargin)}{s.forecastMarginPct && <span className="ml-1 text-xs text-ink-3">{s.forecastMarginPct}%</span>}
                            </Td>
                            <Td>
                              <div className="flex items-center gap-2">
                                <Progress value={used} tone={used > 100 ? 'critical' : used > 90 ? 'warning' : 'brand'} />
                                <span className="num w-12 text-right text-xs text-ink-2">{s.costCompletePct ? `${s.costCompletePct}%` : '—'}</span>
                              </div>
                            </Td>
                            <Td>
                              {neg(s.forecastMargin) ? (
                                <StatusPill status="critical">Forecast loss</StatusPill>
                              ) : overrunCodes > 0 ? (
                                <StatusPill status="warning">{overrunCodes} code{overrunCodes > 1 ? 's' : ''} over</StatusPill>
                              ) : neg(s.marginToDate) ? (
                                <StatusPill status="warning">Cost ahead of value</StatusPill>
                              ) : (
                                <span className="text-xs text-ink-3">—</span>
                              )}
                            </Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                )}
              </Card>
            </>
          )}
        </>
  );
}
