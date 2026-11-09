import { ClipboardCheck, HardHat, Plus, ShieldCheck, TriangleAlert, Users } from 'lucide-react';
import { Badge, Button, Card, CardHeader, PageHeader, PreviewBanner, Stat, StatusPill, Table, Td, Th, Tr } from '../../components/ui';
import { hseKpis, incidents, ncrs, toolboxTalks } from '../../demo/data';

export function Hse() {
  return (
    <div>
      <PageHeader
        title="HSE & Safety"
        description="Toolbox talks and inductions with digital signatures, incident and near-miss reporting aligned to the OHS Act and COIDA, and audit checklists that raise NCRs."
        eyebrow={<Badge tone="brand">Module 8</Badge>}
        actions={<Button icon={Plus} variant="danger">Report incident</Button>}
      />
      <PreviewBanner module="HSE" />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="LTI-free days" icon={ShieldCheck} value={String(hseKpis.ltiFreeDays)} hint="all sites" />
        <Stat label="LTIFR" icon={HardHat} value={hseKpis.ltifr.toFixed(2)} hint="per 200 000 hours, rolling 12 mo" />
        <Stat label="Near misses (30 days)" icon={TriangleAlert} value={String(hseKpis.nearMisses30d)} hint="reporting culture indicator" />
        <Stat label="Inductions (30 days)" icon={Users} value={String(hseKpis.inductions30d)} hint="signed digitally" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Incidents & near misses" subtitle="Root-cause analysis workflow for every report" /></div>
          <Table>
            <thead><tr><Th>Ref</Th><Th>Type</Th><Th>Description</Th><Th>Site</Th><Th>Severity</Th><Th>Status</Th></tr></thead>
            <tbody>
              {incidents.map((i) => (
                <Tr key={i.ref}>
                  <Td mono className="text-ink-2">{i.ref}</Td>
                  <Td className="text-ink-2">{i.type}</Td>
                  <Td className="font-medium">{i.title}</Td>
                  <Td mono className="text-ink-2">{i.project}</Td>
                  <Td><StatusPill status={i.severity as 'serious' | 'warning'}><span className="capitalize">{i.severity === 'serious' ? 'High potential' : 'Moderate'}</span></StatusPill></Td>
                  <Td><Badge tone={i.status === 'closed' ? 'good' : 'neutral'}><span className="capitalize">{i.status}</span></Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
        <div className="space-y-6">
          <Card padded={false}>
            <div className="p-5 pb-3"><CardHeader title="Toolbox talks" subtitle="Attendance captured with digital signatures" /></div>
            <div className="divide-y divide-line">
              {toolboxTalks.map((t) => (
                <div key={t.topic} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{t.topic}</div>
                    <div className="text-xs text-ink-3">{t.project} · {t.date}</div>
                  </div>
                  <span className="inline-flex items-center gap-1 text-xs text-ink-2"><Users className="size-3.5" />{t.attendees}</span>
                </div>
              ))}
            </div>
          </Card>
          <Card padded={false}>
            <div className="p-5 pb-3"><CardHeader title="Non-conformance reports" subtitle="Raised automatically from safety walkthroughs" /></div>
            <div className="divide-y divide-line">
              {ncrs.map((n) => (
                <div key={n.ref} className="flex items-center gap-3 px-5 py-3">
                  <ClipboardCheck className="size-4 text-ink-3" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{n.finding}</div>
                    <div className="text-xs text-ink-3">{n.ref} · due {n.due}</div>
                  </div>
                  {n.status === 'overdue' ? <StatusPill status="critical">Overdue</StatusPill> : <StatusPill status="warning">Open</StatusPill>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
