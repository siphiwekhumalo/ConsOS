import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { FolderKanban, Plus, Search } from 'lucide-react';
import { api, type Me } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { label, num, zar, zarCompact } from '../../lib/format';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, Table, Td, Th, Tr, errorMessage } from '../../components/ui';
import { CONTRACT_FORMS, projectStatusTone } from './shared';

const CAN_CREATE = ['owner', 'admin', 'project_manager'];

export function Projects({ me }: { me: Me }) {
  const navigate = useNavigate();
  const { data, error, reload } = useAsync(() => api.projects());
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(
    () =>
      (data ?? []).filter(
        (p) =>
          (status === 'all' || p.status === status) &&
          `${p.code} ${p.name} ${p.contractForm ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [data, query, status],
  );
  const total = (data ?? []).reduce((s, p) => s + Number(p.contractValue ?? 0), 0);
  const statuses = [...new Set((data ?? []).map((p) => p.status))];

  return (
    <div>
      <PageHeader
        title="Projects"
        description="Every contract and site in your organisation."
        actions={CAN_CREATE.includes(me.user.role) && <Button icon={Plus} onClick={() => setCreating(true)}>New project</Button>}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Contracts" value={data ? num(data.length) : <Skeleton className="h-7 w-10" />} />
        <Stat label="Total contract value" value={data ? zarCompact(total) : <Skeleton className="h-7 w-24" />} hint="excl. VAT" />
        <Stat label="In tender" value={data ? num(data.filter((p) => p.status === 'tender').length) : <Skeleton className="h-7 w-10" />} />
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="relative min-w-56 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search code, name or contract" className="pl-9" />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
            <option value="all">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
          <span className="ml-auto text-xs text-ink-3">{filtered.length} shown</span>
        </div>

        {error && <div className="p-4"><Alert>{error}</Alert></div>}
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Project</Th>
              <Th>Contract form</Th>
              <Th>Status</Th>
              <Th right>Contract value</Th>
            </tr>
          </thead>
          <tbody>
            {!data &&
              [0, 1, 2, 3].map((i) => (
                <tr key={i}>
                  <td colSpan={5} className="border-b border-line px-5 py-3.5">
                    <Skeleton className="h-5" />
                  </td>
                </tr>
              ))}
            {filtered.map((p) => (
              <Tr key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
                <Td mono className="text-ink-2">{p.code}</Td>
                <Td className="font-medium">{p.name}</Td>
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
        {data && filtered.length === 0 && (
          <EmptyState icon={FolderKanban} title={data.length ? 'No matching projects' : 'No projects yet'}>
            {data.length ? 'Try a different search or status.' : 'Create your first contract to start logging site activity.'}
          </EmptyState>
        )}
      </Card>

      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          void reload();
          navigate(`/projects/${id}`);
        }}
      />
    </div>
  );
}

function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ code: '', name: '', contractForm: '', contractValue: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.createProject({
        code: form.code.trim(),
        name: form.name.trim(),
        contractForm: form.contractForm || undefined,
        contractValue: form.contractValue.replace(/[\s,R]/g, '') || undefined,
      });
      setForm({ code: '', name: '', contractForm: '', contractValue: '' });
      onCreated(p.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New project" description="Register a contract. You can add documents and diary entries once it exists.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
          <Field label="Code">
            <Input value={form.code} onChange={set('code')} placeholder="DM-105" required maxLength={40} />
          </Field>
          <Field label="Project name">
            <Input value={form.name} onChange={set('name')} placeholder="Shaft 5 sinking" required maxLength={200} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contract form">
            <Select value={form.contractForm} onChange={set('contractForm')}>
              <option value="">Not set</option>
              {CONTRACT_FORMS.map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Contract value (ZAR, excl. VAT)">
            <Input value={form.contractValue} onChange={set('contractValue')} inputMode="decimal" placeholder="12 500 000.00" />
          </Field>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Create project</Button>
        </div>
      </form>
    </Dialog>
  );
}
