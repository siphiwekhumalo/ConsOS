import { useEffect, useState } from 'react';
import { api, type AuditEvent, type ChainVerification } from '../api';
import { Badge, Button, Card, Empty, ErrorText, errorMessage, PageHeader } from '../components/ui';

export function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const loadPage = async (beforeSeq?: number) => {
    try {
      const page = await api.auditEvents(beforeSeq);
      setEvents((prev) => (beforeSeq ? [...prev, ...page] : page));
      setMore(page.length === 50);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void loadPage();
  }, []);

  const verify = async () => {
    setVerifying(true);
    setError(null);
    try {
      setVerification(await api.verifyAudit());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setVerifying(false);
    }
  };

  return (
    <section>
      <PageHeader
        title="Audit trail"
        subtitle="Append-only, hash-chained record of contractual and financial actions."
        actions={
          <Button onClick={() => void verify()} disabled={verifying}>
            {verifying ? 'Verifying…' : 'Verify integrity'}
          </Button>
        }
      />
      {verification && (
        <Card className={`mb-4 ${verification.intact ? 'ring-emerald-300' : 'ring-red-300'}`}>
          {verification.intact ? (
            <p className="text-sm text-emerald-800">
              <span className="font-semibold">Intact.</span> All {verification.eventsChecked} events verify against the hash chain.
            </p>
          ) : (
            <p className="text-sm text-red-800">
              <span className="font-semibold">Tampering detected</span> at event #{verification.firstBrokenSeq}. Records from that point
              cannot be trusted. Escalate immediately.
            </p>
          )}
          <p className="mt-1 break-all font-mono text-xs text-slate-500">
            Chain head {verification.headHash} · {new Date(verification.verifiedAt).toLocaleString('en-ZA')}
          </p>
        </Card>
      )}
      <ErrorText error={error} />
      <div className="overflow-x-auto rounded-lg bg-white ring-1 ring-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">#</th>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.seq} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2 font-mono text-slate-400">{e.seq}</td>
                <td className="whitespace-nowrap px-4 py-2">{new Date(e.occurredAt).toLocaleString('en-ZA')}</td>
                <td className="px-4 py-2">
                  <Badge tone={e.action.startsWith('file.') ? 'blue' : e.action.startsWith('ai_job') ? 'amber' : 'slate'}>
                    {e.action}
                  </Badge>
                </td>
                <td className="max-w-md px-4 py-2 font-mono text-xs text-slate-600">{JSON.stringify(e.payload)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {events.length === 0 && !error && <Empty>No audit events yet.</Empty>}
      </div>
      {more && events.length > 0 && (
        <Button variant="secondary" className="mt-3" onClick={() => void loadPage(events[events.length - 1]!.seq)}>
          Load older
        </Button>
      )}
    </section>
  );
}
