import { Link, useNavigate } from 'react-router';
import { ArrowUpRight, Bot, ClipboardList, FolderKanban, HardHat, Landmark, ScrollText, ShieldCheck, Wallet } from 'lucide-react';
import { api, type AuditEvent, type Me } from '../api';
import { useAsync } from '../lib/useAsync';
import { label, num, relative, zar, zarCompact } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, PageHeader, SampleChip, Skeleton, Stat, StatusPill, Table, Td, Th, Tr } from '../components/ui';
import { ChartCard, TrendChart } from '../components/charts';
import { cvrMonthly, hseKpis } from '../demo/data';
import { projectStatusTone } from './projects/shared';

const COMMERCIAL = ['owner', 'admin', 'project_manager', 'finance'];

export function Dashboard({ me }: { me: Me }) {
  const navigate = useNavigate();
  const has = (m: string) => me.modules.includes(m as never);
  const canAudit = ['owner', 'admin', 'finance'].includes(me.user.role);
  const canAi = has('mod_ai') && COMMERCIAL.includes(me.user.role);

  const projects = useAsync(() => api.projects());
  const diaryCount = useAsync(async () => {
    if (!has('mod_field') || !projects.data) return null;
    const all = await Promise.all(projects.data.map((p) => api.diary(p.id).catch(() => [])));
    const weekAgo = Date.now() - 7 * 86400_000;
    return all.flat().filter((e) => new Date(e.createdAt).getTime() > weekAgo).length;
  }, [projects.data]);
  const jobs = useAsync(() => (canAi ? api.aiJobs() : Promise.resolve([])));
  const activity = useAsync(() => (canAudit ? api.auditEvents() : Promise.resolve([] as AuditEvent[])));

  const list = projects.data ?? [];
  const portfolio = list.reduce((sum, p) => sum + Number(p.contractValue ?? 0), 0); // display aggregate only
  const firstName = me.user.fullName.split(' ')[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div>
      <PageHeader
        title={`${greeting}, ${firstName}`}
        description={`${me.tenant.name} · ${new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Contracts"
          icon={FolderKanban}
          value={projects.data ? num(list.length) : <Skeleton className="h-7 w-12" />}
          hint={projects.data ? `${list.filter((p) => p.status === 'active').length} active on site` : ''}
        />
        <Stat label="Portfolio value" icon={Wallet} value={projects.data ? zarCompact(portfolio) : <Skeleton className="h-7 w-24" />} hint="contract value, excl. VAT" />
        {has('mod_field') && (
          <Stat
            label="Site diary entries"
            icon={ClipboardList}
            value={diaryCount.data === undefined || diaryCount.data === null ? <Skeleton className="h-7 w-10" /> : num(diaryCount.data)}
            hint="logged in the last 7 days"
          />
        )}
        {canAi && (
          <Stat
            label="AI analyses"
            icon={Bot}
            value={jobs.data ? num(jobs.data.length) : <Skeleton className="h-7 w-10" />}
            hint={jobs.data ? `${jobs.data.filter((j) => j.status === 'succeeded').length} completed` : ''}
          />
        )}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        {has('mod_finance') && COMMERCIAL.includes(me.user.role) ? (
          <ChartCard
            title="Portfolio cost vs value"
            subtitle="Cumulative certified value against actual cost, R million"
            actions={<SampleChip />}
            table={{ columns: ['Month', 'Value (Rm)', 'Cost (Rm)', 'Margin (Rm)'], rows: cvrMonthly.map((r) => [r.month, r.value, r.cost, (r.value - r.cost).toFixed(1)]) }}
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
        ) : (
          <ProjectsCard projects={list} loading={!projects.data} onOpen={(id) => navigate(`/projects/${id}`)} />
        )}

        <Card padded={false}>
          <div className="p-5 pb-3">
            <CardHeader
              title="Recent activity"
              subtitle="From the audit ledger"
              actions={canAudit && <Link to="/audit" className="text-[13px] font-medium text-brand hover:underline">View all</Link>}
            />
          </div>
          {!canAudit ? (
            <EmptyState icon={ScrollText} title="Restricted">
              The audit ledger is visible to owners, administrators and finance.
            </EmptyState>
          ) : activity.data?.length === 0 ? (
            <EmptyState icon={ScrollText} title="No activity yet" />
          ) : (
            <ul className="px-5 pb-4">
              {(activity.data ?? []).slice(0, 7).map((e) => (
                <li key={e.seq} className="flex gap-3 border-l border-line py-2 pl-4 relative">
                  <span className="absolute -left-[4.5px] top-3.5 size-2 rounded-full bg-surface ring-2 ring-brand/60" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink">{describe(e)}</div>
                    <div className="text-xs text-ink-3">{relative(e.occurredAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        {has('mod_finance') && COMMERCIAL.includes(me.user.role) ? (
          <ProjectsCard projects={list} loading={!projects.data} onOpen={(id) => navigate(`/projects/${id}`)} />
        ) : (
          <div />
        )}
        {has('mod_hse') && (
          <Card>
            <CardHeader title="Safety performance" subtitle="Rolling 12 months" actions={<SampleChip />} />
            <div className="mt-4 flex items-center gap-4 rounded-xl bg-good-soft p-4">
              <ShieldCheck className="size-8 text-good-ink" />
              <div>
                <div className="text-2xl font-semibold text-ink">{hseKpis.ltiFreeDays} days</div>
                <div className="text-[13px] text-ink-2">without a lost-time injury</div>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-3 gap-3 text-center">
              {[
                ['LTIFR', hseKpis.ltifr.toFixed(2)],
                ['TRIFR', hseKpis.trifr.toFixed(2)],
                ['Near misses', String(hseKpis.nearMisses30d)],
              ].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-line p-3">
                  <dt className="text-xs text-ink-3">{k}</dt>
                  <dd className="mt-1 text-lg font-semibold text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <Link to="/hse" className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
              <HardHat className="size-4" /> Open HSE <ArrowUpRight className="size-3.5" />
            </Link>
          </Card>
        )}
      </div>

      {has('mod_finance') && COMMERCIAL.includes(me.user.role) && (
        <div className="mt-6">
          <Card className="flex flex-wrap items-center gap-4">
            <Landmark className="size-5 text-ink-3" />
            <div className="flex-1 text-sm text-ink-2">
              Compensation event <span className="font-medium text-ink">CE-014</span> has 9 days left on its contractual time bar.
            </div>
            <StatusPill status="warning">Time bar</StatusPill>
            <SampleChip />
          </Card>
        </div>
      )}
    </div>
  );
}

function ProjectsCard({ projects, loading, onOpen }: { projects: import('../api').Project[]; loading: boolean; onOpen: (id: string) => void }) {
  return (
    <Card padded={false}>
      <div className="p-5 pb-4">
        <CardHeader title="Portfolio" subtitle="Contracts by value" actions={<Link to="/projects" className="text-[13px] font-medium text-brand hover:underline">All projects</Link>} />
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Project</Th>
            <Th>Contract</Th>
            <Th>Status</Th>
            <Th right>Value</Th>
          </tr>
        </thead>
        <tbody>
          {loading &&
            [0, 1, 2].map((i) => (
              <tr key={i}>
                <td colSpan={4} className="border-b border-line px-5 py-3">
                  <Skeleton className="h-5 w-full" />
                </td>
              </tr>
            ))}
          {[...projects]
            .sort((a, b) => Number(b.contractValue ?? 0) - Number(a.contractValue ?? 0))
            .slice(0, 6)
            .map((p) => (
              <Tr key={p.id} onClick={() => onOpen(p.id)}>
                <Td>
                  <div className="font-medium">{p.name}</div>
                  <div className="font-mono text-xs text-ink-3">{p.code}</div>
                </Td>
                <Td className="text-ink-2">{p.contractForm ? label(p.contractForm) : '—'}</Td>
                <Td>
                  <Badge tone={projectStatusTone(p.status)} dot>
                    <span className="capitalize">{label(p.status)}</span>
                  </Badge>
                </Td>
                <Td right>{zar(p.contractValue)}</Td>
              </Tr>
            ))}
        </tbody>
      </Table>
    </Card>
  );
}

function describe(e: AuditEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.action) {
    case 'project.created':
      return `Project ${p.code ?? ''} created`;
    case 'diary.created':
      return `Site diary entry for ${p.entryDate ?? 'a project'}`;
    case 'diary.synced': {
      const s = (p.summary ?? {}) as Record<string, number>;
      return `Field device synced ${s.applied ?? 0} diary change(s)`;
    }
    case 'file.uploaded':
      return `Document uploaded: ${p.filename ?? ''}`;
    case 'file.downloaded':
      return `Sensitive document downloaded: ${p.filename ?? ''}`;
    case 'ai_job.requested':
      return `AI ${label(String(p.kind ?? 'analysis'))} requested`;
    case 'ai_job.succeeded':
      return `AI ${label(String(p.kind ?? 'analysis'))} completed`;
    default:
      return label(e.action.replace('.', ' '));
  }
}
