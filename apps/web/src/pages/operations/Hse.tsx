import { useEffect, useState } from 'react';
import { ClipboardCheck, FileWarning, HardHat, ListChecks, Megaphone, Plus, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, Users } from 'lucide-react';
import { api, type CorrectiveAction, type Incident, type IncidentSeverity, type IncidentType, type InspectionRecord, type Me, type Ncr, type Project } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, dateTime, sentence, zar } from '../../lib/format';
import { AmountInput, FormPanel, useAction } from '../../components/forms';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, StatusPill, Table, Tabs, Td, Textarea, Th, Tr, cx } from '../../components/ui';
import { ChartCard, TrendChart } from '../../components/charts';

type Tab = 'overview' | 'incidents' | 'inspections' | 'ncrs' | 'actions' | 'talks';
const REPORTERS = ['owner', 'admin', 'project_manager', 'site_foreman', 'finance'];
const SIGN_OFF = ['owner', 'admin', 'project_manager'];
const TYPES: IncidentType[] = ['injury', 'near_miss', 'property_damage', 'environmental', 'dangerous_occurrence', 'vehicle'];
const SEVERITIES: IncidentSeverity[] = ['none', 'first_aid', 'medical_treatment', 'restricted_work', 'lost_time', 'fatality'];
const today = () => new Date().toISOString().slice(0, 10);
const SEV_TONE: Record<IncidentSeverity, 'neutral' | 'warning' | 'serious' | 'critical'> = {
  none: 'neutral', first_aid: 'neutral', medical_treatment: 'warning', restricted_work: 'warning', lost_time: 'serious', fatality: 'critical',
};

export function Hse({ me }: { me: Me }) {
  const role = me.user.role;
  const canReport = REPORTERS.includes(role);
  const [tab, setTab] = useState<Tab>('overview');
  const kpis = useAsync(() => api.hse.kpis(), []);
  const incidents = useAsync(() => api.hse.incidents(), []);
  const inspections = useAsync(() => api.hse.inspections(), []);
  const ncrs = useAsync(() => api.hse.ncrs(), []);
  const actions = useAsync(() => api.hse.actions(), []);
  const talks = useAsync(() => api.hse.talks(), []);
  const projects = useAsync(() => api.projects(), []);
  const [reporting, setReporting] = useState(false);
  const [incidentId, setIncidentId] = useState<string | null>(null);
  const [ncrId, setNcrId] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [raisingNcr, setRaisingNcr] = useState<{ inspectionId?: string; projectId?: string } | null>(null);
  const [talking, setTalking] = useState(false);
  const reloadAll = () => void Promise.all([kpis.reload(), incidents.reload(), inspections.reload(), ncrs.reload(), actions.reload(), talks.reload()]);
  const k = kpis.data;

  return (
    <div>
      <PageHeader
        title="HSE & quality"
        description="Incident reporting and investigation (OHS Act section 24 and COIDA prompts), toolbox talks, signed inspection checklists, non-conformance reports and one list of corrective actions."
        eyebrow={<Badge tone="brand">Module 8</Badge>}
        actions={canReport && <Button icon={Megaphone} variant="danger" onClick={() => setReporting(true)}>Report incident</Button>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Days since last LTI" icon={ShieldCheck} value={k ? (k.daysSinceLastLti ?? 'None in period') : '…'} hint={k ? `${k.lostTimeInjuries} LTI · ${k.daysLost} days lost, last 12 months` : undefined} />
        <Stat label="LTIFR" icon={HardHat} value={k?.ltifr ?? '—'} hint={k ? `per 1 000 000 hours · TRIFR ${k.trifr ?? '—'} · ${k.manHours.toLocaleString('en-ZA')} hours from site diaries` : undefined} />
        <Stat label="Near misses" icon={TriangleAlert} value={k ? String(k.nearMisses) : '…'} hint="last 12 months: a healthy reporting culture" />
        <Stat label="Open corrective actions" icon={ListChecks} value={k ? String(k.openActions) : '…'} hint={k ? `${k.overdueActions} overdue · ${k.openNcrs} open NCRs` : undefined} />
      </div>
      {k && k.unreported > 0 && <div className="mb-6"><Alert tone="warning" title={`${k.unreported} incident(s) may need reporting to an authority`}>OHS Act section 24 (Department of Employment and Labour) or COIDA (Compensation Fund). Open each flagged incident to record the date it was reported.</Alert></div>}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview', icon: ShieldCheck },
          { id: 'incidents', label: 'Incidents', icon: ShieldAlert, count: incidents.data?.length },
          { id: 'inspections', label: 'Inspections', icon: ClipboardCheck, count: inspections.data?.length },
          { id: 'ncrs', label: 'NCRs', icon: FileWarning, count: ncrs.data?.filter((n) => n.status !== 'closed').length },
          { id: 'actions', label: 'Corrective actions', icon: ListChecks, count: actions.data?.filter((a) => a.status === 'open').length },
          { id: 'talks', label: 'Toolbox talks', icon: Users, count: talks.data?.length },
        ]}
      />

      {tab === 'overview' && (
        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <ChartCard title="Incidents by month" subtitle="All reported events, of which recordable (medical treatment or worse) and near misses" table={{ columns: ['Month', 'All', 'Recordable', 'Near misses'], rows: (k?.monthly ?? []).map((m) => [m.month, m.incidents, m.recordable, m.nearMisses]) }}>
            {!k?.monthly.length ? <EmptyState icon={ShieldCheck} title="No incidents in the last 12 months" /> : (
              <TrendChart data={k.monthly} xKey="month" format={(v) => String(Math.round(v))} series={[
                { key: 'incidents', label: 'All', color: 'var(--series-1)' },
                { key: 'recordable', label: 'Recordable', color: 'var(--series-2)' },
                { key: 'nearMisses', label: 'Near misses', color: 'var(--series-3)' },
              ]} />
            )}
          </ChartCard>
          <ActionList title="Overdue and due actions" actions={(actions.data ?? []).filter((a) => a.status === 'open').slice(0, 8)} canComplete={canReport} onChanged={reloadAll} />
        </div>
      )}

      {tab === 'incidents' && (
        <Card padded={false}>
          {incidents.data?.length === 0 ? <EmptyState icon={ShieldCheck} title="No incidents reported" /> : (
            <Table>
              <thead><tr><Th>No.</Th><Th>When</Th><Th>Incident</Th><Th>Type</Th><Th>Severity</Th><Th>Status</Th><Th>Reporting</Th></tr></thead>
              <tbody>
                {incidents.data?.map((i) => (
                  <Tr key={i.id} onClick={() => setIncidentId(i.id)}>
                    <Td mono>{i.number}</Td>
                    <Td className="whitespace-nowrap text-ink-2">{dateTime(i.occurredAt)}</Td>
                    <Td><div className="font-medium">{i.title}</div><div className="text-xs text-ink-3">{[i.projectCode, i.location].filter(Boolean).join(' · ')}</div></Td>
                    <Td>{sentence(i.type)}</Td>
                    <Td><Badge tone={SEV_TONE[i.severity]}>{sentence(i.severity)}</Badge></Td>
                    <Td><Badge tone={i.status === 'closed' ? 'good' : 'warning'} dot><span className="capitalize">{i.status}</span></Badge></Td>
                    <Td><Reporting i={i} /></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'inspections' && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Inspections" subtitle="Signed checklists cannot be edited. Raise an NCR from a failed quality inspection." actions={canReport && <Button size="sm" icon={Plus} onClick={() => setInspecting(true)}>New inspection</Button>} /></div>
          {inspections.data?.length === 0 ? <EmptyState icon={ClipboardCheck} title="No inspections yet" /> : (
            <Table>
              <thead><tr><Th>No.</Th><Th>Date</Th><Th>Inspection</Th><Th>Type</Th><Th>Inspector</Th><Th>Result</Th><Th /></tr></thead>
              <tbody>
                {inspections.data?.map((i) => (
                  <Tr key={i.id}>
                    <Td mono>{i.number}</Td>
                    <Td className="text-ink-2">{date(i.inspectedOn)}</Td>
                    <Td><div className="font-medium">{i.title}</div><div className="text-xs text-ink-3">{i.projectCode} · {i.items.filter((x) => x.result === 'fail').map((x) => x.item).join(', ')}</div></Td>
                    <Td>{sentence(i.kind)}</Td>
                    <Td className="text-ink-2">{i.inspectorName}</Td>
                    <Td>{i.passed ? <StatusPill status="good">Passed</StatusPill> : <StatusPill status="critical">{i.failedItems} failed</StatusPill>}</Td>
                    <Td className="text-right">{!i.passed && canReport && i.projectId && <Button size="sm" variant="secondary" onClick={() => setRaisingNcr({ inspectionId: i.id, projectId: i.projectId! })}>Raise NCR</Button>}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'ncrs' && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Non-conformance reports" subtitle="Open → corrective action proposed → verified and closed by someone other than the person who raised it." actions={canReport && <Button size="sm" icon={Plus} onClick={() => setRaisingNcr({})}>Raise NCR</Button>} /></div>
          {ncrs.data?.length === 0 ? <EmptyState icon={FileWarning} title="No NCRs" /> : (
            <Table>
              <thead><tr><Th>No.</Th><Th>Raised</Th><Th>Non-conformance</Th><Th>Severity</Th><Th>Status</Th><Th>Due</Th><Th right>Rework</Th></tr></thead>
              <tbody>
                {ncrs.data?.map((n) => (
                  <Tr key={n.id} onClick={() => setNcrId(n.id)}>
                    <Td mono>{n.number}</Td>
                    <Td className="text-ink-2">{date(n.raisedOn)}</Td>
                    <Td><div className="font-medium">{n.title}</div><div className="text-xs text-ink-3">{n.projectCode} · {sentence(n.category)}</div></Td>
                    <Td><Badge tone={n.severity === 'critical' ? 'critical' : n.severity === 'major' ? 'warning' : 'neutral'}><span className="capitalize">{n.severity}</span></Badge></Td>
                    <Td><Badge tone={n.status === 'closed' ? 'good' : 'warning'} dot>{sentence(n.status)}</Badge></Td>
                    <Td>{n.overdue ? <StatusPill status="critical">{date(n.dueOn!)}</StatusPill> : <span className="text-ink-2">{n.dueOn ? date(n.dueOn) : '—'}</span>}</Td>
                    <Td right>{Number(n.reworkCost) ? zar(n.reworkCost) : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'actions' && <ActionList title="Corrective actions" actions={actions.data ?? []} canComplete={canReport} onChanged={reloadAll} showDone />}

      {tab === 'talks' && (
        <Card padded={false}>
          <div className="p-5 pb-4"><CardHeader title="Toolbox talks" actions={canReport && <Button size="sm" icon={Plus} onClick={() => setTalking(true)}>Record talk</Button>} /></div>
          {talks.data?.length === 0 ? <EmptyState icon={Users} title="No toolbox talks recorded" /> : (
            <Table>
              <thead><tr><Th>Date</Th><Th>Project</Th><Th>Topic</Th><Th>Presenter</Th><Th right>Attendees</Th></tr></thead>
              <tbody>{talks.data?.map((t) => <Tr key={t.id}><Td className="text-ink-2">{date(t.heldOn)}</Td><Td>{t.projectCode}</Td><Td className="font-medium">{t.topic}</Td><Td className="text-ink-2">{t.presenter}</Td><Td right>{t.attendees}</Td></Tr>)}</tbody>
            </Table>
          )}
        </Card>
      )}

      <ReportIncident open={reporting} projects={projects.data ?? []} onClose={() => setReporting(false)} onDone={(i) => { reloadAll(); setIncidentId(i.id); }} />
      <IncidentDetail id={incidentId} role={role} onClose={() => setIncidentId(null)} onChanged={reloadAll} />
      <NcrDetail id={ncrId} me={me} onClose={() => setNcrId(null)} onChanged={reloadAll} />
      <NewInspection open={inspecting} projects={projects.data ?? []} onClose={() => setInspecting(false)} onDone={reloadAll} />
      <RaiseNcr seed={raisingNcr} projects={projects.data ?? []} onClose={() => setRaisingNcr(null)} onDone={(n) => { reloadAll(); setNcrId(n.id); }} />
      <FormPanel open={talking} title="Record toolbox talk" fields={{ projectId: '', heldOn: today(), topic: '', presenter: '', attendees: '', notes: '' }} onClose={() => setTalking(false)}
        submit={(f) => api.hse.addTalk({ ...f, attendees: Number(f.attendees), notes: f.notes || undefined }).then(reloadAll)}
        render={(f, set) => (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project"><Select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })} required><option value="">Choose…</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" value={f.heldOn} onChange={(e) => set({ heldOn: e.target.value })} required /></Field>
            <Field label="Topic" className="sm:col-span-2"><Input value={f.topic} onChange={(e) => set({ topic: e.target.value })} required maxLength={200} placeholder="Working at height: scaffold tags" /></Field>
            <Field label="Presenter"><Input value={f.presenter} onChange={(e) => set({ presenter: e.target.value })} required maxLength={100} /></Field>
            <Field label="Attendees"><Input type="number" min={1} value={f.attendees} onChange={(e) => set({ attendees: e.target.value })} required /></Field>
          </div>
        )} />
    </div>
  );
}

function Reporting({ i }: { i: Incident }) {
  const pending = (i.dolReportable && !i.dolReportedOn) || (i.coidaReportable && !i.coidaReportedOn);
  if (!i.dolReportable && !i.coidaReportable) return <span className="text-xs text-ink-3">—</span>;
  return <StatusPill status={pending ? 'warning' : 'good'}>{[i.dolReportable && 's24', i.coidaReportable && 'COIDA'].filter(Boolean).join(' + ')}{pending ? ' due' : ' done'}</StatusPill>;
}

function ActionList({ title, actions, canComplete, onChanged, showDone }: { title: string; actions: CorrectiveAction[]; canComplete: boolean; onChanged: () => void; showDone?: boolean }) {
  const [completing, setCompleting] = useState<CorrectiveAction | null>(null);
  const list = showDone ? actions : actions.filter((a) => a.status === 'open');
  return (
    <Card padded={false}>
      <div className="p-5 pb-3"><CardHeader title={title} subtitle="From incidents, NCRs and inspections" /></div>
      {list.length === 0 ? <EmptyState icon={ListChecks} title="Nothing outstanding" /> : (
        <div className="divide-y divide-line">
          {list.map((a) => (
            <div key={a.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className={cx('font-medium', a.status === 'done' && 'text-ink-3 line-through')}>{a.action}</div>
                <div className="text-xs text-ink-3">{a.ownerName} · {sentence(a.sourceType)}{a.projectCode ? ` · ${a.projectCode}` : ''}{a.completionNote ? ` · ${a.completionNote}` : ''}</div>
              </div>
              {a.status === 'done' ? <StatusPill status="good">Done {date(a.completedOn!)}</StatusPill> : a.overdue ? <StatusPill status="critical">Due {date(a.dueOn)}</StatusPill> : <span className="text-xs text-ink-2">Due {date(a.dueOn)}</span>}
              {canComplete && a.status === 'open' && <Button size="sm" variant="secondary" onClick={() => setCompleting(a)}>Done</Button>}
            </div>
          ))}
        </div>
      )}
      <FormPanel open={completing !== null} title="Complete corrective action" description={completing?.action} fields={{ completedOn: today(), note: '' }} onClose={() => setCompleting(null)}
        submit={(f) => api.hse.completeAction(completing!.id, f.completedOn, f.note || undefined).then(onChanged)}
        render={(f, set) => (
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <Field label="Completed on"><Input type="date" value={f.completedOn} onChange={(e) => set({ completedOn: e.target.value })} required /></Field>
            <Field label="Evidence / note"><Input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={1000} /></Field>
          </div>
        )} />
    </Card>
  );
}

function AddAction({ sourceType, sourceId, open, onClose, onDone }: { sourceType: CorrectiveAction['sourceType']; sourceId: string; open: boolean; onClose: () => void; onDone: () => void }) {
  return (
    <FormPanel open={open} title="Add corrective action" fields={{ action: '', ownerName: '', dueOn: '' }} onClose={onClose} submit={(f) => api.hse.addAction({ sourceType, sourceId, ...f }).then(onDone)}
      render={(f, set) => (
        <>
          <Field label="Action"><Textarea rows={2} value={f.action} onChange={(e) => set({ action: e.target.value })} required maxLength={1000} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Owner"><Input value={f.ownerName} onChange={(e) => set({ ownerName: e.target.value })} required maxLength={100} /></Field>
            <Field label="Due"><Input type="date" value={f.dueOn} onChange={(e) => set({ dueOn: e.target.value })} required /></Field>
          </div>
        </>
      )} />
  );
}

// =========================================================================== incidents

function ReportIncident({ open, projects, onClose, onDone }: { open: boolean; projects: Project[]; onClose: () => void; onDone: (i: Incident) => void }) {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  return (
    <FormPanel open={open} wide title="Report an incident" description="Report every incident and near miss, however minor. Do not record ID numbers or medical details here."
      fields={{ projectId: '', occurredAt: now, type: 'injury', severity: 'first_aid', title: '', description: '', location: '', injuredPerson: '', daysLost: '0' }} onClose={onClose} submitLabel="Report"
      submit={(f) =>
        api.hse.report({
          projectId: f.projectId || null,
          occurredAt: new Date(f.occurredAt).toISOString(),
          type: f.type as IncidentType,
          severity: (f.type === 'near_miss' ? 'none' : f.severity) as IncidentSeverity,
          title: f.title,
          description: f.description,
          location: f.location || null,
          injuredPerson: f.injuredPerson || null,
          daysLost: Number(f.daysLost || 0),
        }).then(onDone)
      }
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Project"><Select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}><option value="">Not on a project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
            <Field label="When"><Input type="datetime-local" value={f.occurredAt} onChange={(e) => set({ occurredAt: e.target.value })} required /></Field>
            <Field label="Where"><Input value={f.location} onChange={(e) => set({ location: e.target.value })} maxLength={200} /></Field>
            <Field label="Type"><Select value={f.type} onChange={(e) => set({ type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{sentence(t)}</option>)}</Select></Field>
            <Field label="Severity"><Select value={f.type === 'near_miss' ? 'none' : f.severity} onChange={(e) => set({ severity: e.target.value })} disabled={f.type === 'near_miss'}>{SEVERITIES.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}</Select></Field>
            {f.severity === 'lost_time' && f.type !== 'near_miss' && <Field label="Days lost"><Input type="number" min={1} value={f.daysLost} onChange={(e) => set({ daysLost: e.target.value })} required /></Field>}
          </div>
          <Field label="Short title"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} required maxLength={200} /></Field>
          <Field label="What happened"><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} required maxLength={5000} /></Field>
          {f.type !== 'near_miss' && f.severity !== 'none' && <Field label="Injured person (name only)" hint="Needed for COIDA. Kept to HSE users."><Input value={f.injuredPerson} onChange={(e) => set({ injuredPerson: e.target.value })} maxLength={200} /></Field>}
        </>
      )} />
  );
}

function IncidentDetail({ id, role, onClose, onChanged }: { id: string | null; role: string; onClose: () => void; onChanged: () => void }) {
  const [i, setI] = useState<Incident>();
  const [panel, setPanel] = useState<null | 'investigate' | 'action' | 'dol' | 'coida'>(null);
  const action = useAction();
  const load = () => id && api.hse.incident(id).then(setI);
  useEffect(() => { setI(undefined); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: Incident) => { setI(next); onChanged(); };
  const open = i && i.status !== 'closed';

  return (
    <Dialog open={id !== null} onClose={onClose} title={i ? `${i.number} · ${i.title}` : 'Incident'} description={i ? `${dateTime(i.occurredAt)}${i.location ? ` · ${i.location}` : ''}` : undefined} wide>
      {!i ? <Skeleton className="h-48" /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{sentence(i.type)}</Badge>
            <Badge tone={SEV_TONE[i.severity]}>{sentence(i.severity)}{i.daysLost ? ` · ${i.daysLost} days lost` : ''}</Badge>
            <Badge tone={i.status === 'closed' ? 'good' : 'warning'} dot><span className="capitalize">{i.status}</span></Badge>
            <div className="ml-auto flex flex-wrap gap-1.5">
              {open && REPORTERS.includes(role) && <Button size="sm" variant="secondary" onClick={() => setPanel('investigate')}>Investigation</Button>}
              {open && REPORTERS.includes(role) && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setPanel('action')}>Action</Button>}
              {i.status === 'reported' && REPORTERS.includes(role) && <Button size="sm" variant="ghost" onClick={() => void action.run(async () => update(await api.hse.transitionIncident(i.id, 'investigating')))}>Start investigation</Button>}
              {open && SIGN_OFF.includes(role) && <Button size="sm" loading={action.busy} onClick={() => void action.run(async () => update(await api.hse.transitionIncident(i.id, 'closed')))}>Close</Button>}
            </div>
          </div>
          {action.error && <Alert>{action.error}</Alert>}
          {(i.dolReportable || i.coidaReportable) && (
            <div className="space-y-2 rounded-lg border border-line p-3">
              {i.dolReportable && <ReportRow label="OHS Act section 24 (Department of Employment and Labour)" on={i.dolReportedOn} canMark={SIGN_OFF.includes(role)} onMark={() => setPanel('dol')} />}
              {i.coidaReportable && <ReportRow label="COIDA (W.Cl.2 to the Compensation Fund)" on={i.coidaReportedOn} canMark={SIGN_OFF.includes(role)} onMark={() => setPanel('coida')} />}
            </div>
          )}
          <p className="whitespace-pre-wrap text-ink">{i.description}</p>
          {i.injuredPerson && <p className="text-ink-2">Injured: {i.injuredPerson}</p>}
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-ink-3">Immediate cause</dt><dd>{i.immediateCause ?? '—'}</dd></div>
            <div><dt className="text-xs text-ink-3">Root cause</dt><dd>{i.rootCause ?? <span className="text-ink-3">Not yet established</span>}</dd></div>
          </dl>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Corrective actions</h4>
            {i.actions?.length ? i.actions.map((a) => (
              <div key={a.id} className="flex items-center gap-2 py-1">
                <span className={cx('flex-1', a.status === 'done' && 'text-ink-3 line-through')}>{a.action} <span className="text-xs text-ink-3">· {a.ownerName}</span></span>
                {a.status === 'done' ? <StatusPill status="good">Done</StatusPill> : a.overdue ? <StatusPill status="critical">Overdue</StatusPill> : <span className="text-xs text-ink-3">Due {date(a.dueOn)}</span>}
              </div>
            )) : <p className="text-ink-3">None yet. A recordable incident needs at least one before it can close.</p>}
          </div>

          <FormPanel open={panel === 'investigate'} title="Investigation findings" fields={{ immediateCause: i.immediateCause ?? '', rootCause: i.rootCause ?? '', severity: i.severity as string, daysLost: String(i.daysLost) }} onClose={() => setPanel(null)}
            submit={(f) => api.hse.updateIncident(i.id, { immediateCause: f.immediateCause || null, rootCause: f.rootCause || null, ...(i.type === 'near_miss' ? {} : { severity: f.severity as IncidentSeverity, daysLost: Number(f.daysLost || 0) }) }).then(update)}
            render={(f, set) => (
              <>
                <Field label="Immediate cause"><Textarea rows={2} value={f.immediateCause} onChange={(e) => set({ immediateCause: e.target.value })} maxLength={2000} /></Field>
                <Field label="Root cause"><Textarea rows={2} value={f.rootCause} onChange={(e) => set({ rootCause: e.target.value })} maxLength={2000} /></Field>
                {i.type !== 'near_miss' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Severity (as now known)"><Select value={f.severity} onChange={(e) => set({ severity: e.target.value })}>{SEVERITIES.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}</Select></Field>
                    <Field label="Days lost"><Input type="number" min={0} value={f.daysLost} onChange={(e) => set({ daysLost: e.target.value })} /></Field>
                  </div>
                )}
              </>
            )} />
          <AddAction sourceType="incident" sourceId={i.id} open={panel === 'action'} onClose={() => setPanel(null)} onDone={() => { void load(); onChanged(); }} />
          <FormPanel open={panel === 'dol' || panel === 'coida'} title={panel === 'dol' ? 'Reported to the Department of Employment and Labour' : 'Reported to the Compensation Fund'} fields={{ reportedOn: today() }} onClose={() => setPanel(null)}
            submit={(f) => api.hse.markReported(i.id, panel as 'dol' | 'coida', f.reportedOn).then(update)}
            render={(f, set) => <Field label="Date reported"><Input type="date" value={f.reportedOn} onChange={(e) => set({ reportedOn: e.target.value })} required /></Field>} />
        </div>
      )}
    </Dialog>
  );
}

function ReportRow({ label: text, on, canMark, onMark }: { label: string; on: string | null; canMark: boolean; onMark: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex-1">{text}</span>
      {on ? <StatusPill status="good">Reported {date(on)}</StatusPill> : <StatusPill status="warning">Not yet reported</StatusPill>}
      {!on && canMark && <Button size="sm" variant="ghost" onClick={onMark}>Record date</Button>}
    </div>
  );
}

// =========================================================================== inspections & NCRs

function NewInspection({ open, projects, onClose, onDone }: { open: boolean; projects: Project[]; onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState<InspectionRecord['items']>([]);
  useEffect(() => { if (open) setItems([{ item: '', result: 'pass' }]); }, [open]);
  const setItem = (n: number, patch: Partial<InspectionRecord['items'][number]>) => setItems(items.map((x, i) => (i === n ? { ...x, ...patch } : x)));
  return (
    <FormPanel open={open} wide title="New inspection" description="Signing saves the checklist permanently. It cannot be edited afterwards." submitLabel="Sign off"
      fields={{ projectId: '', kind: 'safety', title: '', inspectedOn: today(), notes: '' }} onClose={onClose}
      submit={(f) => api.hse.addInspection({ projectId: f.projectId || null, kind: f.kind as InspectionRecord['kind'], title: f.title, inspectedOn: f.inspectedOn, notes: f.notes || undefined, items: items.map((x) => ({ ...x, note: x.note || undefined })) }).then(onDone)}
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Project" className="sm:col-span-2"><Select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })} required><option value="">Choose…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
            <Field label="Type"><Select value={f.kind} onChange={(e) => set({ kind: e.target.value })}><option value="safety">Safety</option><option value="quality">Quality</option><option value="plant_pre_use">Plant pre-use</option><option value="environmental">Environmental</option></Select></Field>
            <Field label="Date"><Input type="date" value={f.inspectedOn} onChange={(e) => set({ inspectedOn: e.target.value })} required /></Field>
          </div>
          <Field label="Title"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} required maxLength={200} placeholder="Weekly scaffold inspection, area B" /></Field>
          <div className="space-y-2">
            {items.map((x, n) => (
              <div key={n} className="grid grid-cols-[1fr_8rem_1fr_auto] gap-2">
                <Input placeholder="Checklist item" value={x.item} onChange={(e) => setItem(n, { item: e.target.value })} required maxLength={300} />
                <Select value={x.result} onChange={(e) => setItem(n, { result: e.target.value as 'pass' | 'fail' | 'na' })} aria-label="Result"><option value="pass">Pass</option><option value="fail">Fail</option><option value="na">N/A</option></Select>
                <Input placeholder="Note" value={x.note ?? ''} onChange={(e) => setItem(n, { note: e.target.value })} maxLength={500} />
                <Button type="button" variant="ghost" icon={Trash2} aria-label="Remove item" disabled={items.length === 1} onClick={() => setItems(items.filter((_, i) => i !== n))} />
              </div>
            ))}
            <Button type="button" size="sm" variant="secondary" icon={Plus} onClick={() => setItems([...items, { item: '', result: 'pass' }])}>Add item</Button>
          </div>
        </>
      )} />
  );
}

function RaiseNcr({ seed, projects, onClose, onDone }: { seed: { inspectionId?: string; projectId?: string } | null; projects: Project[]; onClose: () => void; onDone: (n: Ncr) => void }) {
  return (
    <FormPanel open={seed !== null} wide title="Raise a non-conformance report" fields={{ projectId: seed?.projectId ?? '', title: '', description: '', category: 'workmanship', severity: 'minor', responsibleParty: '', dueOn: '' }} onClose={onClose} submitLabel="Raise NCR"
      submit={(f) => api.hse.raiseNcr({ ...f, severity: f.severity as Ncr['severity'], inspectionId: seed?.inspectionId ?? null, raisedOn: today(), responsibleParty: f.responsibleParty || null, dueOn: f.dueOn || null }).then(onDone)}
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Project" className="sm:col-span-2"><Select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })} required><option value="">Choose…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
            <Field label="Category"><Select value={f.category} onChange={(e) => set({ category: e.target.value })}>{['workmanship', 'material', 'design', 'procedure', 'documentation', 'other'].map((c) => <option key={c} value={c}>{sentence(c)}</option>)}</Select></Field>
            <Field label="Severity"><Select value={f.severity} onChange={(e) => set({ severity: e.target.value })}><option value="minor">Minor</option><option value="major">Major</option><option value="critical">Critical</option></Select></Field>
          </div>
          <Field label="Title"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} required maxLength={200} /></Field>
          <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} required maxLength={5000} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Responsible party"><Input value={f.responsibleParty} onChange={(e) => set({ responsibleParty: e.target.value })} maxLength={200} placeholder="Own team, subcontractor or supplier" /></Field>
            <Field label="Close out by"><Input type="date" value={f.dueOn} onChange={(e) => set({ dueOn: e.target.value })} /></Field>
          </div>
        </>
      )} />
  );
}

function NcrDetail({ id, me, onClose, onChanged }: { id: string | null; me: Me; onClose: () => void; onChanged: () => void }) {
  const role = me.user.role;
  const [n, setN] = useState<Ncr>();
  const [panel, setPanel] = useState<null | 'edit' | 'action'>(null);
  const action = useAction();
  const load = () => id && api.hse.ncr(id).then(setN);
  useEffect(() => { setN(undefined); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: Ncr) => { setN(next); onChanged(); };
  const open = n && n.status !== 'closed';
  return (
    <Dialog open={id !== null} onClose={onClose} title={n ? `${n.number} · ${n.title}` : 'NCR'} description={n ? `Raised ${date(n.raisedOn)} · ${sentence(n.category)} · ${n.severity}` : undefined} wide>
      {!n ? <Skeleton className="h-48" /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={n.status === 'closed' ? 'good' : 'warning'} dot>{sentence(n.status)}</Badge>
            {n.overdue && <StatusPill status="critical">Overdue</StatusPill>}
            <div className="ml-auto flex flex-wrap gap-1.5">
              {open && REPORTERS.includes(role) && <Button size="sm" variant="secondary" onClick={() => setPanel('edit')}>Cause and action</Button>}
              {open && REPORTERS.includes(role) && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setPanel('action')}>Task</Button>}
              {n.status === 'open' && REPORTERS.includes(role) && <Button size="sm" onClick={() => void action.run(async () => update(await api.hse.transitionNcr(n.id, 'action_proposed')))}>Propose action</Button>}
              {n.status === 'action_proposed' && SIGN_OFF.includes(role) && <Button size="sm" onClick={() => void action.run(async () => update(await api.hse.transitionNcr(n.id, 'closed')))}>Verify and close</Button>}
            </div>
          </div>
          {action.error && <Alert>{action.error}</Alert>}
          <p className="whitespace-pre-wrap">{n.description}</p>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-xs text-ink-3">Responsible</dt><dd>{n.supplierName ?? n.responsibleParty ?? '—'}</dd></div>
            <div><dt className="text-xs text-ink-3">Rework cost</dt><dd>{Number(n.reworkCost) ? zar(n.reworkCost, true) : '—'}</dd></div>
            <div><dt className="text-xs text-ink-3">Root cause</dt><dd>{n.rootCause ?? '—'}</dd></div>
            <div><dt className="text-xs text-ink-3">Corrective action</dt><dd>{n.correctiveAction ?? '—'}</dd></div>
          </dl>
          {n.actions?.length ? (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Tasks</h4>
              {n.actions.map((a) => <div key={a.id} className="py-0.5">{a.action} <span className="text-xs text-ink-3">· {a.ownerName} · {a.status === 'done' ? 'done' : `due ${date(a.dueOn)}`}</span></div>)}
            </div>
          ) : null}
          <FormPanel open={panel === 'edit'} title="Root cause and corrective action" fields={{ rootCause: n.rootCause ?? '', correctiveAction: n.correctiveAction ?? '', reworkCost: n.reworkCost === '0.00' ? '' : n.reworkCost, dueOn: n.dueOn ?? '' }} onClose={() => setPanel(null)}
            submit={(f) => api.hse.updateNcr(n.id, { rootCause: f.rootCause || null, correctiveAction: f.correctiveAction || null, reworkCost: f.reworkCost || '0', dueOn: f.dueOn || null }).then(update)}
            render={(f, set) => (
              <>
                <Field label="Root cause"><Textarea rows={2} value={f.rootCause} onChange={(e) => set({ rootCause: e.target.value })} maxLength={2000} /></Field>
                <Field label="Corrective action"><Textarea rows={2} value={f.correctiveAction} onChange={(e) => set({ correctiveAction: e.target.value })} maxLength={2000} /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Rework cost (R)"><AmountInput value={f.reworkCost} onChange={(v) => set({ reworkCost: v })} /></Field>
                  <Field label="Close out by"><Input type="date" value={f.dueOn} onChange={(e) => set({ dueOn: e.target.value })} /></Field>
                </div>
              </>
            )} />
          <AddAction sourceType="ncr" sourceId={n.id} open={panel === 'action'} onClose={() => setPanel(null)} onDone={() => { void load(); onChanged(); }} />
        </div>
      )}
    </Dialog>
  );
}
