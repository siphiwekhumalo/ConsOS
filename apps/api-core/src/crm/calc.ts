import { Decimal } from '@constructos/dsl-parser';
import type { OpportunityStage } from '@constructos/db';

/** CRM pipeline arithmetic. Pure; money as fixed-2 strings. */

export const OPEN_STAGES: OpportunityStage[] = ['lead', 'qualifying', 'tendering', 'submitted'];
export const CLOSED_STAGES: OpportunityStage[] = ['won', 'lost', 'no_bid'];

/** Default win probability when an opportunity enters a stage (the user can override it). */
export const STAGE_PROBABILITY: Record<OpportunityStage, number> = {
  lead: 10,
  qualifying: 25,
  tendering: 40,
  submitted: 50,
  won: 100,
  lost: 0,
  no_bid: 0,
};

type Opp = {
  stage: OpportunityStage;
  estimatedValue: string | null;
  probability: number;
  awardedValue: string | null;
  closedAt: Date | string | null;
  closingAt: Date | string | null;
  briefingOn: Date | string | null;
};

const d = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const money = (v: InstanceType<typeof Decimal>) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const iso = (v: Date | string) => (typeof v === 'string' ? v : v.toISOString());

/** Count, value and probability-weighted value of open opportunities, by stage. */
export function pipeline(opps: Opp[]) {
  const stages = OPEN_STAGES.map((stage) => {
    const here = opps.filter((o) => o.stage === stage);
    const value = here.reduce((s, o) => s.plus(d(o.estimatedValue)), d(0));
    const weighted = here.reduce((s, o) => s.plus(d(o.estimatedValue).times(o.probability).dividedBy(100)), d(0));
    return { stage, count: here.length, value: money(value), weighted: money(weighted) };
  });
  return {
    stages,
    openCount: stages.reduce((s, x) => s + x.count, 0),
    openValue: money(stages.reduce((s, x) => s.plus(x.value), d(0))),
    weightedValue: money(stages.reduce((s, x) => s.plus(x.weighted), d(0))),
  };
}

/**
 * Win rate over opportunities closed since `from`: by number (won ÷ won+lost)
 * and by value (awarded ÷ awarded + estimated value lost). No-bids are a
 * choice not to compete, so they are counted separately, not as losses.
 */
export function winRate(opps: Opp[], from: string) {
  const closed = opps.filter((o) => o.closedAt && iso(o.closedAt).slice(0, 10) >= from);
  const won = closed.filter((o) => o.stage === 'won');
  const lost = closed.filter((o) => o.stage === 'lost');
  const wonValue = won.reduce((s, o) => s.plus(d(o.awardedValue)), d(0));
  const lostValue = lost.reduce((s, o) => s.plus(d(o.estimatedValue)), d(0));
  const decided = won.length + lost.length;
  const valueBase = wonValue.plus(lostValue);
  return {
    won: won.length,
    lost: lost.length,
    noBid: closed.filter((o) => o.stage === 'no_bid').length,
    wonValue: money(wonValue),
    byCount: decided ? ((won.length / decided) * 100).toFixed(1) : null,
    byValue: valueBase.greaterThan(0) ? wonValue.dividedBy(valueBase).times(100).toDecimalPlaces(1).toFixed(1) : null,
  };
}

export type DeadlineKind = 'briefing' | 'closing';

/**
 * Upcoming briefings and closings for open tenders within `days`, plus any
 * closing date already passed while the tender is still being prepared.
 */
export function deadlines<T extends Opp & { id: string }>(opps: T[], now: Date, days: number) {
  const horizon = now.getTime() + days * 86_400_000;
  const out: { opportunity: T; kind: DeadlineKind; at: string; hoursLeft: number; missed: boolean }[] = [];
  for (const o of opps.filter((x) => x.stage !== 'submitted' && OPEN_STAGES.includes(x.stage))) {
    for (const [kind, at] of [['briefing', o.briefingOn], ['closing', o.closingAt]] as const) {
      if (!at) continue;
      const t = new Date(at).getTime();
      if (t > horizon) continue;
      const missed = t < now.getTime();
      // A briefing in the past is history, not a problem; a closing date in the past is.
      if (missed && kind === 'briefing') continue;
      out.push({ opportunity: o, kind, at: new Date(t).toISOString(), hoursLeft: Math.round((t - now.getTime()) / 3_600_000), missed });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
