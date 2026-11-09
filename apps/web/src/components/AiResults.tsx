import { formatZar, label, type AiJob, type BoqResult, type DiaryReviewResult } from '../api';
import { Badge, Card } from './ui';

const STATUS_TONE = { queued: 'slate', running: 'blue', succeeded: 'green', failed: 'red' } as const;
const SEVERITY_TONE = { low: 'slate', medium: 'amber', high: 'red' } as const;

export function AiJobCard({ job }: { job: AiJob }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{job.kind === 'boq_extraction' ? 'BOQ extraction' : 'Site diary risk review'}</span>
        <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
        {job.model && <span className="text-xs text-slate-400">{job.model}</span>}
        <span className="ml-auto text-xs text-slate-400">{new Date(job.createdAt).toLocaleString('en-ZA')}</span>
      </div>
      {job.error && <p className="mt-2 text-sm text-red-600">{job.error}</p>}
      {job.status === 'succeeded' && job.result && job.kind === 'boq_extraction' && <BoqView boq={job.result as BoqResult} />}
      {job.status === 'succeeded' && job.result && job.kind === 'diary_risk_review' && (
        <RiskView review={job.result as DiaryReviewResult} />
      )}
    </Card>
  );
}

function BoqView({ boq }: { boq: BoqResult }) {
  const itemCount = boq.sections.reduce((n, s) => n + s.items.length, 0);
  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-slate-600">
        {boq.document_title ?? 'Untitled'} · {itemCount} items in {boq.sections.length} sections · {boq.currency}
      </p>
      {boq.warnings.length > 0 && (
        <ul className="list-disc space-y-1 rounded-md bg-amber-50 py-2 pl-6 pr-3 text-sm text-amber-900">
          {boq.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="py-1 pr-3 font-medium">Item</th>
              <th className="py-1 pr-3 font-medium">Description</th>
              <th className="py-1 pr-3 font-medium">Unit</th>
              <th className="py-1 pr-3 text-right font-medium">Qty</th>
              <th className="py-1 pr-3 text-right font-medium">Rate</th>
              <th className="py-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          {boq.sections.map((s) => (
            <tbody key={s.name}>
              <tr>
                <td colSpan={6} className="pt-3 font-medium">
                  {s.name}
                </td>
              </tr>
              {s.items.map((it) => (
                <tr key={it.item_no + it.description} className="border-t border-slate-100">
                  <td className="py-1 pr-3 font-mono">{it.item_no}</td>
                  <td className="py-1 pr-3">{it.description}</td>
                  <td className="py-1 pr-3">{it.unit}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{it.quantity ?? '—'}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{formatZar(it.rate)}</td>
                  <td className="py-1 text-right tabular-nums">{formatZar(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

function RiskView({ review }: { review: DiaryReviewResult }) {
  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm">{review.summary}</p>
      {review.risks.map((r, i) => (
        <div key={i} className="rounded-md border border-slate-200 p-3 text-sm">
          <div className="flex items-center gap-2">
            <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
            <span className="font-medium capitalize">{label(r.category)}</span>
            <span className="ml-auto text-xs text-slate-400">{r.evidence_dates.join(', ')}</span>
          </div>
          <p className="mt-1">{r.finding}</p>
          <p className="mt-1 text-slate-600">
            <span className="font-medium">Recommendation: </span>
            {r.recommendation}
          </p>
        </div>
      ))}
    </div>
  );
}
