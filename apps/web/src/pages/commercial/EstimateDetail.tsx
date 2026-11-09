import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CornerUpLeft,
  FileSearch,
  Lock,
  Plus,
  RotateCcw,
  Scale,
  Send,
  Sparkles,
  TrendingDown,
  Trash2,
  Wallet,
} from 'lucide-react';
import { api, type AiJob, type AuditEvent, type Estimate, type EstimateLine, type EstimateStage, type EstimateSummary, type Me } from '../../api';
import { useSetCrumb } from '../../lib/crumb';
import { dateTime, zar } from '../../lib/format';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Skeleton, Stat, StatusPill, Textarea, cx, errorMessage } from '../../components/ui';
import { PhaseRail } from './Pipeline';
import { EDIT_ROLES, FLAG_META, STAGES, STAGE_LABEL, canMove } from './stages';

const money = (v: string | null) => (v === null ? '—' : zar(v, true));
const qty = (v: string | null) => (v === null ? '—' : Number(v).toLocaleString('en-ZA', { maximumFractionDigits: 3 }));

export function EstimateDetail({ me }: { me: Me }) {
  const { estimateId = '' } = useParams();
  const [est, setEst] = useState<Estimate>();
  const [error, setError] = useState<string | null>(null);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [editing, setEditing] = useState<EstimateLine | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [move, setMove] = useState<EstimateStage | null>(null);
  const [locking, setLocking] = useState(false);
  const [history, setHistory] = useState<AuditEvent[]>();
  const canSeeHistory = ['owner', 'admin', 'finance'].includes(me.user.role);

  const load = async () => {
    try {
      setEst(await api.estimate(estimateId));
      if (canSeeHistory) setHistory(await api.entityHistory('estimate', estimateId));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimateId]);
  useSetCrumb(est ? `${est.ref} · ${est.title}` : null);

  if (error && !est) return <Alert>{error}</Alert>;
  if (!est) return <Skeleton className="h-96" />;

  const s = est.summary;
  const role = me.user.role;
  const editable = (est.stage === 'intake' || est.stage === 'technical_review') && EDIT_ROLES.includes(role);
  const lines = flaggedOnly ? est.lines.filter((l) => l.flags.length) : est.lines;
  const updated = (e: Estimate) => {
    setEst(e);
    setError(null);
    if (canSeeHistory) api.entityHistory('estimate', estimateId).then(setHistory, () => undefined);
  };

  const actions: { to: EstimateStage; label: string; icon: typeof Send; variant: 'primary' | 'secondary' | 'danger' }[] = (
    [
      { to: 'technical_review', label: est.stage === 'intake' ? 'Submit for technical review' : 'Back to technical review', icon: est.stage === 'intake' ? FileSearch : CornerUpLeft, variant: est.stage === 'intake' ? 'primary' : 'secondary' },
      { to: 'client_approval', label: 'Commercial sign-off: send to client', icon: Send, variant: 'primary' },
      { to: 'baseline_locked', label: 'Lock baseline', icon: Lock, variant: 'primary' },
      { to: 'intake', label: est.stage === 'rejected' ? 'Reopen' : 'Back to intake', icon: est.stage === 'rejected' ? RotateCcw : CornerUpLeft, variant: 'secondary' },
      { to: 'rejected', label: 'Reject', icon: Ban, variant: 'secondary' },
    ] as const
  ).filter((a) => canMove(est.stage, a.to, role));

  return (
    <div>
      <Link to="/commercial" className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-3 hover:text-ink">
        <ArrowLeft className="size-4" /> Commercial Intake
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-ink-2">{est.ref}</span>
            <StageBadge stage={est.stage} />
            <PhaseRail active={0} />
          </div>
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{est.title}</h1>
          <p className="mt-1 text-sm text-ink-2">
            {est.clientName}
            {est.clientReference && <span className="text-ink-3"> · ref {est.clientReference}</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {actions.map((a) => (
            <Button
              key={a.to}
              variant={a.variant}
              icon={a.icon}
              onClick={() => (a.to === 'baseline_locked' ? setLocking(true) : setMove(a.to))}
            >
              {a.label}
            </Button>
          ))}
        </div>
      </div>

      <Stepper stage={est.stage} />

      {est.stage === 'baseline_locked' && (
        <Card className="mb-6 border-good/40 bg-good-soft">
          <div className="flex flex-wrap items-center gap-4">
            <Lock className="size-5 text-good-ink" />
            <div className="min-w-0 flex-1 text-sm text-good-ink">
              <span className="font-semibold">Baseline locked {est.lockedAt && dateTime(est.lockedAt)}</span> against client approval{' '}
              <span className="font-mono">{est.clientApprovalRef}</span>. Scope and baseline costs are frozen; changes now go through variations.
            </div>
            {est.projectId && (
              <Link to={`/projects/${est.projectId}`}>
                <Button variant="secondary" size="sm">Open project</Button>
              </Link>
            )}
          </div>
        </Card>
      )}
      {est.stage === 'rejected' && (
        <div className="mb-6">
          <Alert title="Rejected">{est.rejectionReason}</Alert>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Client total" icon={Wallet} value={zar(s.clientTotal)} hint="what the client’s JCE pays" />
        <Stat label="Internal total" icon={Scale} value={zar(s.internalTotal)} hint="your measured and priced scope" />
        <Stat
          label="Margin"
          icon={Scale}
          value={`${Number(s.margin) < 0 ? '−' : ''}${zar(Math.abs(Number(s.margin)))}`}
          delta={s.marginPct ? { value: `${s.marginPct}%`, good: Number(s.margin) >= 0 } : undefined}
          hint="client − internal"
        />
        <Stat label="Leakage at risk" icon={TrendingDown} value={zar(s.leakage)} hint={`${s.flaggedLines} of ${s.lines} lines flagged`} />
      </div>

      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <h2 className="text-sm font-semibold text-ink">Client JCE vs internal takeoff</h2>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(FLAG_META) as (keyof typeof FLAG_META)[])
              .filter((f) => s.flagCounts[f] > 0)
              .map((f) => (
                <span key={f} title={FLAG_META[f].help}>
                  <Badge tone={FLAG_META[f].tone}>
                    {FLAG_META[f].label} · {s.flagCounts[f]}
                  </Badge>
                </span>
              ))}
          </div>
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} className="size-4 accent-[var(--brand)]" />
            Flagged only
          </label>
          {editable && (
            <>
              <Button size="sm" variant="secondary" icon={Sparkles} onClick={() => setImporting(true)}>Import from AI</Button>
              <Button size="sm" icon={Plus} onClick={() => setEditing('new')}>Add line</Button>
            </>
          )}
        </div>

        {est.lines.length === 0 ? (
          <EmptyState icon={FileSearch} title="No lines yet">
            Import the client’s BOQ from an AI extraction, or add lines by hand. Then capture your internal takeoff against each line.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-wider text-ink-3">
                  <th colSpan={3} className="border-b border-line bg-surface-2 px-4 py-2 text-left first:pl-5">Line item</th>
                  <th colSpan={3} className="border-b border-l border-line bg-surface-2 px-4 py-2 text-center">Client JCE</th>
                  <th colSpan={3} className="border-b border-l border-line bg-brand-soft/60 px-4 py-2 text-center text-brand-ink">Internal takeoff</th>
                  <th className="border-b border-l border-line bg-surface-2 px-4 py-2 text-center">Variance</th>
                </tr>
                <tr className="text-xs text-ink-3">
                  {['#', 'Description & flags', 'Unit', 'Qty', 'Rate', 'Amount', 'Qty', 'Rate', 'Amount', 'Margin'].map((h, i) => (
                    <th
                      key={h + i}
                      className={cx(
                        'whitespace-nowrap border-b border-line px-4 py-2 font-medium first:pl-5 last:pr-5',
                        i >= 3 ? 'text-right' : 'text-left',
                        (i === 3 || i === 6 || i === 9) && 'border-l',
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const qtyDiff = l.flags.includes('qty_mismatch');
                  const rateDiff = l.flags.includes('rate_variance');
                  const leak = l.flags.includes('under_recovery');
                  return (
                    <tr
                      key={l.id}
                      onClick={() => editable && setEditing(l)}
                      className={cx('border-b border-line last:border-b-0', editable && 'cursor-pointer hover:bg-surface-2', leak && 'bg-critical-soft/40')}
                    >
                      <td className="whitespace-nowrap py-2.5 pl-5 pr-3 font-mono text-[13px] text-ink-2">{l.lineNo}</td>
                      <td className="min-w-64 px-4 py-2.5 text-ink">
                        {l.description}
                        {l.source === 'ai_extraction' && <Sparkles className="ml-1.5 inline size-3 text-ink-3" aria-label="Imported by AI" />}
                        <div className="mt-1 flex flex-wrap gap-1">
                          {l.flags.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-xs text-good-ink"><Check className="size-3.5" /> Matches client</span>
                          ) : (
                            l.flags.map((f) => (
                              <span key={f} title={FLAG_META[f].help}>
                                <Badge tone={FLAG_META[f].tone}>{FLAG_META[f].label}</Badge>
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-ink-2">{l.unit}</td>
                      <td className="num border-l border-line px-4 py-2.5 text-right">{qty(l.clientQty)}</td>
                      <td className="num px-4 py-2.5 text-right">{money(l.clientRate)}</td>
                      <td className="num whitespace-nowrap px-4 py-2.5 text-right font-medium">{money(l.clientAmount)}</td>
                      <td className={cx('num border-l border-line px-4 py-2.5 text-right', qtyDiff && 'font-semibold text-warning-ink')}>{qty(l.internalQty)}</td>
                      <td className={cx('num px-4 py-2.5 text-right', rateDiff && 'font-semibold text-warning-ink')}>{money(l.internalRate)}</td>
                      <td className="num whitespace-nowrap px-4 py-2.5 text-right font-medium">{money(l.internalAmount)}</td>
                      <td className={cx('num whitespace-nowrap border-l border-line py-2.5 pl-4 pr-5 text-right font-medium', l.margin && Number(l.margin) < 0 ? 'text-critical-ink' : 'text-ink')}>
                        {l.margin === null ? '—' : `${Number(l.margin) < 0 ? '−' : ''}${zar(Math.abs(Number(l.margin)), true)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line-strong bg-surface-2 text-sm font-semibold">
                  <td colSpan={5} className="py-3 pl-5 text-ink">Totals</td>
                  <td className="num px-4 text-right">{zar(s.clientTotal, true)}</td>
                  <td colSpan={2} className="border-l border-line" />
                  <td className="num px-4 text-right">{zar(s.internalTotal, true)}</td>
                  <td className={cx('num border-l border-line py-3 pl-4 pr-5 text-right', Number(s.margin) < 0 ? 'text-critical-ink' : 'text-ink')}>
                    {`${Number(s.margin) < 0 ? '−' : ''}${zar(Math.abs(Number(s.margin)), true)}`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
      {editable && est.lines.length > 0 && <p className="mt-2 text-xs text-ink-3">Click a line to edit it. Lines freeze when the estimate is sent to the client.</p>}

      {canSeeHistory && history && history.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="Approval history" subtitle="From the tamper-evident audit trail" />
          <ol className="mt-4 space-y-3">
            {history.map((h) => (
              <li key={h.seq} className="flex gap-3 text-[13px]">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" />
                <div>
                  <div className="text-ink">{describe(h)}</div>
                  <div className="text-xs text-ink-3">{dateTime(h.occurredAt)}</div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {editing && (
        <LineDialog
          estimateId={est.id}
          line={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(e) => {
            setEditing(null);
            updated(e);
          }}
        />
      )}
      {importing && <ImportDialog estimateId={est.id} onClose={() => setImporting(false)} onImported={(e) => { setImporting(false); updated(e); }} />}
      {move && <MoveDialog estimate={est} to={move} onClose={() => setMove(null)} onMoved={(e) => { setMove(null); updated(e); }} />}
      {locking && <LockDialog estimateId={est.id} summary={s} onClose={() => setLocking(false)} onLocked={(e) => { setLocking(false); updated(e); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function StageBadge({ stage }: { stage: EstimateStage }) {
  const tone = stage === 'baseline_locked' ? 'good' : stage === 'rejected' ? 'critical' : stage === 'client_approval' ? 'warning' : 'brand';
  return (
    <Badge tone={tone} dot>
      {STAGE_LABEL[stage]}
    </Badge>
  );
}

function Stepper({ stage }: { stage: EstimateStage }) {
  const idx = STAGES.findIndex((s) => s.id === stage);
  return (
    <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {STAGES.map((s, i) => {
        const done = stage !== 'rejected' && (i < idx || stage === 'baseline_locked');
        const current = i === idx && stage !== 'baseline_locked';
        return (
          <li
            key={s.id}
            className={cx(
              'rounded-lg border px-3 py-2',
              done ? 'border-good/30 bg-good-soft' : current ? 'border-brand bg-brand-soft' : 'border-line bg-surface',
            )}
          >
            <div className={cx('flex items-center gap-1.5 text-[13px] font-semibold', done ? 'text-good-ink' : current ? 'text-brand-ink' : 'text-ink-3')}>
              {done ? <Check className="size-4" /> : <span className="grid size-4 place-items-center rounded-full border border-current text-[10px]">{i + 1}</span>}
              {s.label}
            </div>
            <div className="mt-0.5 text-xs text-ink-3">{s.hint}</div>
          </li>
        );
      })}
    </ol>
  );
}

function describe(h: AuditEvent) {
  const p = h.payload as Record<string, unknown>;
  const lbl = (s: unknown) => STAGE_LABEL[s as EstimateStage] ?? String(s);
  switch (h.action) {
    case 'estimate.created':
      return `Estimate registered for ${String(p.client ?? '')}`;
    case 'estimate.stage_changed':
      return `Moved from ${lbl(p.from)} to ${lbl(p.to)}${p.note ? `: “${String(p.note)}”` : ''}`;
    case 'estimate.lines_imported':
      return `${String(p.imported)} line(s) imported from AI extraction${Number(p.skipped) ? `, ${String(p.skipped)} skipped as duplicates` : ''}`;
    case 'estimate.baseline_locked':
      return `Baseline locked against ${String(p.clientApprovalRef)}: client ${zar(String(p.clientTotal))}, internal ${zar(String(p.internalTotal))}${p.varianceAcknowledged ? ' (variances acknowledged)' : ''}`;
    default:
      return h.action;
  }
}

// ---------------------------------------------------------------------------

const dec = (v: string) => v.replace(/[\s,R]/g, '') || null;

function LineDialog({ estimateId, line, onClose, onSaved }: { estimateId: string; line: EstimateLine | null; onClose: () => void; onSaved: (e: Estimate) => void }) {
  const [form, setForm] = useState({
    lineNo: line?.lineNo ?? '',
    description: line?.description ?? '',
    unit: line?.unit ?? '',
    clientQty: line?.clientQty ?? '',
    clientRate: line?.clientRate ?? '',
    internalQty: line?.internalQty ?? '',
    internalRate: line?.internalRate ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      lineNo: form.lineNo.trim(),
      description: form.description.trim(),
      unit: form.unit.trim(),
      clientQty: dec(form.clientQty),
      clientRate: dec(form.clientRate),
      internalQty: dec(form.internalQty),
      internalRate: dec(form.internalRate),
    };
    try {
      onSaved(line ? await api.updateLine(estimateId, line.id, body) : await api.addLine(estimateId, body));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!line) return;
    setBusy(true);
    try {
      onSaved(await api.deleteLine(estimateId, line.id));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={line ? `Line ${line.lineNo}` : 'Add line'} description="Leave a side blank if that party has not priced the item." wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[7rem_1fr_6rem]">
          <Field label="Line no."><Input value={form.lineNo} onChange={set('lineNo')} required maxLength={20} /></Field>
          <Field label="Description"><Input value={form.description} onChange={set('description')} required maxLength={500} /></Field>
          <Field label="Unit"><Input value={form.unit} onChange={set('unit')} placeholder="m, m², t, ea" required maxLength={20} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="rounded-xl border border-line p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-ink-3">Client JCE</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity"><Input className="num" value={form.clientQty} onChange={set('clientQty')} inputMode="decimal" /></Field>
              <Field label="Rate (R)"><Input className="num" value={form.clientRate} onChange={set('clientRate')} inputMode="decimal" /></Field>
            </div>
          </fieldset>
          <fieldset className="rounded-xl border border-brand/30 bg-brand-soft/40 p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-brand-ink">Internal takeoff</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity"><Input className="num" value={form.internalQty} onChange={set('internalQty')} inputMode="decimal" /></Field>
              <Field label="Rate (R)"><Input className="num" value={form.internalRate} onChange={set('internalRate')} inputMode="decimal" /></Field>
            </div>
          </fieldset>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex items-center gap-2 border-t border-line pt-4">
          {line && <Button type="button" variant="ghost" icon={Trash2} onClick={() => void remove()} disabled={busy} className="text-critical-ink">Delete line</Button>}
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy}>{line ? 'Save line' : 'Add line'}</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function ImportDialog({ estimateId, onClose, onImported }: { estimateId: string; onClose: () => void; onImported: (e: Estimate) => void }) {
  const [jobs, setJobs] = useState<AiJob[]>();
  const [jobId, setJobId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.aiJobs().then(
      (all) => setJobs(all.filter((j) => j.kind === 'boq_extraction' && j.status === 'succeeded')),
      (e) => setError(errorMessage(e)),
    );
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      onImported(await api.importAiLines(estimateId, jobId));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Import from AI extraction" description="Copies the extracted BOQ lines in as the client’s figures. Existing line numbers are kept.">
      <div className="space-y-4">
        {jobs?.length === 0 ? (
          <Alert tone="info">No completed BOQ extractions yet. Upload the client’s PDF to a project, choose “Extract BOQ”, then come back.</Alert>
        ) : (
          <Field label="Extraction">
            <Select value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">Choose an extraction…</option>
              {jobs?.map((j) => {
                const r = j.result as { document_title?: string; sections?: { items: unknown[] }[] } | null;
                const n = r?.sections?.reduce((c, s) => c + s.items.length, 0) ?? 0;
                return (
                  <option key={j.id} value={j.id}>
                    {r?.document_title ?? 'Untitled'} · {n} lines · {dateTime(j.createdAt)}
                  </option>
                );
              })}
            </Select>
          </Field>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button icon={Sparkles} onClick={() => void submit()} disabled={!jobId} loading={busy}>Import lines</Button>
        </div>
      </div>
    </Dialog>
  );
}

function MoveDialog({ estimate, to, onClose, onMoved }: { estimate: Estimate; to: EstimateStage; onClose: () => void; onMoved: (e: Estimate) => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reject = to === 'rejected';
  const toClient = to === 'client_approval';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onMoved(await api.transitionEstimate(estimate.id, { to, note: note || undefined }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`${reject ? 'Reject' : 'Move to'} ${reject ? estimate.ref : STAGE_LABEL[to]}`} description="Recorded in the approval history.">
      <form onSubmit={submit} className="space-y-4">
        {toClient && (
          <Alert tone="warning" title="Lines will freeze">
            Once sent to the client, line items can’t be edited. Client queries send it back to technical review.
          </Alert>
        )}
        {toClient && estimate.summary.flaggedLines > 0 && (
          <Alert tone="info">{estimate.summary.flaggedLines} line(s) carry discrepancy flags. Make sure they’re intended before sign-off.</Alert>
        )}
        <Field label={reject ? 'Reason (required)' : 'Note (optional)'}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} required={reject} maxLength={2000} />
        </Field>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant={reject ? 'danger' : 'primary'} loading={busy}>{reject ? 'Reject estimate' : 'Confirm'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function LockDialog({ estimateId, summary, onClose, onLocked }: { estimateId: string; summary: EstimateSummary; onClose: () => void; onLocked: (e: Estimate) => void }) {
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flagged = summary.flaggedLines > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onLocked(await api.transitionEstimate(estimateId, { to: 'baseline_locked', clientApprovalRef: ref, note: note || undefined, acknowledgeVariance: ack }));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Lock baseline" description="Freezes scope and baseline costs and creates the project. This cannot be undone." wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 rounded-xl border border-line bg-surface-2 p-4 text-sm sm:grid-cols-3">
          <div><div className="text-xs text-ink-3">Contract value (client)</div><div className="font-semibold text-ink">{zar(summary.clientTotal, true)}</div></div>
          <div><div className="text-xs text-ink-3">Baseline cost (internal)</div><div className="font-semibold text-ink">{zar(summary.internalTotal, true)}</div></div>
          <div><div className="text-xs text-ink-3">Margin</div><div className={cx('font-semibold', Number(summary.margin) < 0 ? 'text-critical-ink' : 'text-ink')}>{summary.marginPct ?? '—'}%</div></div>
        </div>
        <Field label="Client approval / PO reference"><Input value={ref} onChange={(e) => setRef(e.target.value)} required maxLength={100} placeholder="PO 4500123456" /></Field>
        <Field label="Note (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} /></Field>
        {flagged && (
          <label className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm text-warning-ink">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 accent-[var(--brand)]" />
            <span>
              <span className="flex items-center gap-1.5 font-medium"><AlertTriangle className="size-4" /> {summary.flaggedLines} line(s) are flagged</span>
              I accept the remaining scope and pricing variances{Number(summary.leakage) > 0 && `, including ${zar(summary.leakage)} of internal cost the client will not pay`}.
            </span>
          </label>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="flex items-center gap-2 border-t border-line pt-4">
          <StatusPill status="warning">Irreversible</StatusPill>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" icon={Lock} loading={busy} disabled={!ref || (flagged && !ack)}>Lock baseline</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
