import { Decimal } from '@constructos/dsl-parser';
import type { InspectionItem } from '@constructos/db';

/** Plant, HSE and quality calculations. Pure; money as fixed-2 strings. */

const DAY = 86_400_000;
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// ----------------------------------------------------------------- plant

export const plantCharge = (quantity: string, rate: string) => new Decimal(quantity).times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export type DueStatus = 'ok' | 'due_soon' | 'overdue';

/**
 * When the next service falls due, by meter and/or calendar, whichever comes
 * first. "Due soon" = within 10% of the meter interval or 14 days.
 */
export function maintenanceDue(
  plan: { intervalMeter: string | null; intervalDays: number | null; lastDoneOn: string | null; lastDoneMeter: string | null },
  currentMeter: string,
  today: string,
): { status: DueStatus; nextDueOn: string | null; nextDueMeter: string | null; daysRemaining: number | null; meterRemaining: string | null } {
  let status: DueStatus = 'ok';
  const worse = (s: DueStatus) => {
    if (s === 'overdue' || (s === 'due_soon' && status === 'ok')) status = s;
  };
  let nextDueMeter: string | null = null;
  let meterRemaining: string | null = null;
  if (plan.intervalMeter) {
    const next = new Decimal(plan.lastDoneMeter ?? 0).plus(plan.intervalMeter);
    const left = next.minus(currentMeter);
    nextDueMeter = next.toFixed(1);
    meterRemaining = left.toFixed(1);
    if (left.lessThanOrEqualTo(0)) worse('overdue');
    else if (left.lessThanOrEqualTo(new Decimal(plan.intervalMeter).times('0.1'))) worse('due_soon');
  }
  let nextDueOn: string | null = null;
  let daysRemaining: number | null = null;
  if (plan.intervalDays) {
    // Never serviced: count from today, so a new plan is not instantly overdue.
    nextDueOn = addDays(plan.lastDoneOn ?? today, plan.intervalDays);
    daysRemaining = days(today, nextDueOn);
    if (daysRemaining < 0) worse('overdue');
    else if (daysRemaining <= 14) worse('due_soon');
  }
  return { status, nextDueOn, nextDueMeter, daysRemaining, meterRemaining };
}

export type ComplianceKind = 'licence' | 'roadworthy' | 'load_test' | 'calibration';

/** Expired, or expiring within 30 days, statutory documents on an asset. */
export function complianceIssues(
  a: { licenceExpiry: string | null; roadworthyExpiry: string | null; loadTestExpiry: string | null; calibrationExpiry: string | null },
  today: string,
) {
  const docs: [ComplianceKind, string | null][] = [
    ['licence', a.licenceExpiry],
    ['roadworthy', a.roadworthyExpiry],
    ['load_test', a.loadTestExpiry],
    ['calibration', a.calibrationExpiry],
  ];
  return docs
    .filter((x): x is [ComplianceKind, string] => Boolean(x[1]))
    .map(([kind, expiry]) => ({ kind, expiry, daysLeft: days(today, expiry) }))
    .filter((x) => x.daysLeft <= 30)
    .map((x) => ({ ...x, status: (x.daysLeft < 0 ? 'expired' : 'expiring') as 'expired' | 'expiring' }));
}

/** Share of days in the window on which the asset was charged to a project. */
export function utilisation(usageDates: string[], from: string, to: string): string | null {
  const span = days(from, to) + 1;
  if (span <= 0) return null;
  const used = new Set(usageDates.filter((d) => d >= from && d <= to)).size;
  return ((used / span) * 100).toFixed(1);
}

// ----------------------------------------------------------------- HSE

export type Severity = 'none' | 'first_aid' | 'medical_treatment' | 'restricted_work' | 'lost_time' | 'fatality';

/**
 * Statutory reporting flags (South Africa):
 *  - OHSA section 24 (report to the Department of Employment and Labour): a
 *    death, an injury keeping someone off work for more than 14 days, or a
 *    dangerous occurrence (major incident with potential for serious harm).
 *  - COIDA (W.Cl.2 to the Compensation Fund): any employee injury needing
 *    medical treatment or worse.
 * These are prompts for the HSE officer, who confirms each report.
 */
export function reportability(type: string, severity: Severity, daysLost: number) {
  const dol = severity === 'fatality' || (severity === 'lost_time' && daysLost > 14) || type === 'dangerous_occurrence';
  const coida = ['medical_treatment', 'restricted_work', 'lost_time', 'fatality'].includes(severity);
  return { dolReportable: dol, coidaReportable: coida };
}

const LTI: Severity[] = ['lost_time', 'fatality'];
const RECORDABLE: Severity[] = ['medical_treatment', 'restricted_work', 'lost_time', 'fatality'];

/** LTIFR and TRIFR per 1 000 000 hours worked, plus the usual counts. */
export function safetyKpis(
  incidents: { type: string; severity: Severity; daysLost: number; occurredAt: string }[],
  manHours: number,
  today: string,
) {
  const lti = incidents.filter((i) => LTI.includes(i.severity));
  const recordable = incidents.filter((i) => RECORDABLE.includes(i.severity));
  const rate = (n: number) => (manHours > 0 ? ((n * 1_000_000) / manHours).toFixed(2) : null);
  const lastLti = lti.map((i) => i.occurredAt.slice(0, 10)).sort().pop() ?? null;
  return {
    manHours: Math.round(manHours),
    incidents: incidents.length,
    nearMisses: incidents.filter((i) => i.type === 'near_miss').length,
    firstAid: incidents.filter((i) => i.severity === 'first_aid').length,
    recordable: recordable.length,
    lostTimeInjuries: lti.length,
    fatalities: incidents.filter((i) => i.severity === 'fatality').length,
    daysLost: incidents.reduce((s, i) => s + i.daysLost, 0),
    ltifr: rate(lti.length),
    trifr: rate(recordable.length),
    daysSinceLastLti: lastLti ? days(lastLti, today) : null,
  };
}

/** Man-hours from site-diary headcounts × hours per shift. */
export const manHoursFromDiary = (headcounts: (number | null)[], hoursPerShift: string) =>
  headcounts.reduce<number>((s, h) => s + (h ?? 0), 0) * Number(hoursPerShift);

// ----------------------------------------------------------------- quality

export function inspectionOutcome(items: InspectionItem[]) {
  const failed = items.filter((i) => i.result === 'fail').length;
  return { failedItems: failed, passed: failed === 0, applicable: items.filter((i) => i.result !== 'na').length };
}

export function isOverdue(dueOn: string | null, status: string, today: string) {
  return Boolean(dueOn && status !== 'closed' && status !== 'done' && dueOn < today);
}
