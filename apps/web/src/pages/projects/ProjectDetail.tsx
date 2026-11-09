import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  ArrowLeft,
  Bot,
  CloudRain,
  CloudSun,
  Download,
  FileText,
  FileUp,
  LayoutGrid,
  NotebookPen,
  Plus,
  ShieldAlert,
  Sparkles,
  Sun,
  Users,
  Wind,
  Zap,
  Thermometer,
  Cloud,
  type LucideIcon,
} from 'lucide-react';
import { api, type AiJob, type DiaryEntry, type FileRecord, type Me, type Project } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { useSetCrumb } from '../../lib/crumb';
import { date, dateTime, label, relative, zar } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  Tr,
  cx,
  errorMessage,
} from '../../components/ui';
import { AiJobCard } from '../../components/AiResults';
import { projectStatusTone } from './shared';

type Tab = 'overview' | 'diary' | 'documents' | 'ai';
const COMMERCIAL = ['owner', 'admin', 'project_manager', 'finance'];
const DIARY_WRITERS = ['owner', 'admin', 'project_manager', 'site_foreman'];

export const WEATHER: Record<string, { label: string; icon: LucideIcon }> = {
  clear: { label: 'Clear', icon: Sun },
  cloudy: { label: 'Cloudy', icon: Cloud },
  rain: { label: 'Rain', icon: CloudRain },
  storm: { label: 'Storm', icon: Zap },
  wind: { label: 'Wind', icon: Wind },
  extreme_heat: { label: 'Extreme heat', icon: Thermometer },
};

export function ProjectDetail({ me }: { me: Me }) {
  const { projectId = '' } = useParams();
  const hasField = me.modules.includes('mod_field');
  const hasAi = me.modules.includes('mod_ai') && COMMERCIAL.includes(me.user.role);

  const project = useAsync(async () => (await api.projects()).find((p) => p.id === projectId) ?? null, [projectId]);
  const diary = useAsync(() => (hasField ? api.diary(projectId) : Promise.resolve([] as DiaryEntry[])), [projectId]);
  const files = useAsync(() => api.files(projectId), [projectId]);
  const [tab, setTab] = useState<Tab>('overview');
  useSetCrumb(project.data ? `${project.data.code} · ${project.data.name}` : null);

  if (project.data === null) {
    return <EmptyState icon={LayoutGrid} title="Project not found" action={<Link to="/projects" className="text-sm font-medium text-brand">Back to projects</Link>} />;
  }
  const p = project.data;

  return (
    <div>
      <Link to="/projects" className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" /> Projects
      </Link>

      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            {p ? (
              <>
                <span className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-ink-2">{p.code}</span>
                <Badge tone={projectStatusTone(p.status)} dot>
                  <span className="capitalize">{label(p.status)}</span>
                </Badge>
              </>
            ) : (
              <Skeleton className="h-5 w-32" />
            )}
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{p ? p.name : <Skeleton className="h-7 w-72" />}</h1>
        </div>
        <div className="flex gap-2">
          {hasField && DIARY_WRITERS.includes(me.user.role) && (
            <Button variant="secondary" icon={NotebookPen} onClick={() => setTab('diary')}>
              Log diary
            </Button>
          )}
          <Button variant="secondary" icon={FileUp} onClick={() => setTab('documents')}>
            Upload
          </Button>
        </div>
      </div>

      {/* Facts strip */}
      <Card className="mb-6 grid grid-cols-2 gap-y-4 md:grid-cols-4" padded={false}>
        {[
          ['Contract value', p ? zar(p.contractValue) : '…', 'excl. VAT'],
          ['Contract form', p?.contractForm ? label(p.contractForm) : '—', 'conditions of contract'],
          ['Diary entries', hasField ? String(diary.data?.length ?? '…') : '—', diary.data?.[0] ? `last ${relative(diary.data[0].createdAt)}` : 'none yet'],
          ['Documents', String(files.data?.length ?? '…'), 'in encrypted storage'],
        ].map(([k, v, h], i) => (
          <div key={k} className={cx('px-5 py-4', i > 0 && 'md:border-l md:border-line', i % 2 === 1 && 'border-l border-line md:border-l')}>
            <div className="text-xs font-medium text-ink-3">{k}</div>
            <div className="mt-1 text-lg font-semibold text-ink">{v}</div>
            <div className="text-xs text-ink-3">{h}</div>
          </div>
        ))}
      </Card>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview', icon: LayoutGrid },
          ...(hasField ? [{ id: 'diary' as Tab, label: 'Site diary', icon: NotebookPen, count: diary.data?.length }] : []),
          { id: 'documents', label: 'Documents', icon: FileText, count: files.data?.length },
          ...(hasAi ? [{ id: 'ai' as Tab, label: 'AI insights', icon: Sparkles }] : []),
        ]}
      />

      {tab === 'overview' && p && <Overview project={p} diary={diary.data ?? []} files={files.data ?? []} hasField={hasField} onTab={setTab} />}
      {tab === 'diary' && hasField && <Diary projectId={projectId} entries={diary.data} reload={diary.reload} canWrite={DIARY_WRITERS.includes(me.user.role)} />}
      {tab === 'documents' && <Documents projectId={projectId} files={files.data} reload={files.reload} canUseAi={hasAi} />}
      {tab === 'ai' && hasAi && <ProjectAi projectId={projectId} />}
    </div>
  );
}

// =========================================================================== Overview

function Overview({ project, diary, files, hasField, onTab }: { project: Project; diary: DiaryEntry[]; files: FileRecord[]; hasField: boolean; onTab: (t: Tab) => void }) {
  const crew = diary.slice(0, 7).map((d) => d.workforceCount ?? 0);
  const avgCrew = crew.length ? Math.round(crew.reduce((a, b) => a + b, 0) / crew.length) : null;
  const weatherDays = diary.filter((d) => d.weather === 'rain' || d.weather === 'storm').length;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1.4fr_1fr]">
      {hasField && (
        <Card padded={false}>
          <div className="p-5 pb-3">
            <CardHeader title="Latest from site" subtitle="Most recent diary entries" actions={<Button size="sm" variant="ghost" onClick={() => onTab('diary')}>View diary</Button>} />
          </div>
          {diary.length === 0 ? (
            <EmptyState icon={NotebookPen} title="No diary entries yet">Foremen can log from the web or offline from site tablets.</EmptyState>
          ) : (
            <div className="px-5 pb-5">{diary.slice(0, 3).map((e) => <DiaryItem key={e.id} entry={e} compact />)}</div>
          )}
        </Card>
      )}
      <div className="space-y-6">
        {hasField && (
          <Card>
            <CardHeader title="Site conditions" subtitle="From the last 7 diary entries" />
            <dl className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-line p-3">
                <dt className="flex items-center gap-1.5 text-xs text-ink-3"><Users className="size-3.5" /> Avg. workforce</dt>
                <dd className="mt-1 text-xl font-semibold text-ink">{avgCrew ?? '—'}</dd>
              </div>
              <div className="rounded-lg border border-line p-3">
                <dt className="flex items-center gap-1.5 text-xs text-ink-3"><CloudRain className="size-3.5" /> Rain / storm days</dt>
                <dd className="mt-1 text-xl font-semibold text-ink">{weatherDays}</dd>
              </div>
            </dl>
          </Card>
        )}
        <Card padded={false}>
          <div className="p-5 pb-3">
            <CardHeader title="Recent documents" actions={<Button size="sm" variant="ghost" onClick={() => onTab('documents')}>All documents</Button>} />
          </div>
          {files.length === 0 ? (
            <EmptyState icon={FileText} title="No documents yet" />
          ) : (
            <ul className="divide-y divide-line px-5 pb-2">
              {files.slice(0, 4).map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2.5">
                  <FileIcon type={f.contentType} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{f.filename}</div>
                    <div className="text-xs text-ink-3">{label(f.category)} · {relative(f.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Contract" />
          <dl className="mt-3 space-y-2 text-[13px]">
            {[
              ['Code', project.code],
              ['Conditions', project.contractForm ? label(project.contractForm) : 'Not set'],
              ['Value', zar(project.contractValue, true)],
              ['Registered', date(project.createdAt)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-ink-3">{k}</dt>
                <dd className="num text-right text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}

// =========================================================================== Diary

export function DiaryItem({ entry: e, compact, projectLabel }: { entry: DiaryEntry; compact?: boolean; projectLabel?: string }) {
  const W = e.weather ? WEATHER[e.weather] : null;
  return (
    <div className="relative border-l border-line pb-5 pl-5 last:pb-0">
      <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full bg-surface ring-2 ring-brand/60" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-ink">{date(e.entryDate)}</span>
        {projectLabel && <span className="text-xs font-medium text-ink-2">{projectLabel}</span>}
        {W && (
          <span className="inline-flex items-center gap-1 text-xs text-ink-2">
            <W.icon className="size-3.5" /> {W.label}
          </span>
        )}
        {e.workforceCount !== null && (
          <span className="inline-flex items-center gap-1 text-xs text-ink-2">
            <Users className="size-3.5" /> {e.workforceCount} on site
          </span>
        )}
        <span className="ml-auto text-xs text-ink-3">{e.deviceId === 'web' ? 'Web' : 'Site device'} · {relative(e.createdAt)}</span>
      </div>
      {e.workCompleted && <p className={cx('mt-1.5 whitespace-pre-wrap text-sm text-ink', compact && 'line-clamp-2')}>{e.workCompleted}</p>}
      {(e.delays || e.safetyNotes) && (
        <div className="mt-2 flex flex-col gap-1.5">
          {e.delays && (
            <div className="flex gap-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-[13px] text-warning-ink">
              <CloudSun className="mt-0.5 size-3.5 shrink-0" /> <span><span className="font-medium">Delay · </span>{e.delays}</span>
            </div>
          )}
          {e.safetyNotes && (
            <div className="flex gap-2 rounded-md bg-critical-soft px-2.5 py-1.5 text-[13px] text-critical-ink">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> <span><span className="font-medium">Safety · </span>{e.safetyNotes}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Diary({ projectId, entries, reload, canWrite }: { projectId: string; entries?: DiaryEntry[]; reload: () => Promise<void>; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card padded={false}>
      <div className="flex items-center justify-between border-b border-line p-5">
        <CardHeader title="Site diary" subtitle="Daily record of progress, weather, workforce, delays and safety" />
        {canWrite && <Button icon={Plus} onClick={() => setOpen(true)}>New entry</Button>}
      </div>
      <div className="p-6">
        {!entries && <Skeleton className="h-24" />}
        {entries?.length === 0 && <EmptyState icon={NotebookPen} title="No diary entries yet">Entries logged offline on site tablets appear here after sync.</EmptyState>}
        {entries?.map((e) => <DiaryItem key={e.id} entry={e} />)}
      </div>
      <DiaryDialog open={open} onClose={() => setOpen(false)} projectId={projectId} onSaved={() => { setOpen(false); void reload(); }} />
    </Card>
  );
}

function DiaryDialog({ open, onClose, projectId, onSaved }: { open: boolean; onClose: () => void; projectId: string; onSaved: () => void }) {
  const blank = { entryDate: new Date().toISOString().slice(0, 10), weather: '', workforceCount: '', workCompleted: '', delays: '', safetyNotes: '' };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One id per dialog session: a retried submit is idempotent on the server.
  const entryId = useRef(crypto.randomUUID());
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createDiary(projectId, {
        id: entryId.current,
        entryDate: form.entryDate,
        weather: form.weather || undefined,
        workforceCount: form.workforceCount ? Number(form.workforceCount) : undefined,
        workCompleted: form.workCompleted,
        delays: form.delays,
        safetyNotes: form.safetyNotes,
      } as Partial<DiaryEntry> & { id: string; entryDate: string });
      setForm(blank);
      entryId.current = crypto.randomUUID();
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New diary entry" description="Recorded in the project's audit trail." wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Date"><Input type="date" value={form.entryDate} onChange={set('entryDate')} required /></Field>
          <Field label="Weather">
            <Select value={form.weather} onChange={set('weather')}>
              <option value="">Not recorded</option>
              {Object.entries(WEATHER).map(([k, w]) => <option key={k} value={k}>{w.label}</option>)}
            </Select>
          </Field>
          <Field label="Workforce on site"><Input type="number" min={0} value={form.workforceCount} onChange={set('workforceCount')} /></Field>
        </div>
        <Field label="Work completed"><Textarea rows={3} value={form.workCompleted} onChange={set('workCompleted')} placeholder="Progress against programme, activities, quantities…" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Delays"><Textarea rows={2} value={form.delays} onChange={set('delays')} placeholder="Cause and hours lost" /></Field>
          <Field label="Safety observations"><Textarea rows={2} value={form.safetyNotes} onChange={set('safetyNotes')} placeholder="Near misses, incidents, unsafe acts" /></Field>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Save entry</Button>
        </div>
      </form>
    </Dialog>
  );
}

// =========================================================================== Documents

const CATEGORIES = ['general', 'drawing', 'photo', 'contract', 'tax', 'hse'];
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.docx,.csv,.dwg,.dxf';

function FileIcon({ type }: { type: string }) {
  const pdf = type === 'application/pdf';
  return (
    <span className={cx('grid size-8 shrink-0 place-items-center rounded-md text-[10px] font-bold', pdf ? 'bg-critical-soft text-critical-ink' : 'bg-surface-3 text-ink-2')}>
      {pdf ? 'PDF' : type.startsWith('image/') ? 'IMG' : 'DOC'}
    </span>
  );
}

function Documents({ projectId, files, reload, canUseAi }: { projectId: string; files?: FileRecord[]; reload: () => Promise<void>; canUseAi: boolean }) {
  const [category, setCategory] = useState('general');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.uploadFile(file, category, projectId);
      setNotice(`${file.name} uploaded.`);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const download = async (f: FileRecord) => {
    try {
      window.open((await api.downloadUrl(f.id)).url, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const extract = async (f: FileRecord) => {
    try {
      await api.createAiJob({ kind: 'boq_extraction', fileId: f.id });
      setNotice(`BOQ extraction started for ${f.filename}. Results appear under AI insights.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files[0]); }}
        className={cx('flex flex-wrap items-center gap-4 rounded-xl border-2 border-dashed p-5 transition-colors', drag ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface')}
      >
        <span className="grid size-10 place-items-center rounded-lg bg-surface-3 text-ink-2"><FileUp className="size-5" /></span>
        <div className="min-w-48 flex-1">
          <div className="text-sm font-medium text-ink">{busy ? 'Uploading…' : 'Drop a file here, or browse'}</div>
          <div className="text-xs text-ink-3">PDF, images, Office, CSV, DWG/DXF · up to 500 MB · stored encrypted</div>
        </div>
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-36">
          {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
        </Select>
        <Button variant="secondary" loading={busy} onClick={() => picker.current?.click()}>Browse</Button>
        <input ref={picker} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert tone="good">{notice}</Alert>}

      <Card padded={false}>
        <Table>
          <thead>
            <tr><Th>Name</Th><Th>Category</Th><Th right>Size</Th><Th>Uploaded</Th><Th /></tr>
          </thead>
          <tbody>
            {files?.map((f) => (
              <Tr key={f.id}>
                <Td>
                  <div className="flex items-center gap-3">
                    <FileIcon type={f.contentType} />
                    <span className="font-medium">{f.filename}</span>
                  </div>
                </Td>
                <Td><Badge tone={f.category === 'contract' || f.category === 'tax' ? 'warning' : 'neutral'}><span className="capitalize">{label(f.category)}</span></Badge></Td>
                <Td right className="text-ink-2">{f.sizeBytes > 1048576 ? `${(f.sizeBytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.sizeBytes / 1024))} KB`}</Td>
                <Td className="text-ink-2">{dateTime(f.createdAt)}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1.5">
                    {canUseAi && f.contentType === 'application/pdf' && <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => void extract(f)}>Extract BOQ</Button>}
                    <Button size="sm" variant="secondary" icon={Download} onClick={() => void download(f)}>Download</Button>
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {files?.length === 0 && <EmptyState icon={FileText} title="No documents yet">Drawings, contracts, photos and certificates for this project live here.</EmptyState>}
      </Card>
      <p className="text-xs text-ink-3">Contract and tax document downloads are recorded in the audit trail.</p>
    </div>
  );
}

// =========================================================================== AI

function ProjectAi({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<AiJob[]>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.aiJobs().then((all) => setJobs(all.filter((j) => j.projectId === projectId)), (e) => setError(errorMessage(e))), [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!jobs?.some((j) => j.status === 'queued' || j.status === 'running')) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createAiJob({ kind: 'diary_risk_review', projectId });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4">
        <span className="grid size-10 place-items-center rounded-lg bg-brand-soft text-brand-ink"><Bot className="size-5" /></span>
        <div className="min-w-56 flex-1">
          <div className="text-sm font-medium text-ink">AI Operations Agent</div>
          <div className="text-[13px] text-ink-2">Review recent site diaries for programme, safety and productivity risks. Start BOQ extraction from a PDF under Documents.</div>
        </div>
        <Button icon={Sparkles} loading={busy} onClick={() => void review()}>Run risk review</Button>
      </Card>
      {error && <Alert>{error}</Alert>}
      {jobs?.length === 0 && <Card><EmptyState icon={Sparkles} title="No analyses yet">Results are suggestions for review and never change project records.</EmptyState></Card>}
      {jobs?.map((j) => <AiJobCard key={j.id} job={j} />)}
    </div>
  );
}
