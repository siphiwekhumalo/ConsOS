import { describe, expect, it } from 'vitest';
import {
  complianceIssues,
  inspectionOutcome,
  isOverdue,
  maintenanceDue,
  manHoursFromDiary,
  plantCharge,
  reportability,
  safetyKpis,
  utilisation,
} from '../src/operations/calc';

const today = '2026-11-12';

describe('maintenance due', () => {
  it('by meter: ok, due soon (within 10%), overdue', () => {
    const plan = { intervalMeter: '250.0', intervalDays: null, lastDoneOn: null, lastDoneMeter: '1000.0' };
    expect(maintenanceDue(plan, '1100.0', today)).toMatchObject({ status: 'ok', nextDueMeter: '1250.0', meterRemaining: '150.0' });
    expect(maintenanceDue(plan, '1230.0', today).status).toBe('due_soon');
    expect(maintenanceDue(plan, '1251.5', today)).toMatchObject({ status: 'overdue', meterRemaining: '-1.5' });
  });

  it('by calendar, and whichever comes first when both apply', () => {
    const cal = { intervalMeter: null, intervalDays: 90, lastDoneOn: '2026-08-01', lastDoneMeter: null };
    expect(maintenanceDue(cal, '0', today)).toMatchObject({ status: 'overdue', nextDueOn: '2026-10-30', daysRemaining: -13 });
    const both = { intervalMeter: '500.0', intervalDays: 365, lastDoneOn: '2026-06-01', lastDoneMeter: '0' };
    expect(maintenanceDue(both, '520.0', today).status).toBe('overdue'); // meter overdue, calendar fine
  });

  it('does not flag a brand-new calendar plan as overdue', () => {
    expect(maintenanceDue({ intervalMeter: null, intervalDays: 30, lastDoneOn: null, lastDoneMeter: null }, '0', today)).toMatchObject({ status: 'ok', daysRemaining: 30 });
  });
});

describe('plant', () => {
  it('charges quantity × rate, rounded half up', () => {
    expect(plantCharge('1', '4500.00')).toBe('4500.00');
    expect(plantCharge('7.5', '650.33')).toBe('4877.48'); // 4877.475
  });

  it('flags expired and soon-expiring documents only', () => {
    expect(complianceIssues({ licenceExpiry: '2026-11-01', roadworthyExpiry: '2026-12-01', loadTestExpiry: '2027-06-01', calibrationExpiry: null }, today)).toEqual([
      { kind: 'licence', expiry: '2026-11-01', daysLeft: -11, status: 'expired' },
      { kind: 'roadworthy', expiry: '2026-12-01', daysLeft: 19, status: 'expiring' },
    ]);
  });

  it('measures utilisation as days used over the window', () => {
    expect(utilisation(['2026-11-01', '2026-11-01', '2026-11-02', '2026-10-01'], '2026-11-01', '2026-11-10')).toBe('20.0');
  });
});

describe('HSE', () => {
  it('flags OHSA s24 and COIDA reportability', () => {
    expect(reportability('injury', 'first_aid', 0)).toEqual({ dolReportable: false, coidaReportable: false });
    expect(reportability('injury', 'medical_treatment', 0)).toEqual({ dolReportable: false, coidaReportable: true });
    expect(reportability('injury', 'lost_time', 10)).toEqual({ dolReportable: false, coidaReportable: true });
    expect(reportability('injury', 'lost_time', 15)).toEqual({ dolReportable: true, coidaReportable: true });
    expect(reportability('injury', 'fatality', 0)).toEqual({ dolReportable: true, coidaReportable: true });
    expect(reportability('dangerous_occurrence', 'none', 0)).toEqual({ dolReportable: true, coidaReportable: false });
  });

  it('computes LTIFR and TRIFR per million hours', () => {
    const k = safetyKpis([
      { type: 'injury', severity: 'lost_time', daysLost: 5, occurredAt: '2026-09-10T08:00:00Z' },
      { type: 'injury', severity: 'medical_treatment', daysLost: 0, occurredAt: '2026-10-10T08:00:00Z' },
      { type: 'near_miss', severity: 'none', daysLost: 0, occurredAt: '2026-10-11T08:00:00Z' },
      { type: 'injury', severity: 'first_aid', daysLost: 0, occurredAt: '2026-10-12T08:00:00Z' },
    ], 400_000, today);
    expect(k).toMatchObject({ lostTimeInjuries: 1, recordable: 2, nearMisses: 1, firstAid: 1, daysLost: 5, ltifr: '2.50', trifr: '5.00', daysSinceLastLti: 63 });
  });

  it('returns no rate without hours worked', () => {
    expect(safetyKpis([], 0, today)).toMatchObject({ ltifr: null, trifr: null, daysSinceLastLti: null });
  });

  it('converts diary headcounts into man-hours', () => {
    expect(manHoursFromDiary([40, null, 35], '9')).toBe(675);
  });
});

describe('quality', () => {
  it('fails an inspection with any failed item; N/A does not count', () => {
    expect(inspectionOutcome([{ item: 'a', result: 'pass' }, { item: 'b', result: 'na' }])).toEqual({ failedItems: 0, passed: true, applicable: 1 });
    expect(inspectionOutcome([{ item: 'a', result: 'pass' }, { item: 'b', result: 'fail' }])).toMatchObject({ failedItems: 1, passed: false });
  });

  it('only open items can be overdue', () => {
    expect(isOverdue('2026-11-01', 'open', today)).toBe(true);
    expect(isOverdue('2026-11-01', 'closed', today)).toBe(false);
    expect(isOverdue('2026-11-12', 'open', today)).toBe(false);
    expect(isOverdue(null, 'open', today)).toBe(false);
  });
});
