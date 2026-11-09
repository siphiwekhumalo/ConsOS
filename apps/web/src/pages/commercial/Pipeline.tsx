import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, ArrowRight, Ban, ClipboardList, FileSearch, Inbox, Lock, Plus, Search, Send, TrendingDown } from 'lucide-react';
import { api, type EstimateHeader, type EstimateStage, type Me } from '../../api';
import { useAsync } from '../../lib/useAsync';
import { num, relative, zarCompact } from '../../lib/format';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Input, PageHeader, Skeleton, Stat, cx, errorMessage } from '../../components/ui';
import { LockDialog } from './EstimateDetail';
import { EDIT_ROLES, STAGES, canMove } from './stages';

const PHASES = ['Scoping', 'Planning', 'Execution', 'Invoicing'];
const STAGE_ICON: Record<EstimateStage, typeof Inbox> = {
  intake: Inbox,
  technical_review: FileSearch,
  client_approval: Send,
  baseline_locked: Lock,
  rejected: Ban,
};

export function Pipeline({ me }: { me: Me }) {
  const navigate = useNavigate();
  const { data, error, reload } = useAsync(() => api.estimates());
  const [query, setQuery] = useState('');
  const [showRejected, setShowRejected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState<EstimateHeader | null>(null);
  const [over, setOver] = useState<EstimateStage | null>(null);
  const [locking, setLocking] = useState<EstimateHeader | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const list = useMemo(
    () => (data ?? []).filter((e) => `${e.ref} ${e.title} ${e.clientName}`.toLowerCase().includes(query.trim().toLowerCase())),
    [data, query],
  );
  const open = (data ?? []).filter((e) => e.stage !== 'baseline_locked' && e.stage !== 'rejected');
  const pipelineValue = open.reduce((s, e) => s + Number(e.summary.clientTotal), 0);
  const leakage = open.reduce((s, e) => s + Number(e.summary.leakage), 0);
  const flagged = open.filter((e) => e.summary.flaggedLines > 0).length;
  const rejected = list.filter((e) => e.stage === 'rejected');

  const drop = async (to: EstimateStage) => {
    const e = dragging;
    setDragging(null);
    setOver(null);
    if (!e || e.stage === to) return;
    if (!canMove(e.stage, to, me.user.role)) {
      setMoveError(`You can’t move ${e.ref} from ${e.stage.replace('_', ' ')} to ${to.replace('_', ' ')}.`);
      return;
    }
    if (to === 'baseline_locked') {
      setLocking(e);
      return;
    }
    setMoveError(null);
    try {
      await api.transitionEstimate(e.id, { to });
      await reload();
    } catch (err) {
      setMoveError(`${e.ref}: ${errorMessage(err)}`);
    }
  };

  return (
    <div>
      <PageHeader
        title="Commercial Intake"
        description="Every client Job Card Estimate passes through here: standardised, technically scoped, compared line by line against internal takeoffs, approved by the client and frozen as the project baseline before any work starts."
        eyebrow={<PhaseRail active={0} />}
        actions={EDIT_ROLES.includes(me.user.role) && <Button icon={Plus} onClick={() => setCreating(true)}>New estimate</Button>}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Open estimates" icon={ClipboardList} value={data ? num(open.length) : <Skeleton className="h-7 w-10" />} hint="not yet baselined" />
        <Stat label="Pipeline value" icon={Inbox} value={data ? zarCompact(pipelineValue) : <Skeleton className="h-7 w-20" />} hint="client-priced, open estimates" />
        <Stat label="Estimates with flags" icon={AlertTriangle} value={data ? num(flagged) : <Skeleton className="h-7 w-10" />} hint="scope or pricing discrepancies" />
        <Stat
          label="Margin leakage at risk"
          icon={TrendingDown}
          value={data ? zarCompact(leakage) : <Skeleton className="h-7 w-20" />}
          hint="internal cost the client won’t pay"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search JCE, title or client" className="w-72 pl-9" />
        </div>
        <span className="text-xs text-ink-3">Drag a card to the next stage. Approval rules still apply.</span>
        <button onClick={() => setShowRejected(!showRejected)} className="ml-auto text-[13px] font-medium text-ink-2 hover:text-ink">
          {showRejected ? 'Hide' : 'Show'} rejected ({rejected.length})
        </button>
      </div>
      {(error || moveError) && <div className="mb-4"><Alert>{error ?? moveError}</Alert></div>}

      <div className={cx('grid gap-4 md:grid-cols-2', showRejected ? 'xl:grid-cols-5' : 'xl:grid-cols-4')}>
        {[...STAGES, ...(showRejected ? [{ id: 'rejected' as EstimateStage, label: 'Rejected', hint: 'Declined or withdrawn' }] : [])].map((stage) => {
          const cards = list.filter((e) => e.stage === stage.id);
          const Icon = STAGE_ICON[stage.id];
          const droppable = dragging && dragging.stage !== stage.id && canMove(dragging.stage, stage.id, me.user.role);
          return (
            <section
              key={stage.id}
              onDragOver={(ev) => {
                if (droppable) {
                  ev.preventDefault();
                  setOver(stage.id);
                }
              }}
              onDragLeave={() => setOver((o) => (o === stage.id ? null : o))}
              onDrop={() => void drop(stage.id)}
              className={cx(
                'flex min-h-72 flex-col rounded-xl border bg-surface-2 p-3 transition-colors',
                over === stage.id ? 'border-brand bg-brand-soft' : droppable ? 'border-dashed border-brand/50' : 'border-line',
              )}
            >
              <header className="mb-3 flex items-center gap-2 px-1">
                <Icon className="size-4 text-ink-3" />
                <span className="text-[13px] font-semibold text-ink">{stage.label}</span>
                <span className="rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold text-ink-2">{cards.length}</span>
                <span className="ml-auto text-xs text-ink-3">{zarCompact(cards.reduce((s, e) => s + Number(e.summary.clientTotal), 0))}</span>
              </header>
              <p className="mb-3 px-1 text-xs text-ink-3">{stage.hint}</p>
              <div className="space-y-2">
                {!data && <Skeleton className="h-28" />}
                {cards.map((e) => (
                  <EstimateCard
                    key={e.id}
                    estimate={e}
                    draggable={e.stage !== 'baseline_locked'}
                    onDragStart={() => setDragging(e)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onOpen={() => navigate(`/commercial/${e.id}`)}
                  />
                ))}
                {data && cards.length === 0 && <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-ink-3">Nothing here</div>}
              </div>
            </section>
          );
        })}
      </div>

      {data?.length === 0 && (
        <div className="mt-6">
          <EmptyState icon={Inbox} title="No estimates yet" action={EDIT_ROLES.includes(me.user.role) && <Button icon={Plus} onClick={() => setCreating(true)}>New estimate</Button>}>
            Register a client JCE, then import its BOQ with the AI agent or capture the lines by hand.
          </EmptyState>
        </div>
      )}

      <NewEstimateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => navigate(`/commercial/${id}`)}
      />
      {locking && (
        <LockDialog
          estimateId={locking.id}
          summary={locking.summary}
          onClose={() => setLocking(null)}
          onLocked={() => {
            setLocking(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

export function PhaseRail({ active }: { active: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {PHASES.map((p, i) => (
        <span key={p} className="inline-flex items-center gap-1.5">
          <span className={cx('rounded-md px-1.5 py-0.5 font-medium', i === active ? 'bg-brand-soft text-brand-ink ring-1 ring-brand/20' : 'text-ink-3')}>
            {i + 1}. {p}
          </span>
          {i < PHASES.length - 1 && <ArrowRight className="size-3 text-ink-3" />}
        </span>
      ))}
    </div>
  );
}

function EstimateCard({
  estimate: e,
  draggable,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  estimate: EstimateHeader;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOpen: () => void;
}) {
  const s = e.summary;
  const leak = Number(s.leakage) > 0;
  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={cx(
        'cursor-pointer rounded-lg border border-line bg-surface p-3 shadow-card transition hover:border-line-strong hover:shadow-pop',
        draggable && 'active:cursor-grabbing',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-ink-2">{e.ref}</span>
        <span className="text-[11px] text-ink-3">{relative(e.updatedAt)}</span>
      </div>
      <div className="mt-1 text-[13px] font-medium leading-snug text-ink">{e.title}</div>
      <div className="mt-0.5 text-xs text-ink-2">{e.clientName}</div>
      <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-surface-2 p-2 text-xs">
        <div>
          <div className="text-ink-3">Client</div>
          <div className="font-semibold text-ink">{zarCompact(s.clientTotal)}</div>
        </div>
        <div>
          <div className="text-ink-3">Internal</div>
          <div className="font-semibold text-ink">{zarCompact(s.internalTotal)}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Badge>{s.lines} {s.lines === 1 ? 'line' : 'lines'}</Badge>
        {s.flaggedLines > 0 && (
          <Badge tone="warning">
            <AlertTriangle className="size-3" /> {s.flaggedLines} flagged
          </Badge>
        )}
        {leak && <Badge tone="critical">Leakage {zarCompact(s.leakage)}</Badge>}
        {e.stage === 'baseline_locked' && (
          <Badge tone="good">
            <Lock className="size-3" /> Locked
          </Badge>
        )}
      </div>
    </article>
  );
}

function NewEstimateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ ref: '', title: '', clientName: '', clientReference: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const est = await api.createEstimate({ ...form, clientReference: form.clientReference || undefined });
      setForm({ ref: '', title: '', clientName: '', clientReference: '' });
      onCreated(est.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New estimate" description="Register a client Job Card Estimate. Lines are added or imported next.">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          <Field label="JCE number"><Input value={form.ref} onChange={set('ref')} placeholder="JCE-24071" required maxLength={40} /></Field>
          <Field label="Title"><Input value={form.title} onChange={set('title')} placeholder="Pipe rack re-insulation, Unit 12" required maxLength={200} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client"><Input value={form.clientName} onChange={set('clientName')} placeholder="Client or asset owner" required maxLength={200} /></Field>
          <Field label="Client reference" hint="Work order, enquiry or tender number"><Input value={form.clientReference} onChange={set('clientReference')} maxLength={100} /></Field>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy}>Create estimate</Button>
        </div>
      </form>
    </Dialog>
  );
}
