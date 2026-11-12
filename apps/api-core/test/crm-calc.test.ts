import { describe, expect, it } from 'vitest';
import { deadlines, pipeline, winRate } from '../src/crm/calc';

const opp = (o: Partial<Parameters<typeof pipeline>[0][number]> & { id?: string }) => ({
  id: o.id ?? Math.random().toString(36),
  stage: 'lead' as const,
  estimatedValue: null,
  probability: 10,
  awardedValue: null,
  closedAt: null,
  closingAt: null,
  briefingOn: null,
  ...o,
});

describe('pipeline', () => {
  it('sums open value and probability-weighted value by stage; closed deals are excluded', () => {
    const p = pipeline([
      opp({ stage: 'lead', estimatedValue: '1000000.00', probability: 10 }),
      opp({ stage: 'tendering', estimatedValue: '2000000.00', probability: 40 }),
      opp({ stage: 'tendering', estimatedValue: '500000.00', probability: 50 }),
      opp({ stage: 'won', estimatedValue: '9000000.00', probability: 100 }),
      opp({ stage: 'qualifying', estimatedValue: null, probability: 25 }),
    ]);
    expect(p.stages.find((s) => s.stage === 'tendering')).toEqual({ stage: 'tendering', count: 2, value: '2500000.00', weighted: '1050000.00' });
    expect(p).toMatchObject({ openCount: 4, openValue: '3500000.00', weightedValue: '1150000.00' });
  });
});

describe('win rate', () => {
  it('counts won against lost by number and by value; no-bids are separate', () => {
    const r = winRate([
      opp({ stage: 'won', awardedValue: '3000000.00', closedAt: '2026-05-01T00:00:00Z' }),
      opp({ stage: 'lost', estimatedValue: '1000000.00', closedAt: '2026-06-01T00:00:00Z' }),
      opp({ stage: 'lost', estimatedValue: '2000000.00', closedAt: '2026-07-01T00:00:00Z' }),
      opp({ stage: 'no_bid', closedAt: '2026-07-02T00:00:00Z' }),
      opp({ stage: 'won', awardedValue: '9.00', closedAt: '2024-01-01T00:00:00Z' }), // outside the window
    ], '2025-11-13');
    expect(r).toEqual({ won: 1, lost: 2, noBid: 1, wonValue: '3000000.00', byCount: '33.3', byValue: '50.0' });
  });
  it('has no rate before anything is decided', () => {
    expect(winRate([], '2025-01-01')).toMatchObject({ byCount: null, byValue: null });
  });
});

describe('tender deadlines', () => {
  const now = new Date('2026-11-13T08:00:00Z');
  it('lists briefings and closings in the window, flags a missed closing, ignores submitted tenders', () => {
    const d = deadlines([
      opp({ id: 'a', stage: 'tendering', briefingOn: '2026-11-14T10:00:00Z', closingAt: '2026-11-20T12:00:00Z' }),
      opp({ id: 'b', stage: 'tendering', closingAt: '2026-11-12T12:00:00Z' }),
      opp({ id: 'c', stage: 'submitted', closingAt: '2026-11-15T12:00:00Z' }),
      opp({ id: 'd', stage: 'qualifying', closingAt: '2027-01-30T12:00:00Z' }),
      opp({ id: 'e', stage: 'qualifying', briefingOn: '2026-11-01T10:00:00Z' }),
    ], now, 14);
    expect(d.map((x) => [x.opportunity.id, x.kind, x.missed, x.hoursLeft])).toEqual([
      ['b', 'closing', true, -20],
      ['a', 'briefing', false, 26],
      ['a', 'closing', false, 172],
    ]);
  });
});
