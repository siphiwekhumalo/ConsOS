import { Link } from 'react-router';
import { Calculator, DraftingCompass, Layers, Ruler, Sparkles, Upload } from 'lucide-react';
import { zar } from '../../lib/format';
import { Badge, Button, Card, CardHeader, PageHeader, PreviewBanner, Stat, StatusPill, Table, Td, Th, Tr } from '../../components/ui';
import { takeoffs, unitRates } from '../../demo/data';

export function Estimating() {
  return (
    <div>
      <PageHeader
        title="Estimating & Takeoff"
        description="Measure quantities from PDF and CAD drawings, price against a regional SADC unit-rate library, and break down client BOQs with AI."
        eyebrow={<Badge tone="brand">Module 4</Badge>}
        actions={<Button icon={Upload}>Upload drawing</Button>}
      />
      <PreviewBanner module="estimating" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Unit rates" icon={Calculator} value="2 184" hint="materials, labour, plant" />
        <Stat label="Cost assemblies" icon={Layers} value="146" hint="reusable build-ups" />
        <Stat label="Drawings measured" icon={DraftingCompass} value="37" hint="this quarter" />
        <Stat label="Regions" icon={Ruler} value="9" hint="incl. transport loadings" />
      </div>

      <Card className="mb-6 flex flex-wrap items-center gap-4">
        <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand-ink"><Sparkles className="size-5" /></span>
        <div className="min-w-60 flex-1">
          <div className="text-sm font-semibold text-ink">AI-assisted tender breakdown <Badge tone="good" className="ml-1">Live</Badge></div>
          <div className="text-[13px] text-ink-2">Upload a client BOQ PDF to a project and the AI agent extracts every line and checks each extension.</div>
        </div>
        <Link to="/agent"><Button variant="secondary">Open AI agent</Button></Link>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Unit rate library" subtitle="Rates include regional logistics adjustments" /></div>
          <Table>
            <thead><tr><Th>Code</Th><Th>Item</Th><Th>Unit</Th><Th right>Rate</Th><Th>Region</Th><Th>Updated</Th></tr></thead>
            <tbody>
              {unitRates.map((r) => (
                <Tr key={r.code}>
                  <Td mono className="text-ink-2">{r.code}</Td>
                  <Td className="font-medium">{r.item}</Td>
                  <Td className="text-ink-2">{r.unit}</Td>
                  <Td right>{zar(r.rate, true)}</Td>
                  <Td className="text-ink-2">{r.region}</Td>
                  <Td className="text-ink-3">{r.updated}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Takeoffs in progress" subtitle="Quantities flow straight into BOQ lines" /></div>
          <div className="divide-y divide-line">
            {takeoffs.map((t) => (
              <div key={t.drawing} className="flex items-center gap-3 px-5 py-3.5">
                <span className="grid size-9 place-items-center rounded-lg bg-surface-3 text-ink-2"><DraftingCompass className="size-4" /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{t.measured}</div>
                  <div className="font-mono text-xs text-ink-3">{t.drawing}</div>
                </div>
                {t.status === 'complete' ? <StatusPill status="good">{t.items} items</StatusPill> : t.status === 'in progress' ? <Badge tone="brand" dot>Measuring</Badge> : <Badge>Queued</Badge>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
