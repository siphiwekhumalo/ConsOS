import { useEffect, useState } from 'react';
import { Fingerprint, Lock, ShieldCheck, ShieldX } from 'lucide-react';
import { api, type AuditEvent, type ChainVerification } from '../api';
import { dateTime, label } from '../lib/format';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select, Table, Td, Th, Tr, errorMessage } from '../components/ui';

const TONE = (action: string) =>
  action.startsWith('file.') ? 'brand' : action.startsWith('ai_job') ? 'warning' : action.startsWith('diary') ? 'good' : 'neutral';

export function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [filter, setFilter] = useState('all');

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

  const families = [...new Set(events.map((e) => e.action.split('.')[0]!))];
  const shown = events.filter((e) => filter === 'all' || e.action.startsWith(`${filter}.`));

  return (
    <div>
      <PageHeader
        title="Audit Trail"
        description="An append-only, SHA-256 hash-chained ledger of every contractual, financial and document action. Evidence for FIDIC and NEC disputes, auditors and SARS."
        actions={<Button icon={Fingerprint} onClick={() => void verify()} loading={verifying}>Verify integrity</Button>}
      />

      {verification && (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center gap-4">
            <span className={`grid size-11 place-items-center rounded-xl ${verification.intact ? 'bg-good-soft text-good-ink' : 'bg-critical-soft text-critical-ink'}`}>
              {verification.intact ? <ShieldCheck className="size-6" /> : <ShieldX className="size-6" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-ink">
                {verification.intact ? 'Ledger intact' : `Tampering detected at event #${verification.firstBrokenSeq}`}
              </div>
              <div className="text-[13px] text-ink-2">
                {verification.intact
                  ? `All ${verification.eventsChecked} events re-hashed and matched the chain.`
                  : 'Records from that point cannot be trusted. Escalate to your security officer immediately.'}
              </div>
            </div>
            <div className="text-right text-xs text-ink-3">
              <div>Verified {dateTime(verification.verifiedAt)}</div>
              <div className="mt-0.5 max-w-[22rem] truncate font-mono" title={verification.headHash}>head {verification.headHash}</div>
            </div>
          </div>
        </Card>
      )}
      {error && <div className="mb-4"><Alert>{error}</Alert></div>}

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Lock className="size-4 text-ink-3" />
          <span className="text-sm text-ink-2">Events cannot be edited or deleted, by anyone.</span>
          <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="ml-auto w-48">
            <option value="all">All event types</option>
            {families.map((f) => <option key={f} value={f}>{label(f)}</option>)}
          </Select>
        </div>
        <Table>
          <thead>
            <tr><Th>#</Th><Th>Time</Th><Th>Event</Th><Th>Entity</Th><Th>Details</Th></tr>
          </thead>
          <tbody>
            {shown.map((e) => (
              <Tr key={e.seq}>
                <Td mono className="text-ink-3">{e.seq}</Td>
                <Td className="whitespace-nowrap text-ink-2">{dateTime(e.occurredAt)}</Td>
                <Td><Badge tone={TONE(e.action)}>{e.action}</Badge></Td>
                <Td className="text-ink-2">{label(e.entityType)}</Td>
                <Td>
                  <code className="block max-w-xl truncate text-xs text-ink-2" title={JSON.stringify(e.payload)}>
                    {Object.entries(e.payload).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}
                  </code>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {events.length === 0 && !error && <EmptyState icon={ShieldCheck} title="No events yet" />}
        {more && events.length > 0 && (
          <div className="border-t border-line p-3 text-center">
            <Button variant="ghost" size="sm" onClick={() => void loadPage(events[events.length - 1]!.seq)}>Load older events</Button>
          </div>
        )}
      </Card>
    </div>
  );
}
