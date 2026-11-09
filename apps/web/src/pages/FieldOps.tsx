import { useMemo, useState } from 'react';
import { CloudOff, CloudRain, MessageSquareQuote, NotebookPen, ShieldAlert, Users } from 'lucide-react';
import { api, type DiaryEntry, type Project } from '../api';
import { useAsync } from '../lib/useAsync';
import { num } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, PageHeader, SampleChip, Select, Skeleton, Stat, StatusPill, Table, Tabs, Td, Th, Tr } from '../components/ui';
import { DiaryItem } from './projects/ProjectDetail';
import { rfis } from '../demo/data';

type Row = DiaryEntry & { project: Project };

export function FieldOps() {
  const [tab, setTab] = useState<'diary' | 'rfi'>('diary');
  const [project, setProject] = useState('all');
  const data = useAsync(async () => {
    const projects = await api.projects();
    const lists = await Promise.all(projects.map(async (p) => (await api.diary(p.id).catch(() => [])).map((e) => ({ ...e, project: p }))));
    return { projects, entries: lists.flat().sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt)) as Row[] };
  });

  const entries = useMemo(() => (data.data?.entries ?? []).filter((e) => project === 'all' || e.project.id === project), [data.data, project]);
  const week = entries.filter((e) => Date.now() - new Date(e.entryDate).getTime() < 7 * 86400_000);
  const crew = week.reduce((s, e) => s + (e.workforceCount ?? 0), 0);
  const fromDevices = entries.filter((e) => e.deviceId && e.deviceId !== 'web').length;

  return (
    <div>
      <PageHeader
        title="Field Operations"
        description="Daily site diaries from every project, captured on the web or offline on site tablets and synced when connectivity returns."
        eyebrow={<Badge tone="brand">Module 6</Badge>}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Entries (7 days)" icon={NotebookPen} value={data.data ? num(week.length) : <Skeleton className="h-7 w-10" />} />
        <Stat label="Labour-days (7 days)" icon={Users} value={data.data ? num(crew) : <Skeleton className="h-7 w-14" />} hint="sum of daily headcounts" />
        <Stat label="Weather-affected days" icon={CloudRain} value={data.data ? num(week.filter((e) => e.weather === 'rain' || e.weather === 'storm').length) : <Skeleton className="h-7 w-10" />} />
        <Stat label="Synced from site devices" icon={CloudOff} value={data.data ? num(fromDevices) : <Skeleton className="h-7 w-10" />} hint="offline-first edge sync" />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'diary', label: 'Site diaries', icon: NotebookPen, count: entries.length },
          { id: 'rfi', label: 'RFIs & site instructions', icon: MessageSquareQuote },
        ]}
      />

      {tab === 'diary' && (
        <Card padded={false}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
            <span className="text-sm font-medium text-ink">All diary entries</span>
            <Select value={project} onChange={(e) => setProject(e.target.value)} className="w-64">
              <option value="all">All projects</option>
              {data.data?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="p-6">
            {!data.data && <Skeleton className="h-32" />}
            {data.data && entries.length === 0 && (
              <EmptyState icon={NotebookPen} title="No diary entries">Open a project to log the first entry, or sync from a site device.</EmptyState>
            )}
            {entries.slice(0, 50).map((e) => (
              <DiaryItem key={e.id} entry={e} projectLabel={e.project.code} />
            ))}
          </div>
        </Card>
      )}

      {tab === 'rfi' && (
        <Card padded={false}>
          <div className="p-5 pb-4">
            <CardHeader title="Requests for information & site instructions" subtitle="Consulting engineer correspondence with photo and document attachments" actions={<SampleChip />} />
          </div>
          <Table>
            <thead>
              <tr><Th>Ref</Th><Th>Subject</Th><Th>Addressed to</Th><Th>Raised</Th><Th>Status</Th></tr>
            </thead>
            <tbody>
              {rfis.map((r) => (
                <Tr key={r.no}>
                  <Td mono className="text-ink-2">{r.no}</Td>
                  <Td className="font-medium">{r.subject}</Td>
                  <Td className="text-ink-2">{r.to}</Td>
                  <Td className="text-ink-2">{r.raised}</Td>
                  <Td>
                    {r.overdue ? <StatusPill status="critical">Overdue</StatusPill> : r.status === 'open' ? <Badge tone="brand" dot>Open</Badge> : <StatusPill status="good">Actioned</StatusPill>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          <div className="flex items-center gap-2 border-t border-line px-5 py-3 text-xs text-ink-3">
            <ShieldAlert className="size-3.5" /> RFI tracking is a design preview; the diary above is live.
          </div>
        </Card>
      )}
    </div>
  );
}
