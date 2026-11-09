import { BadgeCheck, Building2, FileCheck2, Fingerprint, Users, Wallet } from 'lucide-react';
import { num, zar } from '../../lib/format';
import { Badge, Button, Card, CardHeader, PageHeader, PreviewBanner, Stat, StatusPill, Table, Td, Th, Tr } from '../../components/ui';
import { BarList } from '../../components/charts';
import { councils, filings, payRun, workforce } from '../../demo/data';

export function Payroll() {
  const lines: [string, string, string?][] = [
    ['Gross remuneration', payRun.gross],
    ['PAYE', payRun.paye, 'SARS'],
    ['UIF (employee + employer)', payRun.uif, 'UIF'],
    ['SDL', payRun.sdl, 'SARS'],
    ['ETI credit claimed', `-${payRun.eti}`, 'SARS'],
  ];
  return (
    <div>
      <PageHeader
        title="HRIS & Payroll"
        description="Statutory South African payroll (PAYE, UIF, SDL, ETI), bargaining-council wage rules and SARS e@syFile-ready filings."
        eyebrow={<Badge tone="brand">Module 1</Badge>}
        actions={<><Button variant="secondary" icon={Fingerprint}>Time & attendance</Button><Button icon={BadgeCheck}>Review pay run</Button></>}
      />
      <PreviewBanner module="payroll" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Employees on payroll" icon={Users} value={num(payRun.employees)} hint={payRun.period} />
        <Stat label="Gross pay" icon={Wallet} value={zar(payRun.gross)} hint="this period" />
        <Stat label="Net pay" icon={Wallet} value={zar(payRun.net)} hint="to 1 284 bank accounts" />
        <Stat label="Bargaining councils" icon={Building2} value="3" hint="MEIBC · BCCEI · SAFCEC" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
        <Card>
          <CardHeader title={`Pay run · ${payRun.period}`} subtitle="Calculated against the 2026/27 SARS PAYE tables" actions={<StatusPill status="warning">Awaiting approval</StatusPill>} />
          <dl className="mt-4 divide-y divide-line">
            {lines.map(([k, v, to]) => (
              <div key={k} className="flex items-center justify-between py-2.5 text-sm">
                <dt className="text-ink-2">{k} {to && <span className="ml-1 text-xs text-ink-3">→ {to}</span>}</dt>
                <dd className="num font-medium text-ink">{zar(v)}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between py-3 text-sm">
              <dt className="font-semibold text-ink">Net pay</dt>
              <dd className="num text-base font-semibold text-ink">{zar(payRun.net)}</dd>
            </div>
          </dl>
          <div className="mt-2 flex gap-2">
            <Button size="sm">Approve & release</Button>
            <Button size="sm" variant="secondary">Payslips preview</Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Workforce mix" subtitle="Headcount by engagement type" />
          <div className="mt-5">
            <BarList rows={workforce.map((w) => ({ label: w.group, value: w.count }))} format={(v) => num(v)} />
          </div>
          <p className="mt-5 text-xs text-ink-3">Site labour signs in by biometric terminal or the field app; hours flow into the pay run.</p>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="SARS filings" subtitle="Validated files ready for e@syFile" /></div>
          <Table>
            <thead><tr><Th>Return</Th><Th>Period</Th><Th>Due</Th><Th>Status</Th></tr></thead>
            <tbody>
              {filings.map((f) => (
                <Tr key={f.form + f.period}>
                  <Td className="font-medium"><span className="inline-flex items-center gap-2"><FileCheck2 className="size-4 text-ink-3" />{f.form}</span></Td>
                  <Td className="text-ink-2">{f.period}</Td>
                  <Td className="text-ink-2">{f.due}</Td>
                  <Td>{f.status === 'submitted' ? <StatusPill status="good">Submitted</StatusPill> : f.status === 'pending' ? <StatusPill status="warning">Due soon</StatusPill> : <Badge>Not started</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Bargaining council compliance" subtitle="Minimum wages, allowances and levies" /></div>
          <Table>
            <thead><tr><Th>Council</Th><Th right>Employees</Th><Th>Next increase</Th><Th>Status</Th></tr></thead>
            <tbody>
              {councils.map((c) => (
                <Tr key={c.name}>
                  <Td className="font-medium">{c.name}</Td>
                  <Td right>{num(c.employees)}</Td>
                  <Td className="text-ink-2">{c.nextIncrease}</Td>
                  <Td>{c.status === 'compliant' ? <StatusPill status="good">Compliant</StatusPill> : <StatusPill status="warning">Review rates</StatusPill>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
