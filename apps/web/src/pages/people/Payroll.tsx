import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, CalendarDays, Clock, FileText, Lock, Plus, Settings, Trash2, Users, Wallet } from 'lucide-react';
import { api, type EmployeeDetail, type EmployeeInput, type EmployeeView, type LeaveRequest, type Me, type PayRun, type Project, type TimeEntry } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, sentence, zar } from '../../lib/format';
import { AmountInput, FormPanel, useAction } from '../../components/forms';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, StatusPill, Table, Tabs, Td, Th, Tr, cx } from '../../components/ui';

type Tab = 'employees' | 'time' | 'leave' | 'runs' | 'settings';
const PAYROLL = ['owner', 'admin', 'finance'];
const APPROVERS = ['owner', 'admin', 'project_manager'];
const today = () => new Date().toISOString().slice(0, 10);
const LEAVE_KINDS: LeaveRequest['kind'][] = ['annual', 'sick', 'family_responsibility', 'unpaid'];

export function Payroll({ me }: { me: Me }) {
  const role = me.user.role;
  const payroll = PAYROLL.includes(role);
  const [tab, setTab] = useState<Tab>('employees');
  const employees = useAsync(() => api.payroll.employees(), []);
  const projects = useAsync(() => api.projects(), []);
  const active = (employees.data ?? []).filter((e) => e.status === 'active');

  return (
    <div>
      <PageHeader
        title="HR & payroll"
        description="Employees and their tickets, site timesheets, BCEA leave, and monthly payroll with PAYE, UIF and SDL. Finalised payroll charges labour to projects and posts to the ledger."
        eyebrow={<Badge tone="brand">Module 1</Badge>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Active employees" icon={Users} value={String(active.length)} hint={`${active.filter((e) => e.payBasis === 'hourly').length} hourly · ${active.filter((e) => e.payBasis === 'monthly').length} monthly`} />
        <Stat label="Expired tickets" icon={BadgeCheck} value={String(active.filter((e) => e.expiredCertifications?.length).length)} hint={`${active.filter((e) => e.expiringCertifications?.length).length} people with tickets expiring in 30 days`} />
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'employees', label: 'Employees', icon: Users, count: active.length },
          { id: 'time', label: 'Timesheets', icon: Clock },
          { id: 'leave', label: 'Leave', icon: CalendarDays },
          ...(payroll ? [{ id: 'runs' as Tab, label: 'Pay runs', icon: Wallet }] : []),
          ...(role === 'owner' || role === 'admin' ? [{ id: 'settings' as Tab, label: 'Settings', icon: Settings }] : []),
        ]}
      />
      {employees.error && <Alert>{employees.error}</Alert>}
      {tab === 'employees' && <Employees me={me} list={employees.data} reload={employees.reload} />}
      {tab === 'time' && <Timesheets me={me} employees={active} projects={projects.data ?? []} />}
      {tab === 'leave' && <Leave me={me} employees={active} />}
      {tab === 'runs' && payroll && <PayRuns />}
      {tab === 'settings' && <PayrollSettingsCard />}
    </div>
  );
}

// =========================================================================== employees

function Employees({ me, list, reload }: { me: Me; list?: EmployeeView[]; reload: () => Promise<void> }) {
  const payroll = PAYROLL.includes(me.user.role);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  return (
    <Card padded={false}>
      <div className="p-5 pb-4"><CardHeader title="Employees" subtitle={payroll ? 'Personal details are visible to payroll staff only, and every view is recorded.' : 'Pay and personal details are visible to payroll staff only.'} actions={payroll && <Button size="sm" icon={Plus} onClick={() => setAdding(true)}>Add employee</Button>} /></div>
      {!list ? <Skeleton className="m-5 h-24" /> : list.length === 0 ? <EmptyState icon={Users} title="No employees yet" /> : (
        <Table>
          <thead><tr><Th>No.</Th><Th>Name</Th><Th>Occupation</Th><Th>Type</Th>{payroll && <Th right>Rate</Th>}<Th>Started</Th><Th>Tickets</Th></tr></thead>
          <tbody>
            {list.map((e) => (
              <Tr key={e.id} onClick={() => setViewing(e.id)} className={e.status === 'terminated' ? 'opacity-50' : undefined}>
                <Td mono>{e.employeeNo}</Td>
                <Td className="font-medium">{e.firstName} {e.lastName}{e.status === 'terminated' && <Badge className="ml-2">Left {date(e.endDate!)}</Badge>}</Td>
                <Td className="text-ink-2">{e.occupation}</Td>
                <Td className="text-ink-2">{sentence(e.employmentType)} · {e.payBasis}</Td>
                {payroll && <Td right>{zar(e.rate, true)}{e.payBasis === 'hourly' ? '/h' : '/m'}</Td>}
                <Td className="text-ink-2">{date(e.startDate)}</Td>
                <Td>
                  {e.expiredCertifications?.length ? <StatusPill status="critical">{e.expiredCertifications.join(', ')} expired</StatusPill>
                    : e.expiringCertifications?.length ? <StatusPill status="warning">{e.expiringCertifications.join(', ')} expiring</StatusPill>
                    : <span className="text-xs text-ink-3">—</span>}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <EmployeeDialog open={adding} onClose={() => setAdding(false)} onSaved={(e) => { void reload(); setViewing(e.id); }} />
      <EmployeeDetailDialog id={viewing} me={me} onClose={() => setViewing(null)} onChanged={() => void reload()} />
    </Card>
  );
}

function EmployeeDialog({ open, existing, onClose, onSaved }: { open: boolean; existing?: EmployeeDetail; onClose: () => void; onSaved: (e: EmployeeDetail) => void }) {
  const fields = {
    employeeNo: existing?.employeeNo ?? '', firstName: existing?.firstName ?? '', lastName: existing?.lastName ?? '', occupation: existing?.occupation ?? '',
    employmentType: (existing?.employmentType ?? 'permanent') as string, payBasis: (existing?.payBasis ?? 'monthly') as string, rate: existing?.rate ?? '', medicalAidMembers: String(existing?.medicalAidMembers ?? 0),
    startDate: existing?.startDate ?? today(), phone: existing?.phone ?? '',
    idNumber: existing?.private?.idNumber ?? '', passportNo: existing?.private?.passportNo ?? '', taxNumber: existing?.private?.taxNumber ?? '', dateOfBirth: existing?.private?.dateOfBirth ?? '',
  };
  return (
    <FormPanel open={open} wide title={existing ? `Edit ${existing.firstName} ${existing.lastName}` : 'Add employee'} description="Bank details are not stored in ConstructOS." fields={fields} onClose={onClose} submitLabel={existing ? 'Save' : 'Add employee'}
      submit={async (f) => {
        const body: EmployeeInput = {
          employeeNo: f.employeeNo, firstName: f.firstName, lastName: f.lastName, occupation: f.occupation,
          employmentType: f.employmentType as EmployeeInput['employmentType'], payBasis: f.payBasis as EmployeeInput['payBasis'], rate: f.rate,
          medicalAidMembers: Number(f.medicalAidMembers || 0), startDate: f.startDate, phone: f.phone || null,
          private: { idNumber: f.idNumber || null, passportNo: f.passportNo || null, taxNumber: f.taxNumber || null, dateOfBirth: f.dateOfBirth },
        };
        onSaved(existing ? await api.payroll.updateEmployee(existing.id, body) : await api.payroll.addEmployee(body));
      }}
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Employee no."><Input value={f.employeeNo} onChange={(e) => set({ employeeNo: e.target.value })} required maxLength={20} /></Field>
            <Field label="First name"><Input value={f.firstName} onChange={(e) => set({ firstName: e.target.value })} required maxLength={100} /></Field>
            <Field label="Surname"><Input value={f.lastName} onChange={(e) => set({ lastName: e.target.value })} required maxLength={100} /></Field>
            <Field label="Occupation"><Input value={f.occupation} onChange={(e) => set({ occupation: e.target.value })} required maxLength={100} /></Field>
            <Field label="Employment"><Select value={f.employmentType} onChange={(e) => set({ employmentType: e.target.value })}><option value="permanent">Permanent</option><option value="fixed_term">Fixed term</option><option value="casual">Casual</option></Select></Field>
            <Field label="Paid"><Select value={f.payBasis} onChange={(e) => set({ payBasis: e.target.value })}><option value="monthly">Monthly salary</option><option value="hourly">Hourly</option></Select></Field>
            <Field label={f.payBasis === 'hourly' ? 'Rate per hour (R)' : 'Monthly salary (R)'}><AmountInput value={f.rate} onChange={(rate) => set({ rate })} required /></Field>
            <Field label="Start date"><Input type="date" value={f.startDate} onChange={(e) => set({ startDate: e.target.value })} required /></Field>
          </div>
          <div className="rounded-lg border border-line p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink-3"><Lock className="size-3.5" /> Personal details (payroll staff only)</div>
            <div className="grid gap-4 sm:grid-cols-4">
              <Field label="SA ID number"><Input value={f.idNumber} onChange={(e) => set({ idNumber: e.target.value })} pattern="\d{13}" /></Field>
              <Field label="Passport (if no ID)"><Input value={f.passportNo} onChange={(e) => set({ passportNo: e.target.value })} maxLength={20} /></Field>
              <Field label="Date of birth" hint="For age-based tax rebates"><Input type="date" value={f.dateOfBirth} onChange={(e) => set({ dateOfBirth: e.target.value })} required /></Field>
              <Field label="SARS tax number"><Input value={f.taxNumber} onChange={(e) => set({ taxNumber: e.target.value })} pattern="\d{10}" /></Field>
              <Field label="Medical aid members" hint="Main member + dependants, for the tax credit"><Input type="number" min={0} max={20} value={f.medicalAidMembers} onChange={(e) => set({ medicalAidMembers: e.target.value })} /></Field>
              <Field label="Phone"><Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={30} /></Field>
            </div>
          </div>
        </>
      )} />
  );
}

function EmployeeDetailDialog({ id, me, onClose, onChanged }: { id: string | null; me: Me; onClose: () => void; onChanged: () => void }) {
  const role = me.user.role;
  const payroll = PAYROLL.includes(role);
  const [e, setE] = useState<EmployeeDetail>();
  const [panel, setPanel] = useState<null | 'edit' | 'cert' | 'terminate'>(null);
  const action = useAction();
  useEffect(() => { setE(undefined); if (id) void api.payroll.employee(id).then(setE); }, [id]);
  const update = (next: EmployeeDetail) => { setE(next); onChanged(); };
  return (
    <Dialog open={id !== null} onClose={onClose} title={e ? `${e.firstName} ${e.lastName}` : 'Employee'} description={e ? `${e.employeeNo} · ${e.occupation} · since ${date(e.startDate)}` : undefined} wide>
      {!e ? <Skeleton className="h-48" /> : (
        <div className="space-y-5 text-sm">
          {e.status === 'active' && (
            <div className="flex flex-wrap gap-1.5">
              {payroll && <Button size="sm" variant="secondary" onClick={() => setPanel('edit')}>Edit</Button>}
              {role !== 'site_foreman' && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setPanel('cert')}>Ticket / certificate</Button>}
              {payroll && <Button size="sm" variant="ghost" onClick={() => setPanel('terminate')}>Terminate</Button>}
            </div>
          )}
          {action.error && <Alert>{action.error}</Alert>}
          {payroll && e.private && (
            <dl className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 sm:grid-cols-4">
              <div><dt className="text-xs text-ink-3">Pay</dt><dd>{zar(e.rate, true)} {e.payBasis === 'hourly' ? 'per hour' : 'per month'}</dd></div>
              <div><dt className="text-xs text-ink-3">ID / passport</dt><dd className="font-mono">{e.private.idNumber ?? e.private.passportNo}</dd></div>
              <div><dt className="text-xs text-ink-3">Date of birth</dt><dd>{date(e.private.dateOfBirth)}</dd></div>
              <div><dt className="text-xs text-ink-3">Tax number</dt><dd className="font-mono">{e.private.taxNumber ?? '—'}</dd></div>
            </dl>
          )}
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Leave balances (BCEA)</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              {e.leaveBalances.map((b) => (
                <div key={b.kind} className="rounded-lg border border-line p-3">
                  <div className="text-xs text-ink-3">{sentence(b.kind)}</div>
                  <div className="text-lg font-semibold">{b.balance} days</div>
                  <div className="text-xs text-ink-3">{b.taken} of {b.entitlement} taken since {date(b.cycleStart)}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Tickets and certificates</h4>
            {e.certifications.length === 0 ? <p className="text-ink-3">None recorded.</p> : e.certifications.map((c) => (
              <div key={c.id} className="flex items-center gap-2 py-1">
                <span className="flex-1">{c.kind}{c.certificateNo ? <span className="text-ink-3"> · {c.certificateNo}</span> : null}</span>
                {c.expiresOn ? (c.expired ? <StatusPill status="critical">Expired {date(c.expiresOn)}</StatusPill> : <span className="text-xs text-ink-3">Expires {date(c.expiresOn)}</span>) : <span className="text-xs text-ink-3">No expiry</span>}
                {role !== 'site_foreman' && <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => void action.run(async () => update(await api.payroll.removeCertification(c.id)))} />}
              </div>
            ))}
          </div>
          {payroll && <EmployeeDialog open={panel === 'edit'} existing={e} onClose={() => setPanel(null)} onSaved={update} />}
          <FormPanel open={panel === 'cert'} title="Add ticket or certificate" fields={{ kind: '', certificateNo: '', issuedOn: '', expiresOn: '' }} onClose={() => setPanel(null)}
            submit={(f) => api.payroll.addCertification(e.id, { kind: f.kind, certificateNo: f.certificateNo || null, issuedOn: f.issuedOn, expiresOn: f.expiresOn || null }).then(update)}
            render={(f, set) => (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Ticket / certificate" className="sm:col-span-2"><Input value={f.kind} onChange={(ev) => set({ kind: ev.target.value })} required maxLength={100} placeholder="Working at heights · Medical fitness · First aid level 1" /></Field>
                <Field label="Certificate no."><Input value={f.certificateNo} onChange={(ev) => set({ certificateNo: ev.target.value })} maxLength={60} /></Field>
                <Field label="Issued"><Input type="date" value={f.issuedOn} onChange={(ev) => set({ issuedOn: ev.target.value })} required /></Field>
                <Field label="Expires"><Input type="date" value={f.expiresOn} onChange={(ev) => set({ expiresOn: ev.target.value })} /></Field>
              </div>
            )} />
          <FormPanel open={panel === 'terminate'} danger title={`Terminate ${e.firstName} ${e.lastName}`} description="The record is kept. Time and pay after the last working day are refused." fields={{ endDate: today(), reason: '' }} onClose={() => setPanel(null)}
            submit={(f) => api.payroll.terminate(e.id, f.endDate, f.reason).then(update)}
            render={(f, set) => (
              <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                <Field label="Last working day"><Input type="date" value={f.endDate} onChange={(ev) => set({ endDate: ev.target.value })} required /></Field>
                <Field label="Reason"><Input value={f.reason} onChange={(ev) => set({ reason: ev.target.value })} required maxLength={500} placeholder="Resignation / end of contract / dismissal" /></Field>
              </div>
            )} />
        </div>
      )}
    </Dialog>
  );
}

// =========================================================================== timesheets

function Timesheets({ me, employees, projects }: { me: Me; employees: EmployeeView[]; projects: Project[] }) {
  const canApprove = APPROVERS.includes(me.user.role);
  const [range, setRange] = useState({ from: new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10), to: today() });
  const entries = useAsync(() => api.payroll.timesheets(range), [range.from, range.to]);
  const [capturing, setCapturing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const action = useAction();
  const submitted = (entries.data ?? []).filter((t) => t.status === 'submitted');
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const decide = (approve: boolean) => action.run(async () => {
    const ids = [...selected];
    if (approve) await api.payroll.approveTime(ids); else await api.payroll.rejectTime(ids);
    setSelected(new Set());
    await entries.reload();
  });

  return (
    <Card padded={false}>
      <div className="p-5 pb-4">
        <CardHeader title="Site timesheets" subtitle="Captured on site, approved by the project manager. Approved hours pay hourly staff and allocate everyone’s cost to projects."
          actions={
            <>
              <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="w-36" aria-label="From" />
              <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="w-36" aria-label="To" />
              <Button size="sm" icon={Plus} onClick={() => setCapturing(true)}>Capture crew time</Button>
            </>
          } />
      </div>
      {action.error && <div className="px-5 pb-3"><Alert>{action.error}</Alert></div>}
      {canApprove && submitted.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-y border-line bg-surface-2 px-5 py-2 text-sm">
          <span>{submitted.length} awaiting approval</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(submitted.filter((t) => t.capturedBy !== me.user.id || me.user.role === 'owner').map((t) => t.id)))}>Select all I can approve</Button>
          <span className="ml-auto" />
          <Button size="sm" variant="ghost" disabled={!selected.size} onClick={() => void decide(false)}>Reject</Button>
          <Button size="sm" disabled={!selected.size} loading={action.busy} onClick={() => void decide(true)}>Approve {selected.size || ''}</Button>
        </div>
      )}
      {!entries.data ? <Skeleton className="m-5 h-24" /> : entries.data.length === 0 ? <EmptyState icon={Clock} title="No time captured in this period" /> : (
        <Table>
          <thead><tr>{canApprove && <Th />}<Th>Date</Th><Th>Employee</Th><Th>Project</Th><Th right>Normal</Th><Th right>Overtime</Th><Th right>Sunday</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {entries.data.map((t: TimeEntry) => (
              <Tr key={t.id}>
                {canApprove && <Td>{t.status === 'submitted' && <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.employeeName} ${t.workDate}`} />}</Td>}
                <Td className="whitespace-nowrap text-ink-2">{date(t.workDate)}</Td>
                <Td className="font-medium">{t.employeeName}</Td>
                <Td className="text-ink-2">{t.projectCode}{t.costCode ? ` · ${t.costCode}` : ''}</Td>
                <Td right>{Number(t.normalHours) || '—'}</Td>
                <Td right>{Number(t.overtimeHours) || '—'}</Td>
                <Td right>{Number(t.sundayHours) || '—'}</Td>
                <Td><Badge tone={t.status === 'approved' ? 'good' : t.status === 'rejected' ? 'critical' : 'warning'} dot><span className="capitalize">{t.status}</span></Badge></Td>
                <Td className="text-right">{t.status !== 'approved' && <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={() => void action.run(async () => { await api.payroll.deleteTime(t.id); await entries.reload(); })} />}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <CrewTime open={capturing} employees={employees} projects={projects} onClose={() => setCapturing(false)} onDone={() => void entries.reload()} />
    </Card>
  );
}

/** One project, one cost code, one date: hours for each person in the crew. */
function CrewTime({ open, employees, projects, onClose, onDone }: { open: boolean; employees: EmployeeView[]; projects: Project[]; onClose: () => void; onDone: () => void }) {
  const [codes, setCodes] = useState<{ id: string; code: string; description: string }[]>([]);
  const [head, setHead] = useState({ projectId: '', costCodeId: '', workDate: today() });
  const [rows, setRows] = useState<Record<string, { normal: string; overtime: string; sunday: string }>>({});
  useEffect(() => { if (open) { setHead({ projectId: '', costCodeId: '', workDate: today() }); setRows({}); } }, [open]);
  useEffect(() => { setCodes([]); if (head.projectId) void api.payroll.costCodes(head.projectId).then(setCodes); }, [head.projectId]);
  const isSunday = new Date(`${head.workDate}T00:00:00Z`).getUTCDay() === 0;
  const crew = useMemo(() => employees.filter((e) => !head.projectId || !e.defaultProjectId || e.defaultProjectId === head.projectId), [employees, head.projectId]);
  const set = (id: string, k: 'normal' | 'overtime' | 'sunday', v: string) => setRows((r) => ({ ...r, [id]: { normal: '', overtime: '', sunday: '', ...r[id], [k]: v } }));
  return (
    <FormPanel open={open} wide title="Capture crew time" description={isSunday ? 'Sunday: enter hours in the Sunday column (paid at double time).' : 'Leave a row blank for someone who did not work.'} fields={{}} onClose={onClose} submitLabel="Submit for approval"
      submit={async () => {
        const entries = Object.entries(rows)
          .filter(([, r]) => Number(r.normal) || Number(r.overtime) || Number(r.sunday))
          .map(([employeeId, r]) => ({ employeeId, ...head, normalHours: r.normal || undefined, overtimeHours: r.overtime || undefined, sundayHours: r.sunday || undefined }));
        if (!entries.length) throw new Error('Enter hours for at least one person');
        await api.payroll.captureTime(entries);
        onDone();
      }}
      render={() => (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Project"><Select value={head.projectId} onChange={(e) => setHead({ ...head, projectId: e.target.value, costCodeId: '' })} required><option value="">Choose…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
            <Field label="Cost code"><Select value={head.costCodeId} onChange={(e) => setHead({ ...head, costCodeId: e.target.value })} required><option value="">{head.projectId && !codes.length ? 'No cost codes on this project' : 'Choose…'}</option>{codes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" value={head.workDate} max={today()} onChange={(e) => setHead({ ...head, workDate: e.target.value })} required /></Field>
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-lg border border-line">
            <Table>
              <thead><tr><Th>Employee</Th><Th right>Normal</Th><Th right>Overtime ×1.5</Th><Th right>Sunday ×2</Th></tr></thead>
              <tbody>
                {crew.map((e) => (
                  <Tr key={e.id}>
                    <Td><span className="font-medium">{e.firstName} {e.lastName}</span> <span className="text-xs text-ink-3">{e.occupation}</span>{e.expiredCertifications?.length ? <StatusPill status="critical">Expired ticket</StatusPill> : null}</Td>
                    {(['normal', 'overtime', 'sunday'] as const).map((k) => (
                      <Td key={k} right className="w-28"><Input inputMode="decimal" className={cx('w-20 text-right')} value={rows[e.id]?.[k] ?? ''} onChange={(ev) => set(e.id, k, ev.target.value)} pattern="\d{1,2}(\.\d{1,2})?" aria-label={`${k} hours for ${e.firstName}`} /></Td>
                    ))}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )} />
  );
}

// =========================================================================== leave

function Leave({ me, employees }: { me: Me; employees: EmployeeView[] }) {
  const canApprove = APPROVERS.includes(me.user.role);
  const leave = useAsync(() => api.payroll.leave(), []);
  const [requesting, setRequesting] = useState(false);
  const action = useAction();
  return (
    <Card padded={false}>
      <div className="p-5 pb-4"><CardHeader title="Leave" subtitle="Annual, sick and family responsibility leave as per the BCEA; unpaid leave is deducted in payroll. Someone other than the person who captured a request must approve it." actions={<Button size="sm" icon={Plus} onClick={() => setRequesting(true)}>Capture leave</Button>} /></div>
      {action.error && <div className="px-5 pb-3"><Alert>{action.error}</Alert></div>}
      {leave.data?.length === 0 ? <EmptyState icon={CalendarDays} title="No leave captured" /> : (
        <Table>
          <thead><tr><Th>Employee</Th><Th>Type</Th><Th>From</Th><Th>To</Th><Th right>Days</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {leave.data?.map((l) => (
              <Tr key={l.id}>
                <Td className="font-medium">{l.employeeName}</Td>
                <Td>{sentence(l.kind)}</Td>
                <Td className="text-ink-2">{date(l.startsOn)}</Td>
                <Td className="text-ink-2">{date(l.endsOn)}</Td>
                <Td right>{l.days}</Td>
                <Td><Badge tone={l.status === 'approved' ? 'good' : l.status === 'requested' ? 'warning' : 'neutral'} dot><span className="capitalize">{l.status}</span></Badge></Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {canApprove && l.status === 'requested' && l.createdBy !== me.user.id && (
                      <>
                        <Button size="sm" onClick={() => void action.run(async () => { await api.payroll.decideLeave(l.id, 'approved'); await leave.reload(); })}>Approve</Button>
                        <Button size="sm" variant="ghost" onClick={() => void action.run(async () => { await api.payroll.decideLeave(l.id, 'rejected'); await leave.reload(); })}>Reject</Button>
                      </>
                    )}
                    {(l.status === 'requested' || (l.status === 'approved' && canApprove)) && <Button size="sm" variant="ghost" onClick={() => void action.run(async () => { await api.payroll.cancelLeave(l.id); await leave.reload(); })}>Cancel</Button>}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <FormPanel open={requesting} title="Capture leave" description="Days are counted Monday to Friday. Public holidays are not excluded automatically." fields={{ employeeId: '', kind: 'annual', startsOn: '', endsOn: '', note: '' }} onClose={() => setRequesting(false)}
        submit={(f) => api.payroll.requestLeave({ employeeId: f.employeeId, kind: f.kind as LeaveRequest['kind'], startsOn: f.startsOn, endsOn: f.endsOn, note: f.note || undefined }).then(() => leave.reload())}
        render={(f, set) => (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Employee"><Select value={f.employeeId} onChange={(e) => set({ employeeId: e.target.value })} required><option value="">Choose…</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</Select></Field>
            <Field label="Type"><Select value={f.kind} onChange={(e) => set({ kind: e.target.value })}>{LEAVE_KINDS.map((k) => <option key={k} value={k}>{sentence(k)}</option>)}</Select></Field>
            <Field label="From"><Input type="date" value={f.startsOn} onChange={(e) => set({ startsOn: e.target.value })} required /></Field>
            <Field label="To"><Input type="date" value={f.endsOn} onChange={(e) => set({ endsOn: e.target.value })} required /></Field>
            <Field label="Note" className="sm:col-span-2"><Input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} placeholder="Sick note received, etc." /></Field>
          </div>
        )} />
    </Card>
  );
}

// =========================================================================== pay runs

function PayRuns() {
  const runs = useAsync(() => api.payroll.runs(), []);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const month = today().slice(0, 7);
  return (
    <Card padded={false}>
      <div className="p-5 pb-4"><CardHeader title="Pay runs" subtitle="Monthly. Draft, check, then finalise: finalising freezes the month and posts it to projects and the ledger." actions={<Button size="sm" icon={Plus} onClick={() => setCreating(true)}>New pay run</Button>} /></div>
      {runs.data?.length === 0 ? <EmptyState icon={Wallet} title="No pay runs yet" /> : (
        <Table>
          <thead><tr><Th>Period</Th><Th>Pay date</Th><Th>Status</Th><Th right>Gross</Th><Th right>PAYE</Th><Th right>UIF</Th><Th right>SDL</Th><Th right>Net pay</Th></tr></thead>
          <tbody>
            {runs.data?.map((r) => (
              <Tr key={r.id} onClick={() => setViewing(r.id)}>
                <Td className="font-medium">{r.period}</Td>
                <Td className="text-ink-2">{date(r.payDate)}</Td>
                <Td><Badge tone={r.status === 'finalised' ? 'good' : 'warning'} dot><span className="capitalize">{r.status}</span></Badge></Td>
                <Td right>{zar(r.grossTotal, true)}</Td>
                <Td right>{zar(r.payeTotal, true)}</Td>
                <Td right>{zar(r.uifTotal, true)}</Td>
                <Td right>{zar(r.sdlTotal, true)}</Td>
                <Td right className="font-semibold">{zar(r.netTotal, true)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <FormPanel open={creating} title="New pay run" description="Builds payslips from current rates, approved timesheets and approved unpaid leave. Nothing is posted until you finalise." fields={{ period: month, payDate: `${month}-25` }} onClose={() => setCreating(false)}
        submit={(f) => api.payroll.createRun(f.period, f.payDate).then((r) => { void runs.reload(); setViewing(r.id); })}
        render={(f, set) => (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Month"><Input type="month" value={f.period} onChange={(e) => set({ period: e.target.value })} required /></Field>
            <Field label="Pay date" hint="Sets the SARS tax year"><Input type="date" value={f.payDate} onChange={(e) => set({ payDate: e.target.value })} required /></Field>
          </div>
        )} />
      <PayRunDialog id={viewing} onClose={() => setViewing(null)} onChanged={() => void runs.reload()} />
    </Card>
  );
}

function PayRunDialog({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const [run, setRun] = useState<PayRun>();
  const [slip, setSlip] = useState<string | null>(null);
  const [emp, setEmp] = useState<Awaited<ReturnType<typeof api.payroll.emp201>>>();
  const action = useAction();
  useEffect(() => { setRun(undefined); setEmp(undefined); setSlip(null); if (id) void api.payroll.run(id).then(setRun); }, [id]);
  const update = (r: PayRun) => { setRun(r); onChanged(); };
  const open = run?.payslips?.find((p) => p.id === slip);
  return (
    <Dialog open={id !== null} onClose={onClose} title={run ? `Payroll ${run.period}` : 'Pay run'} description={run ? `Pay date ${date(run.payDate)} · tax year ${run.taxYear}` : undefined} wide>
      {!run ? <Skeleton className="h-48" /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={run.status === 'finalised' ? 'good' : 'warning'} dot><span className="capitalize">{run.status}</span></Badge>
            {run.status === 'draft' && run.pendingTimesheets! > 0 && <StatusPill status="warning">{run.pendingTimesheets} timesheet entries awaiting approval</StatusPill>}
            <div className="ml-auto flex gap-1.5">
              {run.status === 'draft' && <Button size="sm" variant="secondary" onClick={() => void action.run(async () => update(await api.payroll.recalculate(run.id)))}>Recalculate</Button>}
              {run.status === 'draft' && <Button size="sm" icon={Lock} loading={action.busy} onClick={() => void action.run(async () => update(await api.payroll.finalise(run.id)))}>Finalise</Button>}
              <Button size="sm" variant="ghost" icon={FileText} onClick={() => void action.run(async () => setEmp(await api.payroll.emp201(run.id)))}>EMP201</Button>
            </div>
          </div>
          {action.error && <Alert>{action.error}</Alert>}
          {emp && (
            <Alert tone="info" title={`EMP201 for ${emp.period}: ${zar(emp.total, true)} due by ${date(emp.dueOn)}`}>
              PAYE {zar(emp.paye, true)} · UIF {zar(emp.uif, true)} · SDL {zar(emp.sdl, true)}. {emp.note}
            </Alert>
          )}
          <div className="overflow-x-auto rounded-lg border border-line">
            <Table>
              <thead><tr><Th>Employee</Th><Th right>Hours</Th><Th right>Gross</Th><Th right>PAYE</Th><Th right>UIF</Th><Th right>Net</Th><Th right>Cost to company</Th></tr></thead>
              <tbody>
                {run.payslips?.map((p) => (
                  <Tr key={p.id} onClick={() => setSlip(p.id === slip ? null : p.id)}>
                    <Td className="font-medium">{p.employeeName}<div className="text-xs font-normal text-ink-3">{p.employeeNo} · {p.occupation}</div></Td>
                    <Td right className="text-ink-2">{Number(p.hoursWorked) || '—'}</Td>
                    <Td right>{zar(p.gross, true)}</Td>
                    <Td right>{zar(p.paye, true)}</Td>
                    <Td right>{zar(p.uifEmployee, true)}</Td>
                    <Td right className="font-semibold">{zar(p.net, true)}</Td>
                    <Td right className="text-ink-2">{zar(p.employerCost, true)}</Td>
                  </Tr>
                ))}
                <Tr className="font-semibold"><Td>Total</Td><Td /><Td right>{zar(run.grossTotal, true)}</Td><Td right>{zar(run.payeTotal, true)}</Td><Td /><Td right>{zar(run.netTotal, true)}</Td><Td /></Tr>
              </tbody>
            </Table>
          </div>
          {open && (
            <div className="rounded-lg border border-line p-4">
              <h4 className="mb-2 font-semibold">Payslip: {open.employeeName}</h4>
              {open.earnings.map((e) => (
                <div key={e.code} className="flex justify-between gap-4 py-0.5"><span>{e.label} <span className="text-xs text-ink-3">{Number(e.quantity) !== 1 ? `${Number(e.quantity)} × ${zar(e.rate, true)}` : ''}</span></span><span className="num">{zar(e.amount, true)}</span></div>
              ))}
              <div className="mt-1 flex justify-between border-t border-line pt-1 font-medium"><span>Gross</span><span className="num">{zar(open.gross, true)}</span></div>
              <div className="flex justify-between"><span>PAYE</span><span className="num">−{zar(open.paye, true)}</span></div>
              <div className="flex justify-between"><span>UIF (1%)</span><span className="num">−{zar(open.uifEmployee, true)}</span></div>
              <div className="flex justify-between border-t border-line pt-1 text-base font-semibold"><span>Net pay</span><span className="num">{zar(open.net, true)}</span></div>
              <p className="mt-2 text-xs text-ink-3">Employer contributions: UIF {zar(open.uifEmployer, true)}, SDL {zar(open.sdl, true)}.</p>
            </div>
          )}
          <p className="text-xs text-ink-3">Not calculated: Employment Tax Incentive, retirement fund contributions, fringe benefits, bonuses and other irregular pay. Check payroll before paying staff.</p>
        </div>
      )}
    </Dialog>
  );
}

function PayrollSettingsCard() {
  const settings = useAsync(() => api.payroll.settings(), []);
  const [form, setForm] = useState({ sdlLiable: true, monthlyHours: '195.0', payeReference: '', uifReference: '' });
  const [msg, setMsg] = useState<{ tone: 'good' | 'critical'; text: string } | null>(null);
  useEffect(() => { const s = settings.data; if (s) setForm({ sdlLiable: s.sdlLiable, monthlyHours: s.monthlyHours, payeReference: s.payeReference ?? '', uifReference: s.uifReference ?? '' }); }, [settings.data]);
  const save = async () => {
    setMsg(null);
    try {
      await api.payroll.updateSettings({ sdlLiable: form.sdlLiable, monthlyHours: form.monthlyHours, payeReference: form.payeReference || null, uifReference: form.uifReference || null });
      setMsg({ tone: 'good', text: 'Saved.' });
    } catch (err) {
      setMsg({ tone: 'critical', text: (err as Error).message });
    }
  };
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card className="space-y-4">
        <CardHeader title="Payroll settings" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="PAYE reference" hint="10 digits starting with 7"><Input value={form.payeReference} onChange={(e) => setForm({ ...form, payeReference: e.target.value })} pattern="7\d{9}" /></Field>
          <Field label="UIF reference"><Input value={form.uifReference} onChange={(e) => setForm({ ...form, uifReference: e.target.value })} maxLength={20} /></Field>
          <Field label="Hours in a month" hint="Turns a salary into an hourly rate for overtime (45 h week = 195)"><Input inputMode="decimal" value={form.monthlyHours} onChange={(e) => setForm({ ...form, monthlyHours: e.target.value })} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={form.sdlLiable} onChange={(e) => setForm({ ...form, sdlLiable: e.target.checked })} /> Pay SDL (annual payroll over R500 000)</label>
        </div>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <div className="flex justify-end"><Button onClick={() => void save()}>Save</Button></div>
      </Card>
      <Card>
        <CardHeader title="SARS tax tables loaded" subtitle="A pay run can only be made for a tax year listed here. New tables are added with each release after SARS publishes them." />
        <ul className="mt-3 space-y-2 text-sm">
          {settings.data?.taxTables.map((t) => <li key={t.taxYear}><span className="font-medium">{t.taxYear}</span> <span className="text-ink-3">· {date(t.startsOn)} to {date(t.endsOn)} · {t.source}</span></li>)}
        </ul>
      </Card>
    </div>
  );
}
