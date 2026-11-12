import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Award, Building2, CalendarClock, Phone, Plus, Target, Trash2, TrendingUp } from 'lucide-react';
import { api, type CrmAccount, type CrmActivity, type Me, type OppStage, type Opportunity } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { date, dateTime, sentence, zar } from '../../lib/format';
import { AmountInput, FormPanel, useAction } from '../../components/forms';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, StatusPill, Table, Tabs, Td, Textarea, Th, Tr, cx } from '../../components/ui';

type Tab = 'pipeline' | 'clients' | 'activities' | 'closed';
const OPEN: OppStage[] = ['lead', 'qualifying', 'tendering', 'submitted'];
const NEXT: Partial<Record<OppStage, OppStage[]>> = {
  lead: ['qualifying', 'no_bid'],
  qualifying: ['tendering', 'lead', 'no_bid'],
  tendering: ['submitted', 'qualifying', 'no_bid'],
  submitted: ['won', 'lost'],
};
const STAGE_TONE: Record<OppStage, 'neutral' | 'brand' | 'warning' | 'good' | 'critical'> = {
  lead: 'neutral', qualifying: 'neutral', tendering: 'brand', submitted: 'warning', won: 'good', lost: 'critical', no_bid: 'neutral',
};
const SECTORS = ['mining', 'petrochemical', 'power', 'manufacturing', 'infrastructure', 'government', 'commercial', 'other'];
const PROVINCES = ['EC', 'FS', 'GP', 'KZN', 'LP', 'MP', 'NC', 'NW', 'WC'];
const today = () => new Date().toISOString().slice(0, 10);
const localDateTime = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

export function Crm({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('pipeline');
  const dash = useAsync(() => api.crm.dashboard(), []);
  const opps = useAsync(() => api.crm.opportunities(), []);
  const accounts = useAsync(() => api.crm.accounts(), []);
  const [oppId, setOppId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [newOpp, setNewOpp] = useState(false);
  const [newAccount, setNewAccount] = useState(false);
  const reload = () => void Promise.all([dash.reload(), opps.reload(), accounts.reload()]);
  const d = dash.data;

  return (
    <div>
      <PageHeader
        title="CRM & tenders"
        description="Clients and contacts, the tender pipeline from lead to award, compulsory briefings and closing dates, and follow-ups. Winning a tender priced in Commercial Intake links the project it became."
        eyebrow={<Badge tone="brand">Module 2</Badge>}
        actions={
          <>
            <Button variant="secondary" icon={Building2} onClick={() => setNewAccount(true)}>New client</Button>
            <Button icon={Plus} disabled={!accounts.data?.length} onClick={() => setNewOpp(true)}>New opportunity</Button>
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Open pipeline" icon={Target} value={d ? zar(d.pipeline.openValue) : '…'} hint={d ? `${d.pipeline.openCount} opportunities` : undefined} />
        <Stat label="Weighted pipeline" icon={TrendingUp} value={d ? zar(d.pipeline.weightedValue) : '…'} hint="value × probability" />
        <Stat label="Win rate (12 months)" icon={Award} value={d?.winRate.byCount ? `${d.winRate.byCount}%` : '—'} hint={d ? `${d.winRate.won} won, ${d.winRate.lost} lost · ${d.winRate.byValue ? `${d.winRate.byValue}% by value` : 'no value yet'}` : undefined} />
        <Stat label="Due in 14 days" icon={CalendarClock} value={d ? String(d.deadlines.length) : '…'} hint={d ? `briefings and closings · ${d.followUps.filter((f) => f.overdue).length} follow-ups overdue` : undefined} />
      </div>

      {d && (d.deadlines.length > 0 || d.followUps.length > 0) && (
        <div className="mb-6 grid gap-6 xl:grid-cols-2">
          {d.deadlines.length > 0 && (
            <Card>
              <CardHeader title="Tender deadlines" subtitle="Compulsory briefings and closing dates in the next 14 days" />
              <ul className="mt-3 space-y-2 text-sm">
                {d.deadlines.map((x) => (
                  <li key={`${x.opportunity.id}-${x.kind}`} className="flex flex-wrap items-center gap-2">
                    <button className="font-medium text-brand hover:underline" onClick={() => setOppId(x.opportunity.id)}>{x.opportunity.title}</button>
                    <span className="text-ink-3">{x.opportunity.customerName}</span>
                    <span className="ml-auto">{x.missed ? <StatusPill status="critical">Closed {dateTime(x.at)}</StatusPill> : <StatusPill status={x.hoursLeft < 48 ? 'warning' : 'good'}>{x.kind === 'briefing' ? 'Briefing' : 'Closes'} {dateTime(x.at)}</StatusPill>}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {d.followUps.length > 0 && <FollowUps items={d.followUps} onDone={reload} />}
        </div>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'pipeline', label: 'Pipeline', icon: Target, count: opps.data?.filter((o) => OPEN.includes(o.stage)).length },
          { id: 'clients', label: 'Clients', icon: Building2, count: accounts.data?.length },
          { id: 'activities', label: 'Activity log', icon: Phone },
          { id: 'closed', label: 'Won and lost', icon: Award, count: opps.data?.filter((o) => !OPEN.includes(o.stage)).length },
        ]}
      />
      {opps.error && <Alert>{opps.error}</Alert>}

      {tab === 'pipeline' && (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {OPEN.map((stage) => {
            const here = (opps.data ?? []).filter((o) => o.stage === stage);
            const s = d?.pipeline.stages.find((x) => x.stage === stage);
            return (
              <div key={stage} className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="mb-2 flex items-baseline justify-between px-1">
                  <span className="text-sm font-semibold capitalize">{stage}</span>
                  <span className="text-xs text-ink-3">{here.length} · {zar(s?.value ?? '0')}</span>
                </div>
                <div className="space-y-2">
                  {here.length === 0 && <p className="px-1 py-4 text-center text-xs text-ink-3">Nothing here</p>}
                  {here.map((o) => (
                    <button key={o.id} onClick={() => setOppId(o.id)} className="block w-full rounded-lg border border-line bg-surface p-3 text-left shadow-card hover:border-brand/40">
                      <div className="text-sm font-medium text-ink">{o.title}</div>
                      <div className="text-xs text-ink-3">{o.customerName} · {o.number}</div>
                      <div className="mt-2 flex items-center justify-between text-xs">
                        <span className="num font-medium">{o.estimatedValue ? zar(o.estimatedValue) : 'No value yet'}</span>
                        <span className="text-ink-3">{o.probability}%</span>
                      </div>
                      {o.closingAt && <div className={cx('mt-1 text-xs', new Date(o.closingAt) < new Date() && o.stage !== 'submitted' ? 'text-critical-ink' : 'text-ink-2')}>Closes {dateTime(o.closingAt)}</div>}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'clients' && (
        <Card padded={false}>
          {accounts.data?.length === 0 ? <EmptyState icon={Building2} title="No clients yet" /> : (
            <Table>
              <thead><tr><Th>Client</Th><Th>Sector</Th><Th>Province</Th><Th right>Contacts</Th><Th right>Open opportunities</Th><Th>Last activity</Th></tr></thead>
              <tbody>
                {accounts.data?.map((a) => (
                  <Tr key={a.id} onClick={() => setAccountId(a.id)}>
                    <Td className="font-medium">{a.name}</Td>
                    <Td className="text-ink-2">{a.sector ? sentence(a.sector) : '—'}</Td>
                    <Td className="text-ink-2">{a.province ?? '—'}</Td>
                    <Td right>{typeof a.contacts === 'number' ? a.contacts : a.contacts.length}</Td>
                    <Td right>{a.openOpportunities ? `${a.openOpportunities} · ${zar(a.openValue)}` : '—'}</Td>
                    <Td className="text-ink-2">{a.lastActivity ? date(a.lastActivity) : 'Never'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      {tab === 'activities' && <ActivityLog onOpen={setAccountId} />}

      {tab === 'closed' && (
        <Card padded={false}>
          <Table>
            <thead><tr><Th>Opportunity</Th><Th>Client</Th><Th>Outcome</Th><Th right>Value</Th><Th>Reason / competitor</Th><Th>Closed</Th></tr></thead>
            <tbody>
              {(opps.data ?? []).filter((o) => !OPEN.includes(o.stage)).map((o) => (
                <Tr key={o.id} onClick={() => setOppId(o.id)}>
                  <Td className="font-medium">{o.title}<div className="text-xs font-normal text-ink-3">{o.number}</div></Td>
                  <Td className="text-ink-2">{o.customerName}</Td>
                  <Td><Badge tone={STAGE_TONE[o.stage]} dot>{sentence(o.stage)}</Badge></Td>
                  <Td right>{zar(o.awardedValue ?? o.estimatedValue)}</Td>
                  <Td className="text-ink-2">{[o.closeReason, o.competitor].filter(Boolean).join(' · ') || '—'}</Td>
                  <Td className="text-ink-2">{o.closedAt ? date(o.closedAt) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      <OppDialog open={newOpp} accounts={accounts.data ?? []} onClose={() => setNewOpp(false)} onSaved={(o) => { reload(); setOppId(o.id); }} />
      <AccountDialog open={newAccount} onClose={() => setNewAccount(false)} onSaved={(a) => { reload(); setAccountId(a.id); }} />
      <OppDetail id={oppId} me={me} accounts={accounts.data ?? []} onClose={() => setOppId(null)} onChanged={reload} />
      <AccountDetail id={accountId} onClose={() => setAccountId(null)} onChanged={reload} onOpenOpp={(id) => { setAccountId(null); setOppId(id); }} />
    </div>
  );
}

function FollowUps({ items, onDone }: { items: CrmActivity[]; onDone: () => void }) {
  const action = useAction();
  return (
    <Card>
      <CardHeader title="Follow-ups due" subtitle="This week and overdue" />
      {action.error && <Alert>{action.error}</Alert>}
      <ul className="mt-3 space-y-2 text-sm">
        {items.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1"><span className="font-medium">{f.customerName}</span> · {f.nextStep ?? f.summary}</span>
            {f.overdue ? <StatusPill status="critical">{date(f.followUpOn!)}</StatusPill> : <span className="text-xs text-ink-3">{date(f.followUpOn!)}</span>}
            <Button size="sm" variant="secondary" onClick={() => void action.run(async () => { await api.crm.followUpDone(f.id); onDone(); })}>Done</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ActivityLog({ onOpen }: { onOpen: (customerId: string) => void }) {
  const list = useAsync(() => api.crm.activities(), []);
  return (
    <Card padded={false}>
      {list.data?.length === 0 ? <EmptyState icon={Phone} title="No activity logged yet">Log calls, meetings and site visits from a client or opportunity.</EmptyState> : (
        <div className="divide-y divide-line">
          {list.data?.map((a) => (
            <div key={a.id} className="flex flex-wrap gap-3 px-5 py-3 text-sm">
              <span className="w-24 shrink-0 text-ink-3">{date(a.occurredOn)}</span>
              <Badge>{sentence(a.kind)}</Badge>
              <div className="min-w-0 flex-1">
                <button className="font-medium text-brand hover:underline" onClick={() => onOpen(a.customerId)}>{a.customerName}</button>
                <p className="whitespace-pre-wrap text-ink">{a.summary}</p>
                {a.nextStep && <p className="text-xs text-ink-2">Next: {a.nextStep}{a.followUpOn ? ` by ${date(a.followUpOn)}` : ''}{a.followUpDone ? ' (done)' : ''}</p>}
              </div>
              <span className="text-xs text-ink-3">{a.author}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// =========================================================================== dialogs

function AccountDialog({ open, existing, onClose, onSaved }: { open: boolean; existing?: CrmAccount; onClose: () => void; onSaved: (a: CrmAccount) => void }) {
  return (
    <FormPanel open={open} wide title={existing ? `Edit ${existing.name}` : 'New client'} submitLabel={existing ? 'Save' : 'Add client'} onClose={onClose}
      fields={{ name: existing?.name ?? '', sector: existing?.sector ?? '', province: existing?.province ?? '', vatNumber: existing?.vatNumber ?? '', phone: existing?.phone ?? '', email: existing?.email ?? '', website: existing?.website ?? '', billingAddress: existing?.billingAddress ?? '', notes: existing?.notes ?? '' }}
      submit={async (f) => {
        const body = { name: f.name, sector: f.sector || null, province: f.province || null, vatNumber: f.vatNumber || null, phone: f.phone || null, email: f.email || null, website: f.website || null, billingAddress: f.billingAddress || null, notes: f.notes };
        onSaved(existing ? await api.crm.updateAccount(existing.id, body) : await api.crm.addAccount(body));
      }}
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Name" className="sm:col-span-3"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} required maxLength={200} /></Field>
            <Field label="Sector"><Select value={f.sector} onChange={(e) => set({ sector: e.target.value })}><option value="">—</option>{SECTORS.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}</Select></Field>
            <Field label="Province"><Select value={f.province} onChange={(e) => set({ province: e.target.value })}><option value="">—</option>{PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}</Select></Field>
            <Field label="VAT number"><Input value={f.vatNumber} onChange={(e) => set({ vatNumber: e.target.value })} pattern="4\d{9}" /></Field>
            <Field label="Switchboard"><Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={40} /></Field>
            <Field label="Email"><Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Website"><Input value={f.website} onChange={(e) => set({ website: e.target.value })} maxLength={200} /></Field>
          </div>
          <Field label="Billing address"><Input value={f.billingAddress} onChange={(e) => set({ billingAddress: e.target.value })} maxLength={500} /></Field>
          <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={4000} /></Field>
        </>
      )} />
  );
}

function OppDialog({ open, existing, accounts, onClose, onSaved }: { open: boolean; existing?: Opportunity; accounts: CrmAccount[]; onClose: () => void; onSaved: (o: Opportunity) => void }) {
  const fields = {
    customerId: existing?.customerId ?? '', title: existing?.title ?? '', description: existing?.description ?? '', source: existing?.source ?? 'client_rfq',
    estimatedValue: existing?.estimatedValue ?? '', probability: existing ? String(existing.probability) : '', tenderRef: existing?.tenderRef ?? '',
    briefingOn: localDateTime(existing?.briefingOn ?? null), closingAt: localDateTime(existing?.closingAt ?? null), expectedAwardOn: existing?.expectedAwardOn ?? '',
    cidbGradeRequired: existing?.cidbGradeRequired ?? '', bbbeeLevelRequired: existing?.bbbeeLevelRequired ? String(existing.bbbeeLevelRequired) : '',
  };
  return (
    <FormPanel open={open} wide title={existing ? `Edit ${existing.number}` : 'New opportunity'} submitLabel={existing ? 'Save' : 'Add opportunity'} onClose={onClose} fields={fields}
      submit={async (f) => {
        const body = {
          customerId: f.customerId, title: f.title, description: f.description, source: f.source,
          estimatedValue: f.estimatedValue || null, ...(f.probability ? { probability: Number(f.probability) } : {}),
          tenderRef: f.tenderRef || null,
          briefingOn: f.briefingOn ? new Date(f.briefingOn).toISOString() : null,
          closingAt: f.closingAt ? new Date(f.closingAt).toISOString() : null,
          expectedAwardOn: f.expectedAwardOn || null,
          cidbGradeRequired: f.cidbGradeRequired || null,
          bbbeeLevelRequired: f.bbbeeLevelRequired ? Number(f.bbbeeLevelRequired) : null,
        };
        onSaved(existing ? await api.crm.updateOpportunity(existing.id, body) : await api.crm.addOpportunity(body));
      }}
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Client" className="sm:col-span-2"><Select value={f.customerId} onChange={(e) => set({ customerId: e.target.value })} required disabled={Boolean(existing)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
            <Field label="Source"><Select value={f.source} onChange={(e) => set({ source: e.target.value })}>{['client_rfq', 'tender_bulletin', 'etender_portal', 'referral', 'repeat_client', 'other'].map((s) => <option key={s} value={s}>{sentence(s)}</option>)}</Select></Field>
            <Field label="Title" className="sm:col-span-3"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} required maxLength={200} /></Field>
            <Field label="Estimated value (R, excl. VAT)"><AmountInput value={f.estimatedValue} onChange={(v) => set({ estimatedValue: v })} /></Field>
            <Field label="Win probability %" hint="Blank: the stage default"><Input type="number" min={0} max={100} value={f.probability} onChange={(e) => set({ probability: e.target.value })} /></Field>
            <Field label="Client tender no."><Input value={f.tenderRef} onChange={(e) => set({ tenderRef: e.target.value })} maxLength={60} /></Field>
            <Field label="Compulsory briefing"><Input type="datetime-local" value={f.briefingOn} onChange={(e) => set({ briefingOn: e.target.value })} /></Field>
            <Field label="Closing date and time"><Input type="datetime-local" value={f.closingAt} onChange={(e) => set({ closingAt: e.target.value })} /></Field>
            <Field label="Expected award"><Input type="date" value={f.expectedAwardOn} onChange={(e) => set({ expectedAwardOn: e.target.value })} /></Field>
            <Field label="CIDB grading required"><Input value={f.cidbGradeRequired} onChange={(e) => set({ cidbGradeRequired: e.target.value.toUpperCase() })} pattern="[1-9][A-Z]{1,3}" placeholder="7CE" /></Field>
            <Field label="B-BBEE level required"><Select value={f.bbbeeLevelRequired} onChange={(e) => set({ bbbeeLevelRequired: e.target.value })}><option value="">None</option>{[1, 2, 3, 4, 5, 6, 7, 8].map((l) => <option key={l} value={l}>Level {l} or better</option>)}</Select></Field>
          </div>
          <Field label="Scope and notes"><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={5000} /></Field>
        </>
      )} />
  );
}

function OppDetail({ id, me, accounts, onClose, onChanged }: { id: string | null; me: Me; accounts: CrmAccount[]; onClose: () => void; onChanged: () => void }) {
  const [o, setO] = useState<Opportunity>();
  const [panel, setPanel] = useState<null | 'edit' | 'activity' | { to: OppStage }>(null);
  const action = useAction();
  const hasCommercial = me.modules.includes('mod_commercial');
  const load = () => id && api.crm.opportunity(id).then(setO);
  useEffect(() => { setO(undefined); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: Opportunity) => { setO(next); onChanged(); };
  const open = o && OPEN.includes(o.stage);
  const move = (to: OppStage) => (['won', 'lost', 'no_bid'].includes(to) ? setPanel({ to }) : void action.run(async () => update(await api.crm.transition(o!.id, { to }))));

  return (
    <Dialog open={id !== null} onClose={onClose} title={o ? `${o.number} · ${o.title}` : 'Opportunity'} description={o ? `${o.customerName} · owner ${o.ownerName}` : undefined} wide>
      {!o ? <Skeleton className="h-48" /> : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={STAGE_TONE[o.stage]} dot>{sentence(o.stage)}</Badge>
            <span className="text-ink-2">{o.probability}% · {zar(o.awardedValue ?? o.estimatedValue)}</span>
            {open && (
              <div className="ml-auto flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setPanel('edit')}>Edit</Button>
                <Button size="sm" variant="ghost" icon={Phone} onClick={() => setPanel('activity')}>Log activity</Button>
                {hasCommercial && !o.estimateId && (o.stage === 'qualifying' || o.stage === 'tendering') && <Button size="sm" variant="secondary" onClick={() => void action.run(async () => update(await api.crm.startEstimate(o.id)))}>Price in Commercial Intake</Button>}
                {NEXT[o.stage]?.map((to) => (
                  <Button key={to} size="sm" variant={to === 'won' ? 'primary' : to === 'lost' || to === 'no_bid' ? 'ghost' : 'secondary'} onClick={() => move(to)}>
                    {to === 'no_bid' ? 'Do not bid' : `→ ${sentence(to)}`}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {action.error && <Alert>{action.error}</Alert>}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><dt className="text-xs text-ink-3">Tender no.</dt><dd>{o.tenderRef ?? '—'}</dd></div>
            <div><dt className="text-xs text-ink-3">Compulsory briefing</dt><dd>{o.briefingOn ? dateTime(o.briefingOn) : '—'}</dd></div>
            <div><dt className="text-xs text-ink-3">Closes</dt><dd>{o.closingAt ? dateTime(o.closingAt) : '—'}</dd></div>
            <div><dt className="text-xs text-ink-3">Requirements</dt><dd>{[o.cidbGradeRequired && `CIDB ${o.cidbGradeRequired}`, o.bbbeeLevelRequired && `B-BBEE L${o.bbbeeLevelRequired}`].filter(Boolean).join(' · ') || '—'}</dd></div>
          </dl>
          {o.estimate && <p>Estimate <Link className="font-medium text-brand hover:underline" to={`/commercial/${o.estimate.id}`}>{o.estimate.ref}</Link> · {sentence(o.estimate.stage)}</p>}
          {o.project && <p>Became project <Link className="font-medium text-brand hover:underline" to={`/projects/${o.project.id}`}>{o.project.code} · {o.project.name}</Link></p>}
          {(o.closeReason || o.competitor) && <Alert tone={o.stage === 'won' ? 'good' : 'info'}>{[o.closeReason, o.competitor && `Won by ${o.competitor}`].filter(Boolean).join(' · ')}</Alert>}
          {o.description && <p className="whitespace-pre-wrap text-ink-2">{o.description}</p>}
          {o.activities && o.activities.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Activity</h4>
              {o.activities.map((a) => <p key={a.id} className="py-0.5"><span className="text-ink-3">{date(a.occurredOn)} · {sentence(a.kind)} ·</span> {a.summary}</p>)}
            </div>
          )}
          <OppDialog open={panel === 'edit'} existing={o} accounts={accounts} onClose={() => setPanel(null)} onSaved={update} />
          <ActivityDialog open={panel === 'activity'} customerId={o.customerId} opportunityId={o.id} onClose={() => setPanel(null)} onSaved={() => { void load(); onChanged(); }} />
          <FormPanel open={typeof panel === 'object' && panel !== null} title={typeof panel === 'object' && panel ? (panel.to === 'won' ? 'Tender won' : panel.to === 'lost' ? 'Tender lost' : 'Decline to bid') : ''}
            description={typeof panel === 'object' && panel?.to === 'won' ? 'Record the awarded value. If the tender was priced in Commercial Intake and its baseline is locked, the project links automatically.' : 'The reason helps the next bid. This cannot be changed afterwards.'}
            fields={{ awardedValue: o.estimatedValue ?? '', closeReason: '', competitor: '' }} onClose={() => setPanel(null)}
            submit={(f) => {
              const to = (panel as { to: OppStage }).to;
              return api.crm.transition(o.id, { to, ...(to === 'won' ? { awardedValue: f.awardedValue } : { closeReason: f.closeReason, competitor: f.competitor || undefined }) }).then(update);
            }}
            render={(f, set) => (typeof panel === 'object' && panel?.to === 'won' ? (
              <Field label="Awarded value (R, excl. VAT)"><AmountInput value={f.awardedValue} onChange={(v) => set({ awardedValue: v })} required /></Field>
            ) : (
              <>
                <Field label="Reason"><Textarea rows={2} value={f.closeReason} onChange={(e) => set({ closeReason: e.target.value })} required maxLength={1000} /></Field>
                {typeof panel === 'object' && panel?.to === 'lost' && <Field label="Who won"><Input value={f.competitor} onChange={(e) => set({ competitor: e.target.value })} maxLength={200} /></Field>}
              </>
            ))} />
        </div>
      )}
    </Dialog>
  );
}

function ActivityDialog({ open, customerId, opportunityId, onClose, onSaved }: { open: boolean; customerId: string; opportunityId?: string; onClose: () => void; onSaved: () => void }) {
  return (
    <FormPanel open={open} title="Log activity" fields={{ kind: 'call', occurredOn: today(), summary: '', nextStep: '', followUpOn: '' }} onClose={onClose}
      submit={(f) => api.crm.addActivity({ customerId, opportunityId: opportunityId ?? null, kind: f.kind as CrmActivity['kind'], occurredOn: f.occurredOn, summary: f.summary, nextStep: f.nextStep || null, followUpOn: f.followUpOn || null }).then(onSaved)}
      render={(f, set) => (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type"><Select value={f.kind} onChange={(e) => set({ kind: e.target.value })}>{['call', 'meeting', 'email', 'site_visit', 'note'].map((k) => <option key={k} value={k}>{sentence(k)}</option>)}</Select></Field>
            <Field label="Date"><Input type="date" value={f.occurredOn} max={today()} onChange={(e) => set({ occurredOn: e.target.value })} required /></Field>
          </div>
          <Field label="What happened"><Textarea rows={3} value={f.summary} onChange={(e) => set({ summary: e.target.value })} required maxLength={4000} /></Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Next step"><Input value={f.nextStep} onChange={(e) => set({ nextStep: e.target.value })} maxLength={500} /></Field>
            <Field label="Follow up by"><Input type="date" value={f.followUpOn} onChange={(e) => set({ followUpOn: e.target.value })} /></Field>
          </div>
        </>
      )} />
  );
}

function AccountDetail({ id, onClose, onChanged, onOpenOpp }: { id: string | null; onClose: () => void; onChanged: () => void; onOpenOpp: (id: string) => void }) {
  const [a, setA] = useState<CrmAccount>();
  const [panel, setPanel] = useState<null | 'edit' | 'contact' | 'activity'>(null);
  const action = useAction();
  const load = () => id && api.crm.account(id).then(setA);
  useEffect(() => { setA(undefined); void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: CrmAccount) => { setA(next); onChanged(); };
  const contacts = Array.isArray(a?.contacts) ? a!.contacts : [];
  return (
    <Dialog open={id !== null} onClose={onClose} title={a?.name ?? 'Client'} description={a ? [a.sector && sentence(a.sector), a.province, a.accountManagerName && `account manager ${a.accountManagerName}`].filter(Boolean).join(' · ') : undefined} wide>
      {!a ? <Skeleton className="h-48" /> : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setPanel('edit')}>Edit</Button>
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setPanel('contact')}>Contact</Button>
            <Button size="sm" variant="secondary" icon={Phone} onClick={() => setPanel('activity')}>Log activity</Button>
          </div>
          {action.error && <Alert>{action.error}</Alert>}
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Contacts</h4>
            {contacts.length === 0 ? <p className="text-ink-3">None yet.</p> : contacts.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 py-1">
                <span className="font-medium">{c.fullName}</span>
                {c.jobTitle && <span className="text-ink-3">{c.jobTitle}</span>}
                {c.isPrimary && <Badge tone="brand">Primary</Badge>}
                {c.marketingOptOut && <Badge>No marketing</Badge>}
                <span className="ml-auto text-ink-2">{[c.email, c.phone].filter(Boolean).join(' · ')}</span>
                <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove ${c.fullName}`} onClick={() => void action.run(async () => update(await api.crm.deleteContact(c.id)))} />
              </div>
            ))}
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Opportunities{a.winRate?.byCount ? ` · win rate ${a.winRate.byCount}%` : ''}</h4>
            {a.opportunities?.length ? a.opportunities.map((o) => (
              <button key={o.id} onClick={() => onOpenOpp(o.id)} className="flex w-full items-center gap-2 py-1 text-left hover:text-brand">
                <span className="font-mono text-xs text-ink-3">{o.number}</span>
                <span className="flex-1">{o.title}</span>
                <Badge tone={STAGE_TONE[o.stage]} dot>{sentence(o.stage)}</Badge>
                <span className="num w-28 text-right">{zar(o.awardedValue ?? o.estimatedValue)}</span>
              </button>
            )) : <p className="text-ink-3">None yet.</p>}
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-3">Recent activity</h4>
            {a.activities?.length ? a.activities.slice(0, 10).map((x) => <p key={x.id} className="py-0.5"><span className="text-ink-3">{date(x.occurredOn)} · {sentence(x.kind)} ·</span> {x.summary}</p>) : <p className="text-ink-3">Nothing logged yet.</p>}
          </div>
          <AccountDialog open={panel === 'edit'} existing={a} onClose={() => setPanel(null)} onSaved={update} />
          <ActivityDialog open={panel === 'activity'} customerId={a.id} onClose={() => setPanel(null)} onSaved={() => { void load(); onChanged(); }} />
          <FormPanel open={panel === 'contact'} title="Add contact" description="Business contact details. Tick the opt-out if they do not want marketing messages (POPIA)." fields={{ fullName: '', jobTitle: '', email: '', phone: '', isPrimary: '', marketingOptOut: '' }} onClose={() => setPanel(null)}
            submit={(f) => api.crm.addContact(a.id, { fullName: f.fullName, jobTitle: f.jobTitle || null, email: f.email || null, phone: f.phone || null, isPrimary: f.isPrimary === 'yes', marketingOptOut: f.marketingOptOut === 'yes' }).then(update)}
            render={(f, set) => (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name"><Input value={f.fullName} onChange={(e) => set({ fullName: e.target.value })} required maxLength={200} /></Field>
                <Field label="Job title"><Input value={f.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} maxLength={100} /></Field>
                <Field label="Email"><Input type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
                <Field label="Phone"><Input value={f.phone} onChange={(e) => set({ phone: e.target.value })} maxLength={40} /></Field>
                <label className="flex items-center gap-2"><input type="checkbox" checked={f.isPrimary === 'yes'} onChange={(e) => set({ isPrimary: e.target.checked ? 'yes' : '' })} /> Primary contact</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={f.marketingOptOut === 'yes'} onChange={(e) => set({ marketingOptOut: e.target.checked ? 'yes' : '' })} /> No marketing messages</label>
              </div>
            )} />
        </div>
      )}
    </Dialog>
  );
}
