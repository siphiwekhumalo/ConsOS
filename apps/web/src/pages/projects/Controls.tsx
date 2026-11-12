import { useCallback, useEffect, useState } from 'react';
import { AmountInput, FormDialog } from '../../components/forms';
import { Banknote, FileSignature, Landmark, ListTree, Pencil, Plus, Receipt, Scale, Trash2, TrendingUp, Undo2, Wallet } from 'lucide-react';
import {
  api,
  type CostCategory,
  type ProjectControls,
  type Role,
  type ValuationView,
  type VariationView,
} from '../../api';
import { date, sentence, zar } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Progress,
  Select,
  Skeleton,
  Stat,
  StatusPill,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  Tr,
  errorMessage,
} from '../../components/ui';
import { ChartCard, TrendChart } from '../../components/charts';

type Sub = 'cvr' | 'costs' | 'variations' | 'valuations';

const EDITORS: Role[] = ['owner', 'admin', 'project_manager', 'finance'];
const APPROVERS: Role[] = ['owner', 'admin', 'finance'];
const TERMS_EDITORS: Role[] = ['owner', 'admin', 'project_manager'];
const CATEGORIES: CostCategory[] = ['labour', 'material', 'plant', 'subcontract', 'overhead', 'other'];
const today = () => new Date().toISOString().slice(0, 10);
const neg = (v: string | null | undefined) => Boolean(v && v.startsWith('-'));

/** Project controls: CVR, budget by cost code, costs, variations and valuations. */
export function Controls({ projectId, role, onProjectChanged }: { projectId: string; role: Role; onProjectChanged: () => void }) {
  const [data, setData] = useState<ProjectControls>();
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>('cvr');

  const load = useCallback(() => api.controls(projectId).then(setData, (e) => setError(errorMessage(e))), [projectId]);
  useEffect(() => { void load(); }, [load]);

  /** Every mutation returns the refreshed controls; errors show in the dialog that caused them. */
  const run = useCallback(async (fn: () => Promise<ProjectControls>) => {
    const next = await fn();
    setData(next);
    setError(null);
  }, []);

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Skeleton className="h-72" />;
  const s = data.summary;
  const canEdit = EDITORS.includes(role);
  const canApprove = APPROVERS.includes(role);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Revised contract value"
          icon={FileSignature}
          value={zar(s.revisedContractValue)}
          hint={`${zar(s.approvedVariations)} approved variations · ${zar(s.pendingVariations)} pending`}
        />
        <Stat label="Certified value" icon={TrendingUp} value={zar(s.certifiedValue)} hint={s.valueCompletePct ? `${s.valueCompletePct}% of contract` : 'no certificate yet'} />
        <Stat label="Cost to date" icon={Wallet} value={zar(s.costToDate)} hint={s.costCompletePct ? `${s.costCompletePct}% of revised budget` : 'no budget yet'} />
        <Stat
          label="Margin to date"
          icon={Scale}
          value={zar(s.marginToDate)}
          delta={s.marginToDatePct ? { value: `${s.marginToDatePct}%`, good: !neg(s.marginToDate) } : undefined}
          hint={`forecast at completion ${zar(s.forecastMargin)}${s.forecastMarginPct ? ` (${s.forecastMarginPct}%)` : ''}`}
        />
      </div>

      <Tabs<Sub>
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'cvr', label: 'CVR & budget', icon: Scale, count: data.costCodes.length },
          { id: 'costs', label: 'Costs', icon: Wallet, count: data.costs.length },
          { id: 'variations', label: 'Variations', icon: FileSignature, count: data.variations.length },
          { id: 'valuations', label: 'Valuations', icon: Receipt, count: data.valuations.length },
        ]}
      />

      {sub === 'cvr' && <Cvr data={data} canEdit={canEdit} canEditTerms={TERMS_EDITORS.includes(role)} run={run} onProjectChanged={() => { onProjectChanged(); void load(); }} />}
      {sub === 'costs' && <Costs data={data} canEdit={canEdit} run={run} />}
      {sub === 'variations' && <Variations data={data} canEdit={canEdit} canApprove={canApprove} run={run} />}
      {sub === 'valuations' && <Valuations data={data} canEdit={canEdit} canApprove={canApprove} run={run} />}
    </div>
  );
}

type Run = (fn: () => Promise<ProjectControls>) => Promise<void>;

const amountInput = (value: string, onChange: (v: string) => void, opts: { allowNegative?: boolean; required?: boolean } = {}) => (
  <AmountInput value={value} onChange={onChange} {...opts} />
);

// =========================================================================== CVR & budget

function Cvr({ data, canEdit, canEditTerms, run, onProjectChanged }: { data: ProjectControls; canEdit: boolean; canEditTerms: boolean; run: Run; onProjectChanged: () => void }) {
  const pid = data.project.id;
  const [editing, setEditing] = useState<ProjectControls['costCodes'][number] | 'new' | null>(null);
  const [terms, setTerms] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const monthly = data.monthly.map((m) => ({ month: m.month, value: Number(m.value), cost: Number(m.cost) }));

  const seed = async () => {
    setNotice(null);
    try {
      await run(() => api.budgetFromBaseline(pid));
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  const remove = async (id: string) => {
    setNotice(null);
    try {
      await run(() => api.deleteCostCode(pid, id));
    } catch (err) {
      setNotice(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
        <ChartCard
          title="Cost vs value"
          subtitle="Cumulative. When cost rises above certified value, the work is costing more than it earns."
          table={{ columns: ['Month', 'Certified value', 'Cost'], rows: data.monthly.map((m) => [m.month, zar(m.value), zar(m.cost)]) }}
        >
          {monthly.length === 0 ? (
            <EmptyState icon={TrendingUp} title="Nothing to chart yet">Post costs and certify a valuation to see the trend.</EmptyState>
          ) : (
            <TrendChart
              data={monthly}
              xKey="month"
              format={(v) => (Math.abs(v) >= 1e6 ? `R${(v / 1e6).toFixed(1)}m` : `R${(v / 1e3).toFixed(0)}k`)}
              series={[
                { key: 'value', label: 'Certified value', color: 'var(--series-1)' },
                { key: 'cost', label: 'Actual cost', color: 'var(--series-2)' },
              ]}
            />
          )}
        </ChartCard>

        <Card>
          <CardHeader
            title="Contract terms"
            subtitle="Used for every valuation"
            actions={canEditTerms && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setTerms(true)}>Edit</Button>}
          />
          <dl className="mt-3 space-y-2 text-[13px]">
            {[
              ['Original contract value', zar(data.project.contractValue, true)],
              ['Retention', `${data.project.retentionPct}% per certificate`],
              ['Retention limit', `${data.project.retentionLimitPct}% of contract value`],
              ['Retention held', zar(data.summary.retentionHeld, true)],
              ['Received to date', zar(data.summary.paidToDate, true)],
              ['Start', data.project.startDate ? date(data.project.startDate) : 'Not set'],
              ['Planned completion', data.project.plannedCompletion ? date(data.project.plannedCompletion) : 'Not set'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-ink-3">{k}</dt>
                <dd className="num text-right text-ink">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      {notice && <Alert>{notice}</Alert>}

      <Card padded={false}>
        <div className="p-5 pb-4">
          <CardHeader
            title="Budget and forecast by cost code"
            subtitle={`Original budget ${zar(data.summary.originalBudget)} · revised ${zar(data.summary.revisedBudget)} · committed ${zar(data.summary.committedCost)} · forecast final cost ${zar(data.summary.forecastFinalCost)}`}
            actions={canEdit && <Button size="sm" icon={Plus} onClick={() => setEditing('new')}>Cost code</Button>}
          />
        </div>
        {data.costCodes.length === 0 ? (
          <EmptyState
            icon={ListTree}
            title="No budget yet"
            action={canEdit && <Button variant="secondary" onClick={() => void seed()}>Create from locked estimate</Button>}
          >
            Add cost codes by hand, or create one per line of the project’s locked estimate, budgeted at the internal takeoff.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Cost code</Th>
                <Th right>Budget</Th>
                <Th right>Variations</Th>
                <Th right>Cost to date</Th>
                <Th right>Committed</Th>
                <Th right>To complete</Th>
                <Th right>Over / under</Th>
                <Th className="w-40">Used</Th>
                {canEdit && <Th />}
              </tr>
            </thead>
            <tbody>
              {data.costCodes.map((c) => {
                const used = Number(c.usedPct ?? 0);
                return (
                  <Tr key={c.id}>
                    <Td>
                      <span className="font-mono text-xs text-ink-3">{c.code}</span> <span className="ml-1.5 font-medium">{c.description}</span>
                    </Td>
                    <Td right>{zar(c.budget)}</Td>
                    <Td right className="text-ink-2">{c.variationBudget === '0.00' ? '—' : zar(c.variationBudget)}</Td>
                    <Td right>{zar(c.cost)}</Td>
                    <Td right className="text-ink-2">{c.committed === '0.00' ? '—' : zar(c.committed)}</Td>
                    <Td right className="text-ink-2">{zar(c.costToComplete)}</Td>
                    <Td right className={neg(c.overrun) ? 'font-medium text-critical-ink' : 'text-ink-2'}>{c.overrun === '0.00' ? '—' : zar(c.overrun)}</Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <Progress value={used} tone={used > 100 ? 'critical' : used > 90 ? 'warning' : 'brand'} />
                        <span className="num w-12 text-right text-xs text-ink-2">{c.usedPct ? `${c.usedPct}%` : '—'}</span>
                      </div>
                    </Td>
                    {canEdit && (
                      <Td className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="ghost" icon={Pencil} aria-label={`Edit ${c.code}`} onClick={() => setEditing(c)} />
                          {c.cost === '0.00' && <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${c.code}`} onClick={() => void remove(c.id)} />}
                        </div>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <CostCodeDialog projectId={pid} code={editing} onClose={() => setEditing(null)} run={run} />
      <TermsDialog open={terms} onClose={() => setTerms(false)} data={data} onSaved={onProjectChanged} />
    </div>
  );
}

function CostCodeDialog({ projectId, code, onClose, run }: { projectId: string; code: ProjectControls['costCodes'][number] | 'new' | null; onClose: () => void; run: Run }) {
  const existing = code && code !== 'new' ? code : null;
  const [form, setForm] = useState({ code: '', description: '', budget: '' });
  useEffect(() => {
    setForm(existing ? { code: existing.code, description: existing.description, budget: existing.budget } : { code: '', description: '', budget: '' });
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <FormDialog
      open={code !== null}
      onClose={onClose}
      title={existing ? `Edit cost code ${existing.code}` : 'New cost code'}
      description="Budget changes are recorded in the audit trail with the previous figure."
      submitLabel={existing ? 'Save' : 'Add cost code'}
      onSubmit={() => run(() => (existing ? api.updateCostCode(projectId, existing.id, form) : api.addCostCode(projectId, form)))}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_2fr]">
        <Field label="Code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required maxLength={30} placeholder="e.g. 200.10" /></Field>
        <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required maxLength={300} /></Field>
      </div>
      <Field label="Budget (R, excl. VAT)">{amountInput(form.budget, (budget) => setForm({ ...form, budget }), { required: true })}</Field>
    </FormDialog>
  );
}

function TermsDialog({ open, onClose, data, onSaved }: { open: boolean; onClose: () => void; data: ProjectControls; onSaved: () => void }) {
  const p = data.project;
  const blank = () => ({
    contractValue: p.contractValue ?? '',
    retentionPct: p.retentionPct,
    retentionLimitPct: p.retentionLimitPct,
    startDate: p.startDate ?? '',
    plannedCompletion: p.plannedCompletion ?? '',
  });
  const [form, setForm] = useState(blank);
  useEffect(() => { if (open) setForm(blank()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof ReturnType<typeof blank>) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Contract terms"
      description="Changes apply to valuations that are still in draft. Certified valuations keep the terms they were certified on."
      submitLabel="Save terms"
      onSubmit={async () => {
        await api.updateProject(p.id, {
          contractValue: form.contractValue || null,
          retentionPct: form.retentionPct,
          retentionLimitPct: form.retentionLimitPct,
          startDate: form.startDate || null,
          plannedCompletion: form.plannedCompletion || null,
        });
        onSaved();
      }}
    >
      <Field label="Original contract value (R, excl. VAT)">{amountInput(form.contractValue, (contractValue) => setForm({ ...form, contractValue }))}</Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Retention %" hint="Deducted from each certificate"><Input inputMode="decimal" value={form.retentionPct} onChange={set('retentionPct')} pattern="\d{1,2}(\.\d{1,2})?" required /></Field>
        <Field label="Retention limit %" hint="Of contract value; retention stops here"><Input inputMode="decimal" value={form.retentionLimitPct} onChange={set('retentionLimitPct')} pattern="\d{1,2}(\.\d{1,2})?" required /></Field>
        <Field label="Start date"><Input type="date" value={form.startDate} onChange={set('startDate')} /></Field>
        <Field label="Planned completion"><Input type="date" value={form.plannedCompletion} onChange={set('plannedCompletion')} /></Field>
      </div>
    </FormDialog>
  );
}

// =========================================================================== Costs

function Costs({ data, canEdit, run }: { data: ProjectControls; canEdit: boolean; run: Run }) {
  const pid = data.project.id;
  const [posting, setPosting] = useState(false);
  const [reversing, setReversing] = useState<ProjectControls['costs'][number] | null>(null);
  const [form, setForm] = useState({ costCodeId: '', entryDate: today(), category: 'labour' as CostCategory, description: '', amount: '', reference: '' });
  const [reason, setReason] = useState('');

  return (
    <Card padded={false}>
      <div className="p-5 pb-4">
        <CardHeader
          title="Actual costs"
          subtitle="Append-only ledger. A mistake is corrected with a reversing entry, never edited or deleted."
          actions={canEdit && <Button size="sm" icon={Plus} disabled={data.costCodes.length === 0} onClick={() => setPosting(true)}>Post cost</Button>}
        />
      </div>
      {data.costCodes.length === 0 && <div className="px-5 pb-5"><Alert tone="info">Set up the budget (cost codes) under CVR & budget before posting costs.</Alert></div>}
      {data.costs.length === 0 ? (
        <EmptyState icon={Wallet} title="No costs posted yet">Labour, materials, plant and subcontract costs posted here drive the CVR.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr><Th>Date</Th><Th>Cost code</Th><Th>Category</Th><Th>Description</Th><Th>Reference</Th><Th right>Amount</Th>{canEdit && <Th />}</tr>
          </thead>
          <tbody>
            {data.costs.map((c) => (
              <Tr key={c.id} className={c.reversed || c.reversesId ? 'text-ink-3' : undefined}>
                <Td className="whitespace-nowrap text-ink-2">{date(c.entryDate)}</Td>
                <Td mono>{c.costCode}</Td>
                <Td><span className="capitalize">{c.category}</span></Td>
                <Td>
                  {c.description}
                  {c.reversed && <Badge className="ml-2">Reversed</Badge>}
                </Td>
                <Td className="text-ink-2">{c.reference ?? '—'}</Td>
                <Td right className={neg(c.amount) ? 'text-critical-ink' : undefined}>{zar(c.amount, true)}</Td>
                {canEdit && (
                  <Td className="text-right">
                    {!c.reversed && !c.reversesId && (
                      <Button size="sm" variant="ghost" icon={Undo2} onClick={() => { setReason(''); setReversing(c); }}>Reverse</Button>
                    )}
                  </Td>
                )}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <FormDialog
        open={posting}
        onClose={() => setPosting(false)}
        title="Post a cost"
        description="Enter amounts excluding VAT. Use a negative amount for a credit note."
        submitLabel="Post cost"
        wide
        onSubmit={async () => {
          await run(() => api.addCost(pid, { ...form, reference: form.reference || undefined }));
          setForm({ ...form, description: '', amount: '', reference: '' });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Cost code" className="sm:col-span-2">
            <Select value={form.costCodeId} onChange={(e) => setForm({ ...form, costCodeId: e.target.value })} required>
              <option value="">Choose…</option>
              {data.costCodes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}
            </Select>
          </Field>
          <Field label="Date"><Input type="date" value={form.entryDate} onChange={(e) => setForm({ ...form, entryDate: e.target.value })} required /></Field>
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as CostCategory })}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{sentence(c)}</option>)}
            </Select>
          </Field>
          <Field label="Amount (R)">{amountInput(form.amount, (amount) => setForm({ ...form, amount }), { allowNegative: true, required: true })}</Field>
          <Field label="Reference" hint="Invoice, timesheet or GRN"><Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} maxLength={100} /></Field>
        </div>
        <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} required maxLength={300} /></Field>
      </FormDialog>

      <FormDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        title="Reverse cost"
        description={reversing ? `Posts ${zar(reversing.amount.startsWith('-') ? reversing.amount.slice(1) : `-${reversing.amount}`, true)} against ${reversing.costCode} dated today. The original stays on record.` : undefined}
        submitLabel="Post reversal"
        danger
        onSubmit={() => run(() => api.reverseCost(pid, reversing!.id, reason))}
      >
        <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={250} placeholder="e.g. Posted to the wrong cost code" /></Field>
      </FormDialog>
    </Card>
  );
}

// =========================================================================== Variations

const VARIATION_TONE = { draft: 'neutral', submitted: 'brand', approved: 'good', rejected: 'critical' } as const;

function Variations({ data, canEdit, canApprove, run }: { data: ProjectControls; canEdit: boolean; canApprove: boolean; run: Run }) {
  const pid = data.project.id;
  const [creating, setCreating] = useState(false);
  const [deciding, setDeciding] = useState<{ v: VariationView; to: 'approved' | 'rejected' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blank = { ref: '', title: '', description: '', instructionRef: '', notifiedOn: today(), timeBarDays: '', valueClaimed: '', costEstimate: '', costCodeId: '', timeImpactDays: '' };
  const [form, setForm] = useState(blank);
  const [decision, setDecision] = useState({ valueApproved: '', note: '' });
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const move = async (v: VariationView, to: 'submitted' | 'draft') => {
    setError(null);
    try {
      await run(() => api.transitionVariation(pid, v.id, { to }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card padded={false}>
      <div className="p-5 pb-4">
        <CardHeader
          title="Variations and compensation events"
          subtitle="Approved variations raise the contract value and the budget. Draft notices count down to their contractual time bar."
          actions={canEdit && <Button size="sm" icon={Plus} onClick={() => { setForm(blank); setCreating(true); }}>New variation</Button>}
        />
      </div>
      {error && <div className="px-5 pb-4"><Alert>{error}</Alert></div>}
      {data.variations.length === 0 ? (
        <EmptyState icon={FileSignature} title="No variations yet">Record instructions as soon as they are received, so the notice period is never missed.</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr><Th>Ref</Th><Th>Variation</Th><Th>Status</Th><Th right>Claimed</Th><Th right>Approved</Th><Th right>Our cost</Th><Th right>Time</Th><Th /></tr>
          </thead>
          <tbody>
            {data.variations.map((v) => (
              <Tr key={v.id}>
                <Td mono>{v.ref}</Td>
                <Td>
                  <div className="font-medium">{v.title}</div>
                  <div className="text-xs text-ink-3">
                    Notified {date(v.notifiedOn)}{v.instructionRef ? ` · ${v.instructionRef}` : ''}{v.decisionNote ? ` · ${v.decisionNote}` : ''}
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={VARIATION_TONE[v.status]} dot><span className="capitalize">{v.status}</span></Badge>
                    {v.timeBarDaysLeft !== null && (
                      <StatusPill status={v.timeBarDaysLeft < 0 ? 'critical' : v.timeBarDaysLeft < 14 ? 'warning' : 'good'}>
                        {v.timeBarDaysLeft < 0 ? `Time-barred ${-v.timeBarDaysLeft}d ago` : `${v.timeBarDaysLeft} days to notify`}
                      </StatusPill>
                    )}
                  </div>
                </Td>
                <Td right>{zar(v.valueClaimed)}</Td>
                <Td right>{v.valueApproved ? zar(v.valueApproved) : '—'}</Td>
                <Td right className="text-ink-2">{zar(v.costEstimate)}</Td>
                <Td right className="text-ink-2">{v.timeImpactDays ? `${v.timeImpactDays}d` : '—'}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-1">
                    {canEdit && v.status === 'draft' && <Button size="sm" variant="secondary" onClick={() => void move(v, 'submitted')}>Submit</Button>}
                    {canEdit && v.status === 'submitted' && <Button size="sm" variant="ghost" onClick={() => void move(v, 'draft')}>Withdraw</Button>}
                    {canApprove && v.status === 'submitted' && (
                      <>
                        <Button size="sm" onClick={() => { setDecision({ valueApproved: v.valueClaimed, note: '' }); setDeciding({ v, to: 'approved' }); }}>Approve</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setDecision({ valueApproved: '', note: '' }); setDeciding({ v, to: 'rejected' }); }}>Reject</Button>
                      </>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      <FormDialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New variation"
        description="Starts as a draft notice. Submit it to the client when priced."
        submitLabel="Create variation"
        wide
        onSubmit={() =>
          run(() =>
            api.addVariation(pid, {
              ref: form.ref,
              title: form.title,
              description: form.description || undefined,
              instructionRef: form.instructionRef || undefined,
              notifiedOn: form.notifiedOn,
              timeBarDays: form.timeBarDays ? Number(form.timeBarDays) : null,
              valueClaimed: form.valueClaimed || undefined,
              costEstimate: form.costEstimate || undefined,
              costCodeId: form.costCodeId || null,
              timeImpactDays: form.timeImpactDays ? Number(form.timeImpactDays) : undefined,
            }),
          )
        }
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_3fr]">
          <Field label="Reference"><Input value={form.ref} onChange={set('ref')} required maxLength={30} placeholder="VO-012" /></Field>
          <Field label="Title"><Input value={form.title} onChange={set('title')} required maxLength={200} /></Field>
        </div>
        <Field label="Description"><Textarea rows={2} value={form.description} onChange={set('description')} maxLength={5000} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Instruction ref" hint="Site / engineer’s instruction"><Input value={form.instructionRef} onChange={set('instructionRef')} maxLength={100} /></Field>
          <Field label="Became known on"><Input type="date" value={form.notifiedOn} onChange={set('notifiedOn')} required /></Field>
          <Field label="Notice period (days)" hint="NEC4: 56. Blank if none"><Input type="number" min={1} max={365} value={form.timeBarDays} onChange={set('timeBarDays')} /></Field>
          <Field label="Value claimed (R)" hint="Negative for an omission">{amountInput(form.valueClaimed, (valueClaimed) => setForm({ ...form, valueClaimed }), { allowNegative: true })}</Field>
          <Field label="Our cost estimate (R)">{amountInput(form.costEstimate, (costEstimate) => setForm({ ...form, costEstimate }), { allowNegative: true })}</Field>
          <Field label="Time impact (days)"><Input type="number" value={form.timeImpactDays} onChange={set('timeImpactDays')} /></Field>
        </div>
        <Field label="Cost code" hint="Where the extra budget goes once approved">
          <Select value={form.costCodeId} onChange={set('costCodeId')}>
            <option value="">Unallocated</option>
            {data.costCodes.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.description}</option>)}
          </Select>
        </Field>
      </FormDialog>

      <FormDialog
        open={deciding !== null}
        onClose={() => setDeciding(null)}
        title={deciding ? `${deciding.to === 'approved' ? 'Approve' : 'Reject'} ${deciding.v.ref}` : ''}
        description={deciding?.to === 'approved' ? 'Record the value the client agreed. This cannot be changed afterwards.' : 'Record why the client rejected it. This cannot be changed afterwards.'}
        submitLabel={deciding?.to === 'approved' ? 'Approve' : 'Reject'}
        danger={deciding?.to === 'rejected'}
        onSubmit={() =>
          run(() =>
            api.transitionVariation(pid, deciding!.v.id, {
              to: deciding!.to,
              valueApproved: deciding!.to === 'approved' ? decision.valueApproved : undefined,
              note: decision.note || undefined,
            }),
          )
        }
      >
        {deciding?.to === 'approved' && (
          <Field label="Agreed value (R)" hint={`Claimed ${zar(deciding.v.valueClaimed, true)}`}>
            {amountInput(decision.valueApproved, (valueApproved) => setDecision({ ...decision, valueApproved }), { allowNegative: true, required: true })}
          </Field>
        )}
        <Field label={deciding?.to === 'rejected' ? 'Reason' : 'Note'}>
          <Textarea rows={2} value={decision.note} onChange={(e) => setDecision({ ...decision, note: e.target.value })} required={deciding?.to === 'rejected'} maxLength={2000} />
        </Field>
      </FormDialog>
    </Card>
  );
}

// =========================================================================== Valuations

const VALUATION_TONE = { draft: 'neutral', submitted: 'brand', certified: 'warning', paid: 'good' } as const;

function Valuations({ data, canEdit, canApprove, run }: { data: ProjectControls; canEdit: boolean; canApprove: boolean; run: Run }) {
  const pid = data.project.id;
  const open = data.valuations.find((v) => v.status === 'draft' || v.status === 'submitted');
  const [editing, setEditing] = useState<ValuationView | 'new' | null>(null);
  const [certifying, setCertifying] = useState<ValuationView | null>(null);
  const [paying, setPaying] = useState<ValuationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ periodEnd: today(), workDoneToDate: '', materialsOnSite: '', notes: '' });
  const [cert, setCert] = useState({ certificateRef: '', certifiedWorkDone: '' });
  const [paidOn, setPaidOn] = useState(today());

  const startEdit = (v: ValuationView | 'new') => {
    setForm(
      v === 'new'
        ? { periodEnd: today(), workDoneToDate: '', materialsOnSite: '', notes: '' }
        : { periodEnd: v.periodEnd, workDoneToDate: v.workDoneToDate, materialsOnSite: v.materialsOnSite, notes: v.notes },
    );
    setEditing(v);
  };

  const move = async (v: ValuationView, to: 'submitted' | 'draft') => {
    setError(null);
    try {
      await run(() => api.transitionValuation(pid, v.id, { to }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Certified (gross, to date)" icon={Receipt} value={zar(data.summary.certifiedValue)} hint={`net ${zar(data.summary.certifiedNet)}`} />
        <Stat label="Retention held by client" icon={Landmark} value={zar(data.summary.retentionHeld)} hint="released at completion and end of defects period" />
        <Stat label="Received" icon={Banknote} value={zar(data.summary.paidToDate)} hint="certificates marked paid" />
      </div>

      <Card padded={false}>
        <div className="p-5 pb-4">
          <CardHeader
            title="Interim payment applications and certificates"
            subtitle="Cumulative figures. Retention and amounts due are calculated from the contract terms."
            actions={canEdit && (
              <Button size="sm" icon={Plus} disabled={Boolean(open)} title={open ? `Valuation ${open.valuationNo} is still open` : undefined} onClick={() => startEdit('new')}>
                New valuation
              </Button>
            )}
          />
        </div>
        {error && <div className="px-5 pb-4"><Alert>{error}</Alert></div>}
        {data.valuations.length === 0 ? (
          <EmptyState icon={Receipt} title="No valuations yet">Prepare the first payment application at the end of the month.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr><Th>No.</Th><Th>Period end</Th><Th>Status</Th><Th right>Gross to date</Th><Th right>Retention</Th><Th right>Net to date</Th><Th right>Less previous</Th><Th right>Due</Th><Th /></tr>
            </thead>
            <tbody>
              {data.valuations.map((v) => (
                <Tr key={v.id}>
                  <Td className="font-medium">{v.valuationNo}{v.certificateRef && <div className="text-xs font-normal text-ink-3">{v.certificateRef}</div>}</Td>
                  <Td className="whitespace-nowrap text-ink-2">{date(v.periodEnd)}</Td>
                  <Td>
                    <Badge tone={VALUATION_TONE[v.status]} dot><span className="capitalize">{v.status}</span></Badge>
                    {v.paidOn && <div className="mt-1 text-xs text-ink-3">{date(v.paidOn)}</div>}
                  </Td>
                  <Td right>{zar(v.grossToDate, true)}</Td>
                  <Td right className="text-ink-2">{zar(v.retentionToDate, true)}</Td>
                  <Td right>{zar(v.netToDate, true)}</Td>
                  <Td right className="text-ink-2">{zar(v.previouslyCertified, true)}</Td>
                  <Td right className={neg(v.amountDue) ? 'font-semibold text-critical-ink' : 'font-semibold'}>{zar(v.amountDue, true)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      {canEdit && v.status === 'draft' && (
                        <>
                          <Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" onClick={() => startEdit(v)} />
                          <Button size="sm" variant="secondary" onClick={() => void move(v, 'submitted')}>Submit</Button>
                        </>
                      )}
                      {canEdit && v.status === 'submitted' && <Button size="sm" variant="ghost" onClick={() => void move(v, 'draft')}>Return to draft</Button>}
                      {canApprove && v.status === 'submitted' && (
                        <Button size="sm" onClick={() => { setCert({ certificateRef: '', certifiedWorkDone: v.workDoneToDate }); setCertifying(v); }}>Certify</Button>
                      )}
                      {canApprove && v.status === 'certified' && <Button size="sm" variant="secondary" onClick={() => { setPaidOn(today()); setPaying(v); }}>Mark paid</Button>}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <FormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New valuation' : editing ? `Edit valuation ${editing.valuationNo}` : ''}
        description="Enter the cumulative value of work done to the period end, including approved variations."
        submitLabel={editing === 'new' ? 'Create draft' : 'Save'}
        onSubmit={() =>
          run(() => {
            const body = { ...form, materialsOnSite: form.materialsOnSite || '0', notes: form.notes || undefined };
            return editing === 'new' ? api.addValuation(pid, body) : api.updateValuation(pid, (editing as ValuationView).id, body);
          })
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Period end"><Input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} required /></Field>
          <Field label="Work done to date (R)">{amountInput(form.workDoneToDate, (workDoneToDate) => setForm({ ...form, workDoneToDate }), { required: true })}</Field>
          <Field label="Materials on site (R)">{amountInput(form.materialsOnSite, (materialsOnSite) => setForm({ ...form, materialsOnSite }))}</Field>
        </div>
        <Field label="Notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={5000} /></Field>
      </FormDialog>

      <FormDialog
        open={certifying !== null}
        onClose={() => setCertifying(null)}
        title={certifying ? `Certify valuation ${certifying.valuationNo}` : ''}
        description="Record the payment certificate. If the certifier valued the work differently, enter their figure. A certified valuation cannot change."
        submitLabel="Certify"
        onSubmit={() =>
          run(() => api.transitionValuation(pid, certifying!.id, { to: 'certified', certificateRef: cert.certificateRef, certifiedWorkDone: cert.certifiedWorkDone }))
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Certificate number"><Input value={cert.certificateRef} onChange={(e) => setCert({ ...cert, certificateRef: e.target.value })} required maxLength={100} placeholder="IPC-04" /></Field>
          <Field label="Certified work done (R)" hint={certifying ? `Applied for ${zar(certifying.workDoneToDate, true)}` : undefined}>
            {amountInput(cert.certifiedWorkDone, (certifiedWorkDone) => setCert({ ...cert, certifiedWorkDone }), { required: true })}
          </Field>
        </div>
      </FormDialog>

      <FormDialog
        open={paying !== null}
        onClose={() => setPaying(null)}
        title={paying ? `Payment for valuation ${paying.valuationNo}` : ''}
        description={paying ? `${zar(paying.amountDue, true)} due on ${paying.certificateRef}.` : undefined}
        submitLabel="Mark paid"
        onSubmit={() => run(() => api.transitionValuation(pid, paying!.id, { to: 'paid', paidOn }))}
      >
        <Field label="Date received"><Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required /></Field>
      </FormDialog>
    </div>
  );
}
