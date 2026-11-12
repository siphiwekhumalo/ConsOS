import { useEffect, useState } from 'react';
import { AlertTriangle, Gauge, MapPin, Plus, Truck, Wrench } from 'lucide-react';
import { api, type Asset, type AssetDetail, type AssetInput, type Me, type Project, type WorkOrder } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, label, sentence, zar } from '../../lib/format';
import { AmountInput, FormDialog, FormPanel, useAction } from '../../components/forms';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, StatusPill, Table, Tabs, Td, Textarea, Th, Tr } from '../../components/ui';

const CATEGORIES = ['earthmoving', 'lifting', 'vehicle', 'generator', 'compressor', 'scaffolding', 'tools', 'other'];
const MANAGERS = ['owner', 'admin', 'project_manager'];
const FIELD = [...MANAGERS, 'site_foreman'];
const today = () => new Date().toISOString().slice(0, 10);
const STATUS: Record<string, { tone: 'neutral' | 'brand' | 'good' | 'warning' | 'critical'; text: string }> = {
  available: { tone: 'good', text: 'In yard' },
  on_site: { tone: 'brand', text: 'On site' },
  under_maintenance: { tone: 'warning', text: 'Under maintenance' },
  broken_down: { tone: 'critical', text: 'Broken down' },
  disposed: { tone: 'neutral', text: 'Disposed' },
};
const DOC: Record<string, string> = { licence: 'Licence disc', roadworthy: 'Roadworthy', load_test: 'Load test', calibration: 'Calibration' };

type Tab = 'register' | 'work-orders';

export function Fleet({ me }: { me: Me }) {
  const role = me.user.role;
  const [tab, setTab] = useState<Tab>('register');
  const assets = useAsync(() => api.plant.assets(), []);
  const workOrders = useAsync(() => api.plant.workOrders(), []);
  const projects = useAsync(() => api.projects(), []);
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const live = (assets.data ?? []).filter((a) => a.status !== 'disposed');
  const reload = () => void Promise.all([assets.reload(), workOrders.reload()]);

  return (
    <div>
      <PageHeader
        title="Fleet & equipment"
        description="Plant register, site allocation, usage charged to project cost codes, maintenance by hours or calendar, and statutory document expiries."
        eyebrow={<Badge tone="brand">Module 7</Badge>}
        actions={MANAGERS.includes(role) && <Button icon={Plus} onClick={() => setAdding(true)}>Add asset</Button>}
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Assets" icon={Truck} value={String(live.length)} hint={`${live.filter((a) => a.status === 'on_site').length} on site`} />
        <Stat label="Out of service" icon={Wrench} value={String(live.filter((a) => a.status === 'broken_down' || a.status === 'under_maintenance').length)} hint={`${(workOrders.data ?? []).filter((w) => w.status === 'open' || w.status === 'in_progress').length} open work orders`} />
        <Stat label="Service overdue" icon={Gauge} value={String(live.filter((a) => a.maintenance === 'overdue').length)} hint={`${live.filter((a) => a.maintenance === 'due_soon').length} due soon`} />
        <Stat label="Documents expired" icon={AlertTriangle} value={String(live.filter((a) => a.compliance.some((c) => c.status === 'expired')).length)} hint={`${live.filter((a) => a.compliance.some((c) => c.status === 'expiring')).length} expiring within 30 days`} />
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'register', label: 'Register', icon: Truck, count: live.length }, { id: 'work-orders', label: 'Work orders', icon: Wrench, count: workOrders.data?.length }]} />
      {assets.error && <Alert>{assets.error}</Alert>}

      {tab === 'register' && (
        <Card padded={false}>
          {!assets.data ? <Skeleton className="m-5 h-32" /> : assets.data.length === 0 ? <EmptyState icon={Truck} title="No plant registered yet" /> : (
            <Table>
              <thead><tr><Th>Asset</Th><Th>Category</Th><Th>Status</Th><Th>Location</Th><Th right>Meter</Th><Th>Service</Th><Th>Documents</Th><Th right>Used (30d)</Th></tr></thead>
              <tbody>
                {assets.data.map((a) => (
                  <Tr key={a.id} onClick={() => setViewing(a.id)} className={a.status === 'disposed' ? 'opacity-50' : undefined}>
                    <Td><span className="font-mono text-xs text-ink-3">{a.assetNo}</span> <span className="ml-1.5 font-medium">{a.name}</span></Td>
                    <Td className="capitalize text-ink-2">{a.category}</Td>
                    <Td><Badge tone={STATUS[a.status]!.tone} dot>{STATUS[a.status]!.text}</Badge></Td>
                    <Td className="text-ink-2">{a.projectCode ?? (a.status === 'disposed' ? '—' : 'Yard')}</Td>
                    <Td right className="text-ink-2">{a.meterUnit === 'none' ? '—' : `${Number(a.meterReading).toLocaleString('en-ZA')} ${a.meterUnit}`}</Td>
                    <Td>{a.maintenance === 'overdue' ? <StatusPill status="critical">Overdue</StatusPill> : a.maintenance === 'due_soon' ? <StatusPill status="warning">Due soon</StatusPill> : <span className="text-xs text-ink-3">—</span>}</Td>
                    <Td><ComplianceSummary a={a} /></Td>
                    <Td right className="text-ink-2">{a.utilisation30d ? `${a.utilisation30d}%` : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'work-orders' && (
        <Card padded={false}>
          {workOrders.data?.length === 0 ? <EmptyState icon={Wrench} title="No work orders yet" /> : (
            <Table>
              <thead><tr><Th>Work order</Th><Th>Asset</Th><Th>Type</Th><Th>Reported</Th><Th>Status</Th><Th right>Cost</Th><Th right>Downtime</Th></tr></thead>
              <tbody>
                {workOrders.data?.map((w) => (
                  <Tr key={w.id} onClick={() => setViewing(w.assetId)}>
                    <Td mono>{w.number}</Td>
                    <Td><span className="font-mono text-xs text-ink-3">{w.assetNo}</span> {w.assetName}</Td>
                    <Td className="capitalize">{w.kind}</Td>
                    <Td className="text-ink-2">{date(w.reportedOn)}</Td>
                    <Td><WoStatus w={w} /></Td>
                    <Td right>{w.status === 'completed' ? zar((Number(w.labourCost) + Number(w.partsCost)).toFixed(2), true) : '—'}</Td>
                    <Td right className="text-ink-2">{Number(w.downtimeHours) ? `${w.downtimeHours} h` : '—'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <AssetDialog asset={adding ? 'new' : null} onClose={() => setAdding(false)} onSaved={(a) => { reload(); setViewing(a.id); }} />
      <AssetDetailDialog id={viewing} me={me} projects={projects.data ?? []} onClose={() => setViewing(null)} onChanged={reload} />
    </div>
  );
}

function ComplianceSummary({ a }: { a: Asset }) {
  const worst = a.compliance.find((c) => c.status === 'expired') ?? a.compliance[0];
  if (!worst) return <span className="text-xs text-ink-3">—</span>;
  return <StatusPill status={worst.status === 'expired' ? 'critical' : 'warning'}>{DOC[worst.kind]} {worst.status === 'expired' ? 'expired' : `in ${worst.daysLeft}d`}</StatusPill>;
}

function WoStatus({ w }: { w: WorkOrder }) {
  const tone = w.status === 'completed' ? 'good' : w.status === 'cancelled' ? 'neutral' : w.kind === 'breakdown' ? 'critical' : 'warning';
  return <Badge tone={tone} dot><span className="capitalize">{label(w.status)}</span></Badge>;
}

// =========================================================================== create / edit

function AssetDialog({ asset, onClose, onSaved }: { asset: AssetDetail | 'new' | null; onClose: () => void; onSaved: (a: AssetDetail) => void }) {
  const existing = asset && asset !== 'new' ? asset : null;
  const blank = { assetNo: '', name: '', category: 'earthmoving', make: '', model: '', serialNo: '', registration: '', year: '', rateUnit: 'day', chargeRate: '', meterUnit: 'hours', licenceExpiry: '', roadworthyExpiry: '', loadTestExpiry: '', calibrationExpiry: '' };
  const [f, setF] = useState(blank);
  useEffect(() => {
    if (!asset) return;
    if (asset === 'new') return setF(blank);
    setF({
      assetNo: asset.assetNo, name: asset.name, category: asset.category, make: asset.make ?? '', model: asset.model ?? '', serialNo: asset.serialNo ?? '', registration: asset.registration ?? '',
      year: asset.year ? String(asset.year) : '', rateUnit: asset.rateUnit, chargeRate: asset.chargeRate, meterUnit: asset.meterUnit,
      licenceExpiry: asset.licenceExpiry ?? '', roadworthyExpiry: asset.roadworthyExpiry ?? '', loadTestExpiry: asset.loadTestExpiry ?? '', calibrationExpiry: asset.calibrationExpiry ?? '',
    });
  }, [asset]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const body: AssetInput = {
    ...f,
    category: f.category,
    make: f.make || null, model: f.model || null, serialNo: f.serialNo || null, registration: f.registration || null,
    year: f.year ? Number(f.year) : null,
    rateUnit: f.rateUnit as 'hour' | 'day',
    chargeRate: f.chargeRate || '0',
    meterUnit: f.meterUnit as AssetInput['meterUnit'],
    licenceExpiry: f.licenceExpiry || null, roadworthyExpiry: f.roadworthyExpiry || null, loadTestExpiry: f.loadTestExpiry || null, calibrationExpiry: f.calibrationExpiry || null,
  };
  return (
    <FormDialog open={asset !== null} onClose={onClose} title={existing ? `Edit ${existing.assetNo}` : 'Add asset'} submitLabel={existing ? 'Save' : 'Add asset'} wide
      onSubmit={async () => onSaved(existing ? await api.plant.updateAsset(existing.id, body) : await api.plant.addAsset(body))}>
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Asset no."><Input value={f.assetNo} onChange={set('assetNo')} required maxLength={30} placeholder="EX-01" /></Field>
        <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={set('name')} required maxLength={200} placeholder="20t excavator" /></Field>
        <Field label="Category"><Select value={f.category} onChange={set('category')}>{CATEGORIES.map((c) => <option key={c} value={c}>{sentence(c)}</option>)}</Select></Field>
        <Field label="Make"><Input value={f.make} onChange={set('make')} maxLength={100} /></Field>
        <Field label="Model"><Input value={f.model} onChange={set('model')} maxLength={100} /></Field>
        <Field label="Serial / VIN"><Input value={f.serialNo} onChange={set('serialNo')} maxLength={100} /></Field>
        <Field label="Registration"><Input value={f.registration} onChange={set('registration')} maxLength={30} /></Field>
        <Field label="Charge-out rate (R)"><AmountInput value={f.chargeRate} onChange={(chargeRate) => setF({ ...f, chargeRate })} /></Field>
        <Field label="Per"><Select value={f.rateUnit} onChange={set('rateUnit')}><option value="day">Day</option><option value="hour">Hour</option></Select></Field>
        <Field label="Meter"><Select value={f.meterUnit} onChange={set('meterUnit')} disabled={Boolean(existing && Number(existing.meterReading) > 0)}><option value="hours">Hours</option><option value="km">Kilometres</option><option value="none">None</option></Select></Field>
        <Field label="Year"><Input type="number" min={1950} max={2100} value={f.year} onChange={set('year')} /></Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Licence disc expires"><Input type="date" value={f.licenceExpiry} onChange={set('licenceExpiry')} /></Field>
        <Field label="Roadworthy expires"><Input type="date" value={f.roadworthyExpiry} onChange={set('roadworthyExpiry')} /></Field>
        <Field label="Load test expires" hint="Lifting equipment"><Input type="date" value={f.loadTestExpiry} onChange={set('loadTestExpiry')} /></Field>
        <Field label="Calibration expires"><Input type="date" value={f.calibrationExpiry} onChange={set('calibrationExpiry')} /></Field>
      </div>
    </FormDialog>
  );
}

// =========================================================================== detail

type Panel = null | 'edit' | 'move' | 'meter' | 'usage' | 'workorder' | 'plan' | 'dispose' | { complete: WorkOrder };

function AssetDetailDialog({ id, me, projects, onClose, onChanged }: { id: string | null; me: Me; projects: Project[]; onClose: () => void; onChanged: () => void }) {
  const role = me.user.role;
  const [a, setA] = useState<AssetDetail>();
  const [panel, setPanel] = useState<Panel>(null);
  const action = useAction();
  useEffect(() => { setA(undefined); if (id) void api.plant.asset(id).then(setA); }, [id]);
  const update = (next: AssetDetail) => { setA(next); onChanged(); };
  const field = FIELD.includes(role);
  const manager = MANAGERS.includes(role);
  const disposed = a?.status === 'disposed';

  return (
    <Dialog open={id !== null} onClose={onClose} title={a ? `${a.assetNo} · ${a.name}` : 'Asset'} description={a ? [a.make, a.model, a.registration].filter(Boolean).join(' · ') || sentence(a.category) : undefined} wide>
      {!a ? <Skeleton className="h-48" /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS[a.status]!.tone} dot>{STATUS[a.status]!.text}{a.project ? ` · ${a.project.code}` : ''}</Badge>
            {a.compliance.map((c) => <StatusPill key={c.kind} status={c.status === 'expired' ? 'critical' : 'warning'}>{DOC[c.kind]} {c.status === 'expired' ? `expired ${date(c.expiry)}` : `expires ${date(c.expiry)}`}</StatusPill>)}
          </div>
          {!disposed && (
            <div className="flex flex-wrap gap-1.5">
              {field && <Button size="sm" variant="secondary" icon={MapPin} onClick={() => setPanel('move')}>{a.currentProjectId ? 'Move / return to yard' : 'Send to site'}</Button>}
              {field && <Button size="sm" variant="secondary" icon={Truck} onClick={() => setPanel('usage')}>Log usage</Button>}
              {field && a.meterUnit !== 'none' && <Button size="sm" variant="secondary" icon={Gauge} onClick={() => setPanel('meter')}>Meter reading</Button>}
              {field && <Button size="sm" variant="secondary" icon={Wrench} onClick={() => setPanel('workorder')}>Breakdown / work order</Button>}
              {manager && <Button size="sm" variant="ghost" onClick={() => setPanel('plan')}>Add service plan</Button>}
              {manager && <Button size="sm" variant="ghost" onClick={() => setPanel('edit')}>Edit</Button>}
              {(role === 'owner' || role === 'admin') && <Button size="sm" variant="ghost" onClick={() => setPanel('dispose')}>Dispose</Button>}
            </div>
          )}
          {action.error && <Alert>{action.error}</Alert>}

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-ink-3">Meter</dt><dd className="num">{a.meterUnit === 'none' ? '—' : `${Number(a.meterReading).toLocaleString('en-ZA')} ${a.meterUnit}`}</dd></div>
            <div><dt className="text-xs text-ink-3">Charge-out</dt><dd className="num">{zar(a.chargeRate, true)} / {a.rateUnit}</dd></div>
            <div><dt className="text-xs text-ink-3">Charged to projects</dt><dd className="num">{zar(a.totals.recovered)}</dd></div>
            <div><dt className="text-xs text-ink-3">Maintenance cost · downtime</dt><dd className="num">{zar(a.totals.maintenanceCost)} · {a.totals.downtimeHours} h</dd></div>
          </dl>

          {a.plans.length > 0 && (
            <Section title="Service plans">
              {a.plans.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center gap-2 py-1 text-sm">
                  <span className="font-medium">{p.description}</span>
                  <span className="text-xs text-ink-3">every {[p.intervalMeter && `${Number(p.intervalMeter)} ${a.meterUnit}`, p.intervalDays && `${p.intervalDays} days`].filter(Boolean).join(' or ')}</span>
                  <span className="ml-auto">
                    {p.due.status === 'overdue' ? <StatusPill status="critical">Overdue</StatusPill> : p.due.status === 'due_soon' ? <StatusPill status="warning">Due soon</StatusPill> : <StatusPill status="good">OK</StatusPill>}
                  </span>
                  <span className="w-full text-xs text-ink-3">
                    Next {[p.due.nextDueMeter && `at ${Number(p.due.nextDueMeter)} ${a.meterUnit} (${p.due.meterRemaining} left)`, p.due.nextDueOn && `by ${date(p.due.nextDueOn)}`].filter(Boolean).join(', ')}
                  </span>
                </div>
              ))}
            </Section>
          )}

          {a.workOrders.length > 0 && (
            <Section title="Work orders">
              {a.workOrders.map((w) => (
                <div key={w.id} className="flex flex-wrap items-center gap-2 border-b border-line py-2 text-sm last:border-0">
                  <span className="font-mono text-xs text-ink-3">{w.number}</span>
                  <span className="capitalize">{w.kind}</span>
                  <WoStatus w={w} />
                  <span className="min-w-0 flex-1 truncate text-ink-2">{w.description}</span>
                  {field && w.status === 'open' && <Button size="sm" variant="ghost" onClick={() => void action.run(async () => update(await api.plant.startWorkOrder(w.id)))}>Start</Button>}
                  {field && (w.status === 'open' || w.status === 'in_progress') && <Button size="sm" onClick={() => setPanel({ complete: w })}>Complete</Button>}
                  {manager && w.status === 'open' && <Button size="sm" variant="ghost" onClick={() => void action.run(async () => update(await api.plant.cancelWorkOrder(w.id)))}>Cancel</Button>}
                  {w.status === 'completed' && <span className="text-xs text-ink-3">{date(w.completedOn!)} · {zar((Number(w.labourCost) + Number(w.partsCost)).toFixed(2), true)}</span>}
                </div>
              ))}
            </Section>
          )}

          {a.usage.length > 0 && (
            <Section title="Recent usage charged">
              <Table>
                <thead><tr><Th>Date</Th><Th>Project</Th><Th>Operator</Th><Th right>Qty</Th><Th right>Amount</Th></tr></thead>
                <tbody>
                  {a.usage.slice(0, 15).map((u) => (
                    <Tr key={u.id}><Td>{date(u.usedOn)}</Td><Td>{u.projectCode}</Td><Td className="text-ink-2">{u.operatorName ?? '—'}</Td><Td right>{Number(u.quantity)} {u.rateUnit}</Td><Td right>{zar(u.amount, true)}</Td></Tr>
                  ))}
                </tbody>
              </Table>
            </Section>
          )}

          <AssetDialog asset={panel === 'edit' ? a : null} onClose={() => setPanel(null)} onSaved={update} />
          <MovePanel open={panel === 'move'} a={a} projects={projects} onClose={() => setPanel(null)} onDone={update} />
          <UsagePanel open={panel === 'usage'} a={a} projects={projects} onClose={() => setPanel(null)} onDone={update} />
          <FormPanel open={panel === 'meter'} title="Meter reading" description={`Current reading ${Number(a.meterReading)} ${a.meterUnit}. Readings can only go up.`} fields={{ readOn: today(), reading: '' }} onClose={() => setPanel(null)}
            submit={(f) => api.plant.meter(a.id, f).then(update)} render={(f, set) => (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Date"><Input type="date" value={f.readOn} onChange={(e) => set({ readOn: e.target.value })} required /></Field>
                <Field label={`Reading (${a.meterUnit})`}><Input inputMode="decimal" value={f.reading} onChange={(e) => set({ reading: e.target.value })} pattern="\d{1,11}(\.\d)?" required /></Field>
              </div>
            )} />
          <FormPanel open={panel === 'workorder'} title="Breakdown or work order" description="A breakdown takes the asset off site until the work order is completed." fields={{ kind: 'breakdown', description: '', reportedOn: today(), planId: '' }} onClose={() => setPanel(null)}
            submit={(f) => api.plant.addWorkOrder(a.id, { ...f, kind: f.kind as WorkOrder['kind'], planId: f.planId || null }).then(update)} render={(f, set) => (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Type"><Select value={f.kind} onChange={(e) => set({ kind: e.target.value })}><option value="breakdown">Breakdown</option><option value="repair">Repair</option><option value="service">Service</option><option value="inspection">Inspection</option></Select></Field>
                  <Field label="Reported on"><Input type="date" value={f.reportedOn} onChange={(e) => set({ reportedOn: e.target.value })} required /></Field>
                  <Field label="Service plan"><Select value={f.planId} onChange={(e) => set({ planId: e.target.value })}><option value="">None</option>{a.plans.filter((p) => p.isActive).map((p) => <option key={p.id} value={p.id}>{p.description}</option>)}</Select></Field>
                </div>
                <Field label="What is wrong / what is needed"><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} required maxLength={2000} /></Field>
              </>
            )} />
          <FormPanel open={panel === 'plan'} title="Service plan" description="Service every so many hours / km, every so many days, or whichever comes first." fields={{ description: '', intervalMeter: '', intervalDays: '', lastDoneOn: '', lastDoneMeter: '' }} onClose={() => setPanel(null)}
            submit={(f) => api.plant.addPlan(a.id, { description: f.description, intervalMeter: f.intervalMeter || null, intervalDays: f.intervalDays ? Number(f.intervalDays) : null, lastDoneOn: f.lastDoneOn || null, lastDoneMeter: f.lastDoneMeter || null }).then(update)} render={(f, set) => (
              <>
                <Field label="Description"><Input value={f.description} onChange={(e) => set({ description: e.target.value })} required maxLength={200} placeholder="250-hour service" /></Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  {a.meterUnit !== 'none' && <Field label={`Every (${a.meterUnit})`}><Input inputMode="decimal" value={f.intervalMeter} onChange={(e) => set({ intervalMeter: e.target.value })} /></Field>}
                  <Field label="Every (days)"><Input type="number" min={1} value={f.intervalDays} onChange={(e) => set({ intervalDays: e.target.value })} /></Field>
                  {a.meterUnit !== 'none' && <Field label={`Last done at (${a.meterUnit})`} hint="Blank: current reading"><Input inputMode="decimal" value={f.lastDoneMeter} onChange={(e) => set({ lastDoneMeter: e.target.value })} /></Field>}
                  <Field label="Last done on" hint="Blank: count from today"><Input type="date" value={f.lastDoneOn} onChange={(e) => set({ lastDoneOn: e.target.value })} /></Field>
                </div>
              </>
            )} />
          <FormPanel open={typeof panel === 'object' && panel !== null} title={typeof panel === 'object' && panel ? `Complete ${panel.complete.number}` : ''} description="Records the work and its cost. A service resets its plan; the asset returns to the yard when no work orders remain."
            fields={{ completedOn: today(), workDone: '', meterAtCompletion: '', labourCost: '', partsCost: '', downtimeHours: '' }} onClose={() => setPanel(null)}
            submit={(f) => api.plant.completeWorkOrder((panel as { complete: WorkOrder }).complete.id, { completedOn: f.completedOn, workDone: f.workDone, meterAtCompletion: f.meterAtCompletion || null, labourCost: f.labourCost || undefined, partsCost: f.partsCost || undefined, downtimeHours: f.downtimeHours || undefined }).then(update)}
            render={(f, set) => (
              <>
                <Field label="Work done"><Textarea rows={3} value={f.workDone} onChange={(e) => set({ workDone: e.target.value })} required maxLength={2000} /></Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Completed on"><Input type="date" value={f.completedOn} onChange={(e) => set({ completedOn: e.target.value })} required /></Field>
                  {a.meterUnit !== 'none' && <Field label={`Meter (${a.meterUnit})`}><Input inputMode="decimal" value={f.meterAtCompletion} onChange={(e) => set({ meterAtCompletion: e.target.value })} /></Field>}
                  <Field label="Downtime (hours)"><Input inputMode="decimal" value={f.downtimeHours} onChange={(e) => set({ downtimeHours: e.target.value })} /></Field>
                  <Field label="Labour (R)"><AmountInput value={f.labourCost} onChange={(v) => set({ labourCost: v })} /></Field>
                  <Field label="Parts (R)"><AmountInput value={f.partsCost} onChange={(v) => set({ partsCost: v })} /></Field>
                </div>
              </>
            )} />
          <FormPanel open={panel === 'dispose'} title={`Dispose of ${a.assetNo}`} description="The asset stays on record but can no longer be used, moved or changed." fields={{ disposedOn: today(), reason: '' }} onClose={() => setPanel(null)} danger
            submit={(f) => api.plant.dispose(a.id, f).then(update)} render={(f, set) => (
              <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                <Field label="Date"><Input type="date" value={f.disposedOn} onChange={(e) => set({ disposedOn: e.target.value })} required /></Field>
                <Field label="Reason"><Input value={f.reason} onChange={(e) => set({ reason: e.target.value })} required maxLength={500} placeholder="Sold / scrapped / written off" /></Field>
              </div>
            )} />
        </div>
      )}
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">{title}</h4>
      {children}
    </div>
  );
}

function MovePanel({ open, a, projects, onClose, onDone }: { open: boolean; a: AssetDetail; projects: Project[]; onClose: () => void; onDone: (a: AssetDetail) => void }) {
  return (
    <FormPanel open={open} title={`Move ${a.assetNo}`} fields={{ projectId: a.currentProjectId ?? '', movedOn: today(), note: '' }} onClose={onClose}
      submit={(f) => api.plant.move(a.id, { projectId: f.projectId || null, movedOn: f.movedOn, note: f.note || undefined }).then(onDone)}
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="To"><Select value={f.projectId} onChange={(e) => set({ projectId: e.target.value })}><option value="">Yard</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
            <Field label="On"><Input type="date" value={f.movedOn} onChange={(e) => set({ movedOn: e.target.value })} required /></Field>
          </div>
          <Field label="Note"><Input value={f.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} placeholder="Transport, delivery note" /></Field>
        </>
      )} />
  );
}

function UsagePanel({ open, a, projects, onClose, onDone }: { open: boolean; a: AssetDetail; projects: Project[]; onClose: () => void; onDone: (a: AssetDetail) => void }) {
  const [codes, setCodes] = useState<{ id: string; code: string; description: string }[]>([]);
  const [projectId, setProjectId] = useState('');
  useEffect(() => { if (open) setProjectId(a.currentProjectId ?? ''); }, [open, a.currentProjectId]);
  useEffect(() => { setCodes([]); if (projectId) void api.plant.costCodes(projectId).then(setCodes); }, [projectId]);
  return (
    <FormPanel open={open} title={`Log usage for ${a.assetNo}`} description={`Charged at ${zar(a.chargeRate, true)} per ${a.rateUnit} to the project cost code, and shown in the project's costs.`}
      fields={{ costCodeId: '', usedOn: today(), quantity: a.rateUnit === 'day' ? '1' : '', operatorName: '' }} onClose={onClose}
      submit={(f) => api.plant.usage(a.id, { projectId, costCodeId: f.costCodeId, usedOn: f.usedOn, quantity: f.quantity, operatorName: f.operatorName || undefined }).then(onDone)}
      render={(f, set) => (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Project"><Select value={projectId} onChange={(e) => setProjectId(e.target.value)} required><option value="">Choose…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</Select></Field>
          <Field label="Cost code"><Select value={f.costCodeId} onChange={(e) => set({ costCodeId: e.target.value })} required><option value="">{projectId && codes.length === 0 ? 'No cost codes on this project' : 'Choose…'}</option>{codes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}</Select></Field>
          <Field label="Date"><Input type="date" value={f.usedOn} max={today()} onChange={(e) => set({ usedOn: e.target.value })} required /></Field>
          <Field label={a.rateUnit === 'day' ? 'Days (0.5 or 1)' : 'Hours'}><Input inputMode="decimal" value={f.quantity} onChange={(e) => set({ quantity: e.target.value })} required pattern="\d{1,2}(\.\d{1,2})?" /></Field>
          <Field label="Operator" className="sm:col-span-2"><Input value={f.operatorName} onChange={(e) => set({ operatorName: e.target.value })} maxLength={100} /></Field>
        </div>
      )} />
  );
}
