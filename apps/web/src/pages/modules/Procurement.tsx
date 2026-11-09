import { ClipboardCheck, FileCheck, PackageCheck, Plus, ShoppingCart } from 'lucide-react';
import { zar } from '../../lib/format';
import { Badge, Button, Card, CardHeader, PageHeader, PreviewBanner, Stat, StatusPill, Table, Td, Th, Tr } from '../../components/ui';
import { BarList, ChartCard, ORDINAL } from '../../components/charts';
import { bbbeeSpend, matching, requisitions } from '../../demo/data';

export function Procurement() {
  return (
    <div>
      <PageHeader
        title="Supply Chain & Procurement"
        description="Requisitions through configurable approval matrices, three-way invoice matching, and live B-BBEE preferential procurement tracking."
        eyebrow={<Badge tone="brand">Module 5</Badge>}
        actions={<Button icon={Plus}>New requisition</Button>}
      />
      <PreviewBanner module="procurement" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Awaiting approval" icon={ClipboardCheck} value="2" hint={`${zar('2287000')} total`} />
        <Stat label="Open purchase orders" icon={ShoppingCart} value="41" hint="R 18.6m committed" />
        <Stat label="Invoices to match" icon={FileCheck} value="3" hint="2 exceptions" />
        <Stat label="B-BBEE recognised spend" icon={PackageCheck} value="91.4%" hint="of measured procurement" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Purchase requisitions" subtitle="Site agent → project manager → director, by value threshold" /></div>
          <Table>
            <thead><tr><Th>Req.</Th><Th>Item</Th><Th>Project</Th><Th right>Amount</Th><Th>Approval</Th></tr></thead>
            <tbody>
              {requisitions.map((r) => (
                <Tr key={r.no}>
                  <Td mono className="text-ink-2">{r.no}</Td>
                  <Td className="font-medium">{r.item}</Td>
                  <Td mono className="text-ink-2">{r.project}</Td>
                  <Td right>{zar(r.amount)}</Td>
                  <Td>{r.status === 'approved' ? <StatusPill status="good">Approved</StatusPill> : <Badge tone="warning" dot>With {r.step}</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <ChartCard
          title="Spend by supplier B-BBEE level"
          subtitle="Year to date, R million"
          table={{ columns: ['Level', 'Spend (Rm)'], rows: bbbeeSpend.map((b) => [b.label, b.value]) }}
        >
          <BarList rows={bbbeeSpend} format={(v) => `R${v.toFixed(1)}m`} colorFor={(i) => ORDINAL[i] ?? 'var(--ord-1)'} />
          <p className="mt-4 text-xs text-ink-3">Darker = higher contributor level. Level 1–2 suppliers earn the most preferential points.</p>
        </ChartCard>
      </div>

      <Card padded={false} className="mt-6">
        <div className="p-5 pb-4"><CardHeader title="Three-way matching" subtitle="Supplier invoice ↔ purchase order ↔ goods received note" /></div>
        <Table>
          <thead><tr><Th>Invoice</Th><Th>Supplier</Th><Th>PO</Th><Th>GRN</Th><Th right>Amount</Th><Th>Result</Th></tr></thead>
          <tbody>
            {matching.map((m) => (
              <Tr key={m.invoice}>
                <Td mono>{m.invoice}</Td>
                <Td className="font-medium">{m.supplier}</Td>
                <Td mono className="text-ink-2">{m.po}</Td>
                <Td mono className="text-ink-2">{m.grn}</Td>
                <Td right>{zar(m.amount)}</Td>
                <Td>{m.result === 'matched' ? <StatusPill status="good">Matched</StatusPill> : m.result === 'missing GRN' ? <StatusPill status="critical">Missing GRN</StatusPill> : <StatusPill status="warning">Qty variance</StatusPill>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
