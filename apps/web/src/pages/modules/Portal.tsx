import { CalendarClock, EyeOff, PenLine, ShieldCheck, Target, UserPlus } from 'lucide-react';
import { Badge, Button, Card, CardHeader, PageHeader, PreviewBanner, Progress, Stat, StatusPill, Table, Td, Th, Tr } from '../../components/ui';
import { hseKpis, portalMilestones } from '../../demo/data';

export function Portal() {
  const overall = Math.round(portalMilestones.reduce((n, m) => n + m.pct, 0) / portalMilestones.length);
  return (
    <div>
      <PageHeader
        title="Client / Owner Portal"
        description="What your clients and consulting engineers see: read-only progress, safety and programme, with internal margins and subcontractor pricing redacted."
        eyebrow={<Badge tone="brand">Module 9</Badge>}
        actions={<Button icon={UserPlus} variant="secondary">Invite client user</Button>}
      />
      <PreviewBanner module="client portal" />

      <Card className="mb-6 flex flex-wrap items-center gap-3 border-dashed">
        <EyeOff className="size-4 text-ink-3" />
        <span className="text-[13px] text-ink-2">
          Preview of the owner’s view for <span className="font-medium text-ink">Shaft 4 Refurbishment</span>. Profit margins, cost codes and
          subcontractor rates are never shown here.
        </span>
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Physical progress" icon={Target} value={`${overall}%`} hint="weighted by milestone">
          <div className="mt-3"><Progress value={overall} /></div>
        </Stat>
        <Stat label="Programme" icon={CalendarClock} value="−18 days" hint="behind baseline" delta={{ value: 'recoverable', good: true }} />
        <Stat label="Safety" icon={ShieldCheck} value={`${hseKpis.ltiFreeDays} days`} hint="without a lost-time injury" />
        <Stat label="Awaiting your sign-off" icon={PenLine} value="1" hint="milestone certificate" />
      </div>

      <Card padded={false}>
        <div className="p-5 pb-4"><CardHeader title="Milestones" subtitle="Digital sign-off vault for completion certificates" /></div>
        <Table>
          <thead><tr><Th>Milestone</Th><Th>Planned</Th><Th>Actual</Th><Th className="w-56">Progress</Th><Th>Sign-off</Th></tr></thead>
          <tbody>
            {portalMilestones.map((m) => (
              <Tr key={m.name}>
                <Td className="font-medium">{m.name}</Td>
                <Td className="text-ink-2">{m.planned}</Td>
                <Td className="text-ink-2">{m.actual ?? '—'}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <Progress value={m.pct} tone={m.pct === 100 ? 'good' : 'brand'} />
                    <span className="num w-9 text-right text-xs text-ink-2">{m.pct}%</span>
                  </div>
                </Td>
                <Td>
                  {m.signoff === 'signed' ? (
                    <StatusPill status="good">Signed</StatusPill>
                  ) : m.signoff === 'awaiting signature' ? (
                    <Button size="sm" icon={PenLine}>Review & sign</Button>
                  ) : (
                    <span className="text-xs text-ink-3">Not due</span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
