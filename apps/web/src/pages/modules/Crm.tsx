import { BriefcaseBusiness, Handshake, Plus, Target, Trophy } from 'lucide-react';
import { zarCompact } from '../../lib/format';
import { Badge, Button, Card, CardHeader, PageHeader, PreviewBanner, Stat, Table, Td, Th, Tr } from '../../components/ui';
import { jvPartners, pipeline } from '../../demo/data';

export function Crm() {
  const open = pipeline.filter((s) => s.stage !== 'Won').flatMap((s) => s.items);
  const openValue = open.reduce((n, i) => n + Number(i.value), 0);

  return (
    <div>
      <PageHeader
        title="CRM & Bids"
        description="Client and asset-owner relationships, tender pipeline from pre-qualification to award, and B-BBEE joint-venture partners."
        eyebrow={<Badge tone="brand">Module 2</Badge>}
        actions={<Button icon={Plus}>New opportunity</Button>}
      />
      <PreviewBanner module="CRM & bids" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Open tenders" icon={Target} value={String(open.length)} hint="in pipeline" />
        <Stat label="Pipeline value" icon={BriefcaseBusiness} value={zarCompact(openValue)} hint="unweighted" />
        <Stat label="Win rate (12 mo)" icon={Trophy} value="31%" hint="by count · 24% by value" />
        <Stat label="JV partners" icon={Handshake} value={String(jvPartners.length)} hint="active on bids" />
      </div>

      <div className="mb-6 grid gap-4 overflow-x-auto pb-1 md:grid-cols-2 xl:grid-cols-4">
        {pipeline.map((stage) => (
          <div key={stage.stage} className="min-w-64 rounded-xl border border-line bg-surface-2 p-3">
            <div className="mb-3 flex items-center justify-between px-1">
              <span className="text-[13px] font-semibold text-ink">{stage.stage}</span>
              <span className="text-xs text-ink-3">{zarCompact(stage.items.reduce((n, i) => n + Number(i.value), 0))}</span>
            </div>
            <div className="space-y-2">
              {stage.items.map((i) => (
                <div key={i.title} className="rounded-lg border border-line bg-surface p-3 shadow-card">
                  <div className="text-[13px] font-medium leading-snug text-ink">{i.title}</div>
                  <div className="mt-1 text-xs text-ink-2">{i.client}</div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-sm font-semibold text-ink">{zarCompact(i.value)}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge>CIDB {i.grade}</Badge>
                      <span className="text-xs text-ink-3">{i.due}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Card padded={false}>
        <div className="p-5 pb-4"><CardHeader title="B-BBEE partners & joint ventures" subtitle="Empowerment credentials and equity splits used in preferential procurement scoring" /></div>
        <Table>
          <thead><tr><Th>Partner</Th><Th>B-BBEE level</Th><Th right>Black ownership</Th><Th right>JV equity</Th><Th>Tender</Th></tr></thead>
          <tbody>
            {jvPartners.map((p) => (
              <Tr key={p.name}>
                <Td className="font-medium">{p.name}</Td>
                <Td><Badge tone="good">Level {p.level}</Badge></Td>
                <Td right>{p.blackOwned}</Td>
                <Td right>{p.equity}</Td>
                <Td className="text-ink-2">{p.tender}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
