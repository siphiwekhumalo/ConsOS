import { Fuel, Gauge, MapPin, Truck, Wrench } from 'lucide-react';
import { num } from '../../lib/format';
import { Badge, Card, CardHeader, PageHeader, PreviewBanner, Progress, Stat, StatusPill, Table, Td, Th, Tr } from '../../components/ui';
import { Sparkline } from '../../components/charts';
import { plant, utilisationTrend } from '../../demo/data';

export function Fleet() {
  const running = plant.filter((p) => p.status === 'running').length;
  return (
    <div>
      <PageHeader
        title="Fleet, Equipment & CMMS"
        description="Telematics hour-meters and fuel burn, preventive and breakdown maintenance, and internal plant billing to project cost codes."
        eyebrow={<Badge tone="brand">Module 7</Badge>}
      />
      <PreviewBanner module="fleet" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Fleet utilisation" icon={Gauge} value="79%" hint="last 8 weeks">
          <Sparkline data={utilisationTrend} label="Fleet utilisation" />
        </Stat>
        <Stat label="Machines running" icon={Truck} value={`${running} / ${plant.length}`} hint="live from telematics" />
        <Stat label="Fuel today" icon={Fuel} value={`${num(plant.reduce((n, p) => n + Number(p.fuel), 0))} L`} hint="all sites" />
        <Stat label="Maintenance due" icon={Wrench} value="2" hint="1 breakdown open" />
      </div>

      <Card padded={false}>
        <div className="p-5 pb-4"><CardHeader title="Plant register" subtitle="Synced from Samsara / CAT VisionLink · billed daily to project cost codes" /></div>
        <Table>
          <thead><tr><Th>Unit</Th><Th>Machine</Th><Th>Site</Th><Th right>Hours today</Th><Th className="w-44">Utilisation</Th><Th right>Fuel (L)</Th><Th>Next service</Th><Th>Status</Th></tr></thead>
          <tbody>
            {plant.map((p) => (
              <Tr key={p.id}>
                <Td mono className="text-ink-2">{p.id}</Td>
                <Td className="font-medium">{p.name}</Td>
                <Td><span className="inline-flex items-center gap-1 font-mono text-[13px] text-ink-2"><MapPin className="size-3.5" />{p.project}</span></Td>
                <Td right>{p.hours}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <Progress value={p.util} tone={p.util < 50 ? 'warning' : 'brand'} />
                    <span className="num w-9 text-right text-xs text-ink-2">{p.util}%</span>
                  </div>
                </Td>
                <Td right>{p.fuel}</Td>
                <Td className="text-ink-2">{p.next}</Td>
                <Td>{p.status === 'running' ? <StatusPill status="good">Running</StatusPill> : p.status === 'breakdown' ? <StatusPill status="critical">Breakdown</StatusPill> : <StatusPill status="warning">Service due</StatusPill>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
