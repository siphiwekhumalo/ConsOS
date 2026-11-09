import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, FileSearch, FileSpreadsheet, ShieldAlert, Sparkles } from 'lucide-react';
import { api, type AiJob, type Project } from '../api';
import { num } from '../lib/format';
import { AiJobCard } from '../components/AiResults';
import { Alert, Badge, Card, EmptyState, PageHeader, Select, Stat, Button, errorMessage } from '../components/ui';

export function AiAgent() {
  const [jobs, setJobs] = useState<AiJob[]>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | AiJob['kind']>('all');
  const [reviewProject, setReviewProject] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.aiJobs().then(setJobs, (e) => setError(errorMessage(e))), []);
  useEffect(() => {
    void load();
    api.projects().then(setProjects, () => undefined);
  }, [load]);
  useEffect(() => {
    if (!jobs?.some((j) => j.status === 'queued' || j.status === 'running')) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const names = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, `${p.code} · ${p.name}`])), [projects]);
  const shown = (jobs ?? []).filter((j) => filter === 'all' || j.kind === filter);
  const flagged = (jobs ?? []).reduce((n, j) => {
    const r = j.result as { warnings?: string[]; risks?: unknown[] } | null;
    return n + (r?.warnings?.length ?? 0) + (r?.risks?.length ?? 0);
  }, 0);

  const runReview = async () => {
    if (!reviewProject) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAiJob({ kind: 'diary_risk_review', projectId: reviewProject });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="AI Operations Agent"
        description="Document intelligence and risk auditing. Every result is a suggestion for a person to check; the agent has read-only access and never changes your records."
        eyebrow={<Badge tone="brand">Module 10</Badge>}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Analyses run" icon={Sparkles} value={jobs ? num(jobs.length) : '…'} />
        <Stat label="Tender BOQs extracted" icon={FileSpreadsheet} value={jobs ? num(jobs.filter((j) => j.kind === 'boq_extraction' && j.status === 'succeeded').length) : '…'} />
        <Stat label="Items flagged for review" icon={ShieldAlert} value={jobs ? num(flagged) : '…'} hint="risks and BOQ arithmetic errors" />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-warning-soft text-warning-ink"><ShieldAlert className="size-[18px]" /></span>
            <div>
              <div className="text-sm font-semibold text-ink">Site diary risk review</div>
              <div className="text-[13px] text-ink-2">Flags recurring delays, weather losses and safety trends.</div>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Select value={reviewProject} onChange={(e) => setReviewProject(e.target.value)}>
              <option value="">Choose a project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}
            </Select>
            <Button onClick={() => void runReview()} loading={busy} disabled={!reviewProject}>Run</Button>
          </div>
        </Card>
        <Card className="flex flex-col">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-brand-soft text-brand-ink"><FileSearch className="size-[18px]" /></span>
            <div>
              <div className="text-sm font-semibold text-ink">Tender BOQ extraction</div>
              <div className="text-[13px] text-ink-2">Turns a tender PDF into structured BOQ lines and checks every extension.</div>
            </div>
          </div>
          <p className="mt-4 text-[13px] text-ink-3">Start from a project’s Documents tab: choose a PDF and select “Extract BOQ”.</p>
        </Card>
      </div>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">History</h2>
        <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="w-48">
          <option value="all">All analyses</option>
          <option value="boq_extraction">BOQ extraction</option>
          <option value="diary_risk_review">Risk reviews</option>
        </Select>
      </div>
      <div className="space-y-3">
        {jobs && shown.length === 0 && <Card><EmptyState icon={Bot} title="No analyses yet">Run a risk review above or extract a BOQ from a tender PDF.</EmptyState></Card>}
        {shown.map((j) => <AiJobCard key={j.id} job={j} projectName={j.projectId ? names[j.projectId] : undefined} />)}
      </div>
    </div>
  );
}
