import { useMemo, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, MailPlus, Search, ShieldCheck, UserCheck, UserX, Users as UsersIcon } from 'lucide-react';
import { api, type InviteLink, type Me, type OrgUser, type Role } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { dateTime, sentence } from '../../lib/format';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, Table, Td, Th, Tr, errorMessage } from '../../components/ui';

const ROLE_INFO: Record<Role, string> = {
  owner: 'Everything, including managing owners and locking baselines',
  admin: 'Manages users (except owners), approvals and settings',
  project_manager: 'Runs projects, estimates and site diaries',
  site_foreman: 'Logs site diaries and documents; no commercial data',
  finance: 'Commercial sign-off, audit trail, financial modules',
  viewer: 'Read-only access to projects',
};
const ROLES = Object.keys(ROLE_INFO) as Role[];

export function Users({ me }: { me: Me }) {
  const { data, error, reload } = useAsync(() => api.users());
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ user: string; link: InviteLink } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const isOwner = me.user.role === 'owner';

  const users = useMemo(
    () => (data ?? []).filter((u) => `${u.fullName} ${u.email} ${u.role}`.toLowerCase().includes(query.trim().toLowerCase())),
    [data, query],
  );
  const counts = {
    active: (data ?? []).filter((u) => u.status === 'active').length,
    invited: (data ?? []).filter((u) => u.status === 'invited').length,
    deactivated: (data ?? []).filter((u) => u.status === 'deactivated').length,
  };
  const canManage = (u: OrgUser) => u.id !== me.user.id && (isOwner || u.role !== 'owner');

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <div>
      <PageHeader
        title="Users & access"
        description={`Who can sign in to ${me.tenant.name}, and what they can do. People set their own password from a one-time link; nobody else ever sees it.`}
        actions={<Button icon={MailPlus} onClick={() => setInviting(true)}>Invite user</Button>}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat label="Active" icon={UserCheck} value={data ? String(counts.active) : <Skeleton className="h-7 w-8" />} hint="can sign in" />
        <Stat label="Invited" icon={MailPlus} value={data ? String(counts.invited) : <Skeleton className="h-7 w-8" />} hint="waiting to set a password" />
        <Stat label="Deactivated" icon={UserX} value={data ? String(counts.deactivated) : <Skeleton className="h-7 w-8" />} hint="sign-in blocked; history kept" />
      </div>

      {(error || actionError) && <div className="mb-4"><Alert>{error ?? actionError}</Alert></div>}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div className="relative w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, email or role" className="w-72 pl-9" />
          </div>
          <span className="ml-auto text-xs text-ink-3">Organisation ID for sign-in: <span className="font-mono text-ink-2">{me.tenant.slug}</span></span>
        </div>
        <Table>
          <thead>
            <tr><Th>Person</Th><Th>Role</Th><Th>Status</Th><Th>Added</Th><Th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <Tr key={u.id}>
                <Td>
                  <div className="flex items-center gap-3">
                    <Avatar name={u.fullName} />
                    <div>
                      <div className="font-medium">
                        {u.fullName} {u.id === me.user.id && <span className="text-xs font-normal text-ink-3">(you)</span>}
                      </div>
                      <div className="text-xs text-ink-3">{u.email}</div>
                    </div>
                  </div>
                </Td>
                <Td>
                  {canManage(u) && u.status !== 'deactivated' ? (
                    <Select
                      value={u.role}
                      className="w-44"
                      onChange={(e) => void act(() => api.updateUser(u.id, { role: e.target.value as Role }))}
                      title={ROLE_INFO[u.role]}
                    >
                      {ROLES.filter((r) => isOwner || r !== 'owner').map((r) => (
                        <option key={r} value={r}>{sentence(r)}</option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-ink-2" title={ROLE_INFO[u.role]}>{sentence(u.role)}</span>
                  )}
                </Td>
                <Td>
                  {u.status === 'active' && <Badge tone="good" dot>Active</Badge>}
                  {u.status === 'invited' && (
                    <Badge tone={u.inviteExpiresAt ? 'brand' : 'warning'} dot>
                      {u.inviteExpiresAt ? `Invited · link valid until ${dateTime(u.inviteExpiresAt)}` : 'Invite expired'}
                    </Badge>
                  )}
                  {u.status === 'deactivated' && <Badge tone="neutral" dot>Deactivated</Badge>}
                </Td>
                <Td className="text-ink-2">{dateTime(u.createdAt)}</Td>
                <Td className="text-right">
                  {canManage(u) && (
                    <div className="flex justify-end gap-1.5">
                      {u.status !== 'deactivated' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={u.status === 'invited' ? MailPlus : KeyRound}
                          onClick={() => void act(async () => setLink({ user: u.fullName, link: await api.userLink(u.id) }))}
                        >
                          {u.status === 'invited' ? 'New invite link' : 'Reset password'}
                        </Button>
                      )}
                      {u.status === 'active' && (
                        <Button size="sm" variant="ghost" icon={UserX} onClick={() => void act(() => api.updateUser(u.id, { isActive: false }))}>
                          Deactivate
                        </Button>
                      )}
                      {u.status === 'deactivated' && (
                        <Button size="sm" variant="ghost" icon={UserCheck} onClick={() => void act(() => api.updateUser(u.id, { isActive: true }))}>
                          Reactivate
                        </Button>
                      )}
                    </div>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {data && users.length === 0 && <EmptyState icon={UsersIcon} title="No matching people" />}
      </Card>

      <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3">
        <ShieldCheck className="size-3.5" /> Every invite, role change and deactivation is recorded in the audit trail.
      </p>

      {inviting && (
        <InviteDialog
          isOwner={isOwner}
          onClose={() => setInviting(false)}
          onInvited={(name, l) => {
            setInviting(false);
            setLink({ user: name, link: l });
            void reload();
          }}
        />
      )}
      {link && <LinkDialog name={link.user} link={link.link} onClose={() => setLink(null)} />}
    </div>
  );
}

function InviteDialog({ isOwner, onClose, onInvited }: { isOwner: boolean; onClose: () => void; onInvited: (name: string, link: InviteLink) => void }) {
  const [form, setForm] = useState({ fullName: '', email: '', role: 'project_manager' as Role });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.inviteUser(form);
      onInvited(res.user.fullName, res);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Invite a user" description="They’ll get a one-time link to set their own password.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name"><Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required maxLength={200} /></Field>
          <Field label="Work email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required maxLength={254} /></Field>
        </div>
        <Field label="Role" hint={ROLE_INFO[form.role]}>
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.filter((r) => isOwner || r !== 'owner').map((r) => (
              <option key={r} value={r}>{sentence(r)}</option>
            ))}
          </Select>
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" icon={MailPlus} loading={busy}>Create invite link</Button>
        </div>
      </form>
    </Dialog>
  );
}

function LinkDialog({ name, link, onClose }: { name: string; link: InviteLink; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const reset = link.purpose === 'reset';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.inviteUrl);
      setCopied(true);
    } catch {
      /* clipboard blocked: the link is selectable below */
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={reset ? `Password reset link for ${name}` : `Invite link for ${name}`}
      description={`Valid until ${dateTime(link.expiresAt)}. It works once, and is shown only now.`}
      wide
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <Input readOnly value={link.inviteUrl} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
          <Button icon={copied ? Check : Copy} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <Alert tone="warning" title="Send it privately">
          Share the link directly with {name} (e.g. a direct message to their work account). Anyone with the link can set the password.
        </Alert>
        <div className="flex justify-end border-t border-line pt-4">
          <Button variant="secondary" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}
