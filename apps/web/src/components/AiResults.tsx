import { useState } from 'react';
import { AlertTriangle, Bot, ChevronDown, FileSpreadsheet, Loader2, ShieldAlert } from 'lucide-react';
import type { AiJob, BoqResult, DiaryReviewResult } from '../api';
import { dateTime, label, zar } from '../lib/format';
import { Badge, Card, StatusPill, cx } from './ui';

const STATUS: Record<AiJob['status'], { tone: 'neutral' | 'brand' | 'good' | 'critical'; text: string }> = {
  queued: { tone: 'neutral', text: 'Queued' },
  running: { tone: 'brand', text: 'Analysing' },
  succeeded: { tone: 'good', text: 'Complete' },
  failed: { tone: 'critical', text: 'Failed' },
};
const SEVERITY = { low: 'good', medium: 'warning', high: 'critical' } as const;

export function AiJobCard({ job, projectName }: { job: AiJob; projectName?: string }) {
  const [open, setOpen] = useState(job.status !== 'succeeded' ? false : true);
  const boq = job.kind === 'boq_extraction';
  const s = STATUS[job.status];
  const pending = job.status === 'queued' || job.status === 'running';

  return (
    <Card padded={false}>
      <button className="flex w-full items-center gap-3 p-4 text-left" onClick={() => setOpen(!open)} disabled={pending}>
        <span className={cx('grid size-9 shrink-0 place-items-center rounded-lg', boq ? 'bg-brand-soft text-brand-ink' : 'bg-warning-soft text-warning-ink')}>
          {boq ? <FileSpreadsheet className="size-[18px]" /> : <ShieldAlert className="size-[18px]" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{boq ? 'Tender BOQ extraction' : 'Site diary risk review'}</div>
          <div className="truncate text-xs text-ink-3">
            {projectName && `${projectName} · `}
            {dateTime(job.createdAt)}
            {job.model && ` · ${job.model}`}
          </div>
        </div>
        <Badge tone={s.tone}>
          {pending && <Loader2 className="size-3 animate-spin" />}
          {s.text}
        </Badge>
        {!pending && <ChevronDown className={cx('size-4 text-ink-3 transition-transform', open && 'rotate-180')} />}
      </button>
      {open && (
        <div className="border-t border-line p-4">
          {job.error && <p className="text-sm text-critical-ink">{job.error}</p>}
          {job.status === 'succeeded' && job.result && (boq ? <BoqView boq={job.result as BoqResult} /> : <RiskView review={job.result as DiaryReviewResult} />)}
        </div>
      )}
    </Card>
  );
}

function BoqView({ boq }: { boq: BoqResult }) {
  const items = boq.sections.reduce((n, s) => n + s.items.length, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-ink-2">
        <span><span className="font-medium text-ink">{boq.document_title ?? 'Untitled document'}</span></span>
        <span>{items} line items</span>
        <span>{boq.sections.length} bills</span>
        <span>{boq.currency}</span>
      </div>
      {boq.warnings.length > 0 && (
        <div className="rounded-lg bg-warning-soft p-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-warning-ink">
            <AlertTriangle className="size-4" /> {boq.warnings.length} item(s) need review
          </div>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-[13px] text-warning-ink/90">
            {boq.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-xs uppercase tracking-wide text-ink-3">
            <tr>
              {['Item', 'Description', 'Unit', 'Qty', 'Rate', 'Amount'].map((h, i) => (
                <th key={h} className={cx('px-3 py-2 font-medium', i >= 3 ? 'text-right' : 'text-left')}>{h}</th>
              ))}
            </tr>
          </thead>
          {boq.sections.map((s) => (
            <tbody key={s.name}>
              <tr>
                <td colSpan={6} className="bg-surface-2/60 px-3 py-1.5 text-[13px] font-semibold text-ink">{s.name}</td>
              </tr>
              {s.items.map((it) => (
                <tr key={it.item_no + it.description} className="border-t border-line">
                  <td className="px-3 py-2 font-mono text-[13px] text-ink-2">{it.item_no}</td>
                  <td className="px-3 py-2 text-ink">{it.description}</td>
                  <td className="px-3 py-2 text-ink-2">{it.unit}</td>
                  <td className="num px-3 py-2 text-right">{it.quantity ?? '—'}</td>
                  <td className="num px-3 py-2 text-right">{zar(it.rate, true)}</td>
                  <td className="num px-3 py-2 text-right">{zar(it.amount, true)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <p className="text-xs text-ink-3">AI-extracted figures are suggestions. Check them against the source document before pricing.</p>
    </div>
  );
}

function RiskView({ review }: { review: DiaryReviewResult }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink">{review.summary}</p>
      {review.risks.map((r, i) => (
        <div key={i} className="rounded-lg border border-line p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={SEVERITY[r.severity]}>
              <span className="capitalize">{r.severity}</span>
            </StatusPill>
            <span className="text-sm font-medium capitalize text-ink">{label(r.category)}</span>
            <span className="ml-auto text-xs text-ink-3">Evidence: {r.evidence_dates.join(', ')}</span>
          </div>
          <p className="mt-2 text-sm text-ink">{r.finding}</p>
          <p className="mt-1 text-sm text-ink-2">
            <span className="font-medium text-ink">Recommendation · </span>
            {r.recommendation}
          </p>
        </div>
      ))}
      {review.risks.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-good-ink">
          <Bot className="size-4" /> No material risks found in the reviewed entries.
        </div>
      )}
    </div>
  );
}
