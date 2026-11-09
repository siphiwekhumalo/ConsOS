import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api, formatZar, label, type AiJob, type DiaryEntry, type FileRecord, type Me, type Project } from '../api';
import { Badge, Button, Card, Empty, ErrorText, errorMessage, inputClass, PageHeader } from '../components/ui';
import { AiJobCard } from '../components/AiResults';

type Tab = 'diary' | 'documents' | 'ai';

export function ProjectDetail({ me }: { me: Me }) {
  const { projectId = '' } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasField = me.modules.includes('mod_field');
  const hasAi = me.modules.includes('mod_ai') && me.user.role !== 'site_foreman' && me.user.role !== 'viewer';
  const [tab, setTab] = useState<Tab>(hasField ? 'diary' : 'documents');

  useEffect(() => {
    api.projects().then(
      (all) => {
        const p = all.find((x) => x.id === projectId);
        if (p) setProject(p);
        else setError('Project not found');
      },
      (err) => setError(errorMessage(err)),
    );
  }, [projectId]);

  if (error) return <ErrorText error={error} />;
  if (!project) return <p className="text-slate-500">Loading…</p>;

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'diary', label: 'Site diary', show: hasField },
    { id: 'documents', label: 'Documents', show: true },
    { id: 'ai', label: 'AI insights', show: hasAi },
  ];

  return (
    <section>
      <Link to="/projects" className="text-sm text-slate-500 hover:underline">
        ← Projects
      </Link>
      <PageHeader
        title={`${project.code} · ${project.name}`}
        subtitle={[project.contractForm && label(project.contractForm), formatZar(project.contractValue)].filter(Boolean).join(' · ')}
        actions={<Badge tone={project.status === 'active' ? 'green' : 'slate'}>{label(project.status)}</Badge>}
      />
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t.id ? 'border-slate-900 font-medium text-slate-900' : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {t.label}
            </button>
          ))}
      </div>
      {tab === 'diary' && hasField && <Diary projectId={projectId} me={me} />}
      {tab === 'documents' && <Documents projectId={projectId} canUseAi={hasAi} />}
      {tab === 'ai' && hasAi && <ProjectAi projectId={projectId} />}
    </section>
  );
}

// ---------------------------------------------------------------------------

const WEATHER = ['clear', 'cloudy', 'rain', 'storm', 'wind', 'extreme_heat'];
const DIARY_WRITERS = ['owner', 'admin', 'project_manager', 'site_foreman'];

function Diary({ projectId, me }: { projectId: string; me: Me }) {
  const [entries, setEntries] = useState<DiaryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.diary(projectId).then(setEntries, (e) => setError(errorMessage(e))), [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
      {DIARY_WRITERS.includes(me.user.role) && <DiaryForm projectId={projectId} onSaved={load} />}
      <div className="space-y-3">
        <ErrorText error={error} />
        {entries?.length === 0 && <Empty>No diary entries yet.</Empty>}
        {entries?.map((e) => (
          <Card key={e.id}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{e.entryDate}</span>
              {e.weather && <Badge tone={e.weather === 'rain' || e.weather === 'storm' ? 'amber' : 'slate'}>{label(e.weather)}</Badge>}
              {e.workforceCount !== null && <span className="text-slate-500">{e.workforceCount} on site</span>}
              <span className="ml-auto text-xs text-slate-400">via {e.deviceId ?? 'device'}</span>
            </div>
            {e.workCompleted && <p className="mt-2 whitespace-pre-wrap text-sm">{e.workCompleted}</p>}
            {e.delays && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-amber-800">
                <span className="font-medium">Delays: </span>
                {e.delays}
              </p>
            )}
            {e.safetyNotes && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-red-800">
                <span className="font-medium">Safety: </span>
                {e.safetyNotes}
              </p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function DiaryForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const blank = { entryDate: today, weather: '', workforceCount: '', workCompleted: '', delays: '', safetyNotes: '' };
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createDiary(projectId, {
        id: crypto.randomUUID(), // idempotent: a retried submit cannot create a duplicate
        entryDate: form.entryDate,
        weather: form.weather || undefined,
        workforceCount: form.workforceCount ? Number(form.workforceCount) : undefined,
        workCompleted: form.workCompleted,
        delays: form.delays,
        safetyNotes: form.safetyNotes,
      } as Partial<DiaryEntry> & { id: string; entryDate: string });
      setForm(blank);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="h-fit">
      <form onSubmit={submit} className="space-y-3">
        <h2 className="font-medium">New diary entry</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm font-medium">
            Date
            <input type="date" className={inputClass} value={form.entryDate} onChange={set('entryDate')} required />
          </label>
          <label className="text-sm font-medium">
            Workforce
            <input type="number" min={0} className={inputClass} value={form.workforceCount} onChange={set('workforceCount')} />
          </label>
        </div>
        <label className="block text-sm font-medium">
          Weather
          <select className={inputClass} value={form.weather} onChange={set('weather')}>
            <option value="">Not recorded</option>
            {WEATHER.map((w) => (
              <option key={w} value={w}>
                {label(w)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Work completed
          <textarea rows={3} className={inputClass} value={form.workCompleted} onChange={set('workCompleted')} />
        </label>
        <label className="block text-sm font-medium">
          Delays
          <textarea rows={2} className={inputClass} value={form.delays} onChange={set('delays')} />
        </label>
        <label className="block text-sm font-medium">
          Safety notes
          <textarea rows={2} className={inputClass} value={form.safetyNotes} onChange={set('safetyNotes')} />
        </label>
        <Button disabled={busy} className="w-full">
          {busy ? 'Saving…' : 'Save entry'}
        </Button>
        <ErrorText error={error} />
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------

const CATEGORIES = ['general', 'drawing', 'photo', 'contract', 'tax', 'hse'];
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.docx,.csv,.dwg,.dxf';

function Documents({ projectId, canUseAi }: { projectId: string; canUseAi: boolean }) {
  const [files, setFiles] = useState<FileRecord[] | null>(null);
  const [category, setCategory] = useState('general');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => api.files(projectId).then(setFiles, (e) => setError(errorMessage(e))), [projectId]);
  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.uploadFile(file, category, projectId);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const download = async (f: FileRecord) => {
    try {
      const { url } = await api.downloadUrl(f.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const extractBoq = async (f: FileRecord) => {
    try {
      await api.createAiJob({ kind: 'boq_extraction', fileId: f.id });
      setNotice(`BOQ extraction started for ${f.filename}. See the AI insights tab.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-medium">
          Category
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className={`rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white ${busy ? 'opacity-50' : 'cursor-pointer hover:bg-slate-700'}`}>
          {busy ? 'Uploading…' : 'Upload file'}
          <input type="file" accept={ACCEPT} className="hidden" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
        </label>
        <p className="text-xs text-slate-500">Files go straight to encrypted storage. Contract and tax downloads are logged in the audit trail.</p>
      </Card>
      <ErrorText error={error} />
      {notice && <p className="text-sm text-emerald-700">{notice}</p>}
      <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">File</th>
              <th className="px-4 py-2 font-medium">Category</th>
              <th className="px-4 py-2 text-right font-medium">Size</th>
              <th className="px-4 py-2 font-medium">Uploaded</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {files?.map((f) => (
              <tr key={f.id} className="border-t border-slate-100">
                <td className="px-4 py-2">{f.filename}</td>
                <td className="px-4 py-2">
                  <Badge tone={f.category === 'contract' || f.category === 'tax' ? 'amber' : 'slate'}>{f.category}</Badge>
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{(f.sizeBytes / 1024).toFixed(1)} KB</td>
                <td className="px-4 py-2 text-slate-500">{new Date(f.createdAt).toLocaleString('en-ZA')}</td>
                <td className="space-x-2 whitespace-nowrap px-4 py-2 text-right">
                  <Button variant="secondary" onClick={() => void download(f)}>
                    Download
                  </Button>
                  {canUseAi && f.contentType === 'application/pdf' && (
                    <Button variant="secondary" onClick={() => void extractBoq(f)}>
                      Extract BOQ
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {files?.length === 0 && <Empty>No documents yet.</Empty>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ProjectAi({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () => api.aiJobs().then((all) => setJobs(all.filter((j) => j.projectId === projectId)), (e) => setError(errorMessage(e))),
    [projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Poll while anything is still running.
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'queued' || j.status === 'running')) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [jobs, load]);

  const review = async () => {
    setError(null);
    try {
      await api.createAiJob({ kind: 'diary_risk_review', projectId });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void review()}>Review site diary for risks</Button>
        <p className="text-xs text-slate-500">
          AI results are suggestions for review; they never change project data. Start BOQ extraction from the Documents tab.
        </p>
      </Card>
      <ErrorText error={error} />
      {jobs.length === 0 && <Empty>No AI jobs for this project yet.</Empty>}
      {jobs.map((j) => (
        <AiJobCard key={j.id} job={j} />
      ))}
    </div>
  );
}
