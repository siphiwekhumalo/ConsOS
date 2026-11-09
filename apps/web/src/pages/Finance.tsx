import { useState } from 'react';
import { FunctionSquare, Landmark, Receipt, Scale, TrendingUp, Wallet } from 'lucide-react';
import { zar } from '../lib/format';
import { Badge, Card, CardHeader, PageHeader, PreviewBanner, Progress, Stat, StatusPill, Table, Tabs, Td, Th, Tr } from '../components/ui';
import { ChartCard, TrendChart } from '../components/charts';
import { cvrByCostCode, cvrMonthly, valuations, variations } from '../demo/data';
import { RulesEngine } from './RulesEngine';

type Tab = 'cvr' | 'valuations' | 'rules';

export function Finance() {
  const [tab, setTab] = useState<Tab>('cvr');
  const last = cvrMonthly[cvrMonthly.length - 1]!;
  const margin = last.value - last.cost;

  return (
    <div>
      <PageHeader
        title="Finance & CVR"
        description="Cost-value reconciliation, FIDIC/NEC valuations and variations, retention and escalation, plus client-specific commercial rules."
        eyebrow={<Badge tone="brand">Module 3</Badge>}
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'cvr', label: 'Cost-value reconciliation', icon: Scale },
          { id: 'valuations', label: 'Valuations & variations', icon: Receipt },
          { id: 'rules', label: 'Rules engine', icon: FunctionSquare },
        ]}
      />

      {tab === 'rules' && <RulesEngine />}

      {tab === 'cvr' && (
        <>
          <PreviewBanner module="CVR ledger" />
          <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Certified value to date" icon={TrendingUp} value={`R${last.value.toFixed(1)}m`} hint="portfolio, cumulative" />
            <Stat label="Actual cost to date" icon={Wallet} value={`R${last.cost.toFixed(1)}m`} hint="labour, material, plant, subcontract" />
            <Stat label="Margin to date" icon={Scale} value={`${margin < 0 ? '−' : ''}R${Math.abs(margin).toFixed(1)}m`} delta={{ value: `${((margin / last.value) * 100).toFixed(1)}%`, good: margin >= 0 }} hint="of value" />
            <Stat label="Retention held by clients" icon={Landmark} value="R11.9m" hint="released at practical completion" />
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
            <ChartCard
              title="Cost vs value"
              subtitle="Cumulative, R million. The lines crossing means work is costing more than it earns."
              table={{ columns: ['Month', 'Value (Rm)', 'Cost (Rm)'], rows: cvrMonthly.map((r) => [r.month, r.value, r.cost]) }}
            >
              <TrendChart
                data={cvrMonthly}
                xKey="month"
                format={(v) => `R${v.toFixed(0)}m`}
                series={[
                  { key: 'value', label: 'Certified value', color: 'var(--series-1)' },
                  { key: 'cost', label: 'Actual cost', color: 'var(--series-2)' },
                ]}
              />
            </ChartCard>

            <Card>
              <CardHeader title="Watch list" subtitle="Cost codes needing attention" />
              <div className="mt-4 space-y-3">
                {cvrByCostCode
                  .filter((c) => c.actual > c.value)
                  .map((c) => (
                    <div key={c.code} className="rounded-lg border border-line p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-ink">{c.code} · {c.name}</span>
                        <StatusPill status="critical">Over value</StatusPill>
                      </div>
                      <div className="mt-1.5 text-[13px] text-ink-2">
                        Cost R{c.actual.toFixed(1)}m against value R{c.value.toFixed(1)}m: loss of R{(c.actual - c.value).toFixed(1)}m.
                      </div>
                    </div>
                  ))}
              </div>
            </Card>
          </div>

          <Card padded={false} className="mt-6">
            <div className="p-5 pb-4">
              <CardHeader title="CVR by cost code" subtitle="Shaft 4 Refurbishment · period ending Nov 2026 · R million" />
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Cost code</Th>
                  <Th right>Budget</Th>
                  <Th right>Value</Th>
                  <Th right>Cost</Th>
                  <Th right>Margin</Th>
                  <Th className="w-48">Cost vs budget</Th>
                </tr>
              </thead>
              <tbody>
                {cvrByCostCode.map((c) => {
                  const m = c.value - c.actual;
                  const used = (c.actual / c.budget) * 100;
                  return (
                    <Tr key={c.code}>
                      <Td><span className="font-mono text-xs text-ink-3">{c.code}</span> <span className="ml-1.5 font-medium">{c.name}</span></Td>
                      <Td right>{c.budget.toFixed(1)}</Td>
                      <Td right>{c.value.toFixed(1)}</Td>
                      <Td right>{c.actual.toFixed(1)}</Td>
                      <Td right className={m < 0 ? 'font-medium text-critical-ink' : 'text-good-ink'}>{m >= 0 ? '+' : '−'}{Math.abs(m).toFixed(1)}</Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Progress value={used} tone={used > 100 ? 'critical' : used > 90 ? 'warning' : 'brand'} />
                          <span className="num w-10 text-right text-xs text-ink-2">{used.toFixed(0)}%</span>
                        </div>
                      </Td>
                    </Tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        </>
      )}

      {tab === 'valuations' && (
        <>
          <PreviewBanner module="valuations" />
          <div className="grid gap-6 xl:grid-cols-2">
            <Card padded={false}>
              <div className="p-5 pb-4"><CardHeader title="Interim payment certificates" subtitle="Shaft 4 Refurbishment · 5% retention" /></div>
              <Table>
                <thead><tr><Th>Certificate</Th><Th>Period</Th><Th right>Gross</Th><Th right>Retention</Th><Th>Status</Th></tr></thead>
                <tbody>
                  {valuations.map((v) => (
                    <Tr key={v.no}>
                      <Td className="font-medium">{v.no}</Td>
                      <Td className="text-ink-2">{v.period}</Td>
                      <Td right>{zar(v.gross)}</Td>
                      <Td right className="text-ink-2">{zar(v.retention)}</Td>
                      <Td>
                        <Badge tone={v.status === 'paid' ? 'good' : v.status === 'certified' ? 'brand' : 'neutral'} dot>
                          <span className="capitalize">{v.status}</span>
                        </Badge>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card padded={false}>
              <div className="p-5 pb-4"><CardHeader title="Variations & compensation events" subtitle="Contractual time bars are tracked automatically" /></div>
              <div className="divide-y divide-line">
                {variations.map((v) => (
                  <div key={v.ref} className="flex items-start gap-3 px-5 py-3.5">
                    <span className="mt-0.5 rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-ink-2">{v.ref}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink">{v.title}</div>
                      <div className="text-xs text-ink-3">{v.form} · {zar(v.value)}</div>
                    </div>
                    {v.daysLeft !== null ? (
                      <StatusPill status={v.daysLeft < 14 ? 'warning' : 'good'}>{v.daysLeft} days left</StatusPill>
                    ) : (
                      <StatusPill status="good">Agreed</StatusPill>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
