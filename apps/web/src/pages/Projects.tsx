import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, formatZar, label, type Me, type Project } from '../api';
import { Badge, Button, Card, Empty, ErrorText, errorMessage, inputClass, PageHeader } from '../components/ui';

const CONTRACT_FORMS = ['FIDIC_RED', 'FIDIC_YELLOW', 'FIDIC_SILVER', 'NEC4_ECC', 'JBCC_PBA', 'GCC_2015'];
const CAN_CREATE = ['owner', 'admin', 'project_manager'];

export function Projects({ me }: { me: Me }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = () => api.projects().then(setProjects, (err) => setError(errorMessage(err)));
  useEffect(() => {
    void load();
  }, []);

  return (
    <section>
      <PageHeader
        title="Projects"
        subtitle={`${projects?.length ?? '…'} contracts in ${me.tenant.name}`}
        actions={
          CAN_CREATE.includes(me.user.role) && (
            <Button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'New project'}</Button>
          )
        }
      />
      {showForm && (
        <NewProject
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
      <ErrorText error={error} />
      {!projects && !error && <p className="text-slate-500">Loading…</p>}
      {projects && (
        <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Contract</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-2 font-mono">
                    <Link to={`/projects/${p.id}`} className="text-sky-700 hover:underline">
                      {p.code}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Link to={`/projects/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{p.contractForm ? label(p.contractForm) : '—'}</td>
                  <td className="px-4 py-2">
                    <Badge tone={p.status === 'active' ? 'green' : 'slate'}>{label(p.status)}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatZar(p.contractValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {projects.length === 0 && <Empty>No projects yet.</Empty>}
        </div>
      )}
    </section>
  );
}

function NewProject({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({ code: '', name: '', contractForm: '', contractValue: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createProject({
        code: form.code,
        name: form.name,
        contractForm: form.contractForm || undefined,
        contractValue: form.contractValue.replace(/[\s,]/g, '') || undefined,
      });
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-6">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm font-medium">
          Code
          <input className={inputClass} value={form.code} onChange={set('code')} placeholder="DC-003" required />
        </label>
        <label className="text-sm font-medium">
          Name
          <input className={inputClass} value={form.name} onChange={set('name')} required />
        </label>
        <label className="text-sm font-medium">
          Contract form
          <select className={inputClass} value={form.contractForm} onChange={set('contractForm')}>
            <option value="">Not set</option>
            {CONTRACT_FORMS.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Contract value (ZAR)
          <input className={inputClass} value={form.contractValue} onChange={set('contractValue')} inputMode="decimal" placeholder="12500000.00" />
        </label>
        <div className="sm:col-span-2 lg:col-span-4">
          <Button disabled={busy}>{busy ? 'Creating…' : 'Create project'}</Button>
          <ErrorText error={error} />
        </div>
      </form>
    </Card>
  );
}
