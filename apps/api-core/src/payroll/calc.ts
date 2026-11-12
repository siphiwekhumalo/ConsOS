import { Decimal } from '@constructos/dsl-parser';
import type { PayslipEarning, TaxTable } from '@constructos/db';

/**
 * South African payroll arithmetic. Pure and decimal-only.
 *
 * PAYE: SARS's annualisation method for a regular monthly payroll. The month's
 * taxable remuneration is annualised (× 12), taxed on the year's brackets less
 * age-based rebates, divided by 12, then reduced by the monthly medical scheme
 * fees tax credit. Not included (by design, see docs): ETI, retirement-fund
 * deductions, fringe benefits, irregular income (bonuses), directors.
 */

type D = InstanceType<typeof Decimal>;
const d = (v: string | number | null | undefined) => new Decimal(v ?? 0);
const money = (v: D) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const s = (v: D) => money(v).toFixed(2);
const ZERO = new Decimal(0);

// ----------------------------------------------------------------- dates

/** SARS tax year containing a date: 1 March to the end of February ("2025/26"). */
export function taxYearFor(date: string): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const start = m >= 3 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Age in whole years on a date. */
export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, dd] = on.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && dd < bd) ? 1 : 0);
}

export function monthBounds(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}`, days: last };
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ----------------------------------------------------------------- tax

type Table = Pick<TaxTable, 'brackets' | 'primaryRebate' | 'secondaryRebate' | 'tertiaryRebate' | 'uifCeilingMonthly' | 'medicalCreditMain' | 'medicalCreditFirstDep' | 'medicalCreditAdditional' | 'endsOn'>;

/** Annual income tax on annual taxable income, after rebates for the person's age at the end of the tax year. */
export function annualTax(annualTaxable: string, table: Table, ageAtYearEnd: number): string {
  const income = d(annualTaxable);
  if (!income.greaterThan(0)) return '0.00';
  const bracket = [...table.brackets].sort((a, b) => b.from - a.from).find((b) => income.greaterThanOrEqualTo(b.from))!;
  // Brackets are published as "base + rate% of income above (from − 1)".
  const threshold = bracket.from === 0 ? ZERO : d(bracket.from - 1);
  let tax = d(bracket.base).plus(income.minus(threshold).times(bracket.rate).dividedBy(100));
  let rebates = d(table.primaryRebate);
  if (ageAtYearEnd >= 65) rebates = rebates.plus(table.secondaryRebate);
  if (ageAtYearEnd >= 75) rebates = rebates.plus(table.tertiaryRebate);
  tax = tax.minus(rebates);
  return s(tax.isNegative() ? ZERO : tax);
}

/** Monthly medical scheme fees tax credit for the number of members (main member + dependants). */
export function medicalCredit(members: number, table: Table): string {
  if (members <= 0) return '0.00';
  let c = d(table.medicalCreditMain);
  if (members >= 2) c = c.plus(table.medicalCreditFirstDep);
  if (members >= 3) c = c.plus(d(table.medicalCreditAdditional).times(members - 2));
  return s(c);
}

export function monthlyPaye(monthlyTaxable: string, table: Table, ageAtYearEnd: number, medicalMembers: number): string {
  const annual = d(annualTax(d(monthlyTaxable).times(12).toFixed(2), table, ageAtYearEnd));
  const paye = annual.dividedBy(12).minus(d(medicalCredit(medicalMembers, table)));
  return s(paye.isNegative() ? ZERO : paye);
}

export const uifContribution = (gross: string, ceiling: string) => s(Decimal.min(d(gross), d(ceiling)).times('0.01'));
export const sdlContribution = (gross: string, liable: boolean) => (liable ? s(d(gross).times('0.01')) : '0.00');

// ----------------------------------------------------------------- payslip

export interface PayslipInput {
  employee: { payBasis: 'monthly' | 'hourly'; rate: string; startDate: string; endDate: string | null; medicalAidMembers: number };
  dateOfBirth: string;
  period: string;
  hours: { normal: string; overtime: string; sunday: string };
  unpaidLeaveDays: string;
  monthlyHours: string;
  sdlLiable: boolean;
  table: Table;
}

export interface PayslipFigures {
  earnings: PayslipEarning[];
  gross: string;
  paye: string;
  uifEmployee: string;
  otherDeductions: string;
  net: string;
  uifEmployer: string;
  sdl: string;
  employerCost: string;
  hoursWorked: string;
}

const line = (code: string, label: string, quantity: D | string, rate: D | string, amount: D): PayslipEarning => ({
  code,
  label,
  quantity: d(quantity as string).toFixed(2),
  rate: s(d(rate as string)),
  amount: s(amount),
});

export function payslip(i: PayslipInput): PayslipFigures {
  const { employee: e } = i;
  const { from, to, days } = monthBounds(i.period);
  const earnings: PayslipEarning[] = [];
  const hourly = e.payBasis === 'hourly' ? d(e.rate) : d(e.rate).dividedBy(i.monthlyHours);

  if (e.payBasis === 'monthly') {
    // Pro-rata by calendar days when employment starts or ends inside the month.
    const start = e.startDate > from ? e.startDate : from;
    const end = e.endDate && e.endDate < to ? e.endDate : to;
    const employedDays = Math.max(0, dayDiff(start, end) + 1);
    const basic = employedDays >= days ? d(e.rate) : d(e.rate).times(employedDays).dividedBy(days);
    earnings.push(line('basic', employedDays >= days ? 'Basic salary' : `Basic salary (${employedDays} of ${days} days)`, employedDays >= days ? '1' : String(employedDays), employedDays >= days ? e.rate : d(e.rate).dividedBy(days), basic));
    if (d(i.unpaidLeaveDays).greaterThan(0)) {
      // Daily rate on a 5-day week: monthly × 12 / 260.
      const daily = d(e.rate).times(12).dividedBy(260);
      earnings.push(line('unpaid_leave', 'Unpaid leave', i.unpaidLeaveDays, daily.negated(), daily.times(i.unpaidLeaveDays).negated()));
    }
  } else if (d(i.hours.normal).greaterThan(0)) {
    earnings.push(line('normal', 'Normal time', i.hours.normal, hourly, hourly.times(i.hours.normal)));
  }
  if (d(i.hours.overtime).greaterThan(0)) {
    const r = hourly.times('1.5');
    earnings.push(line('overtime', 'Overtime (× 1.5)', i.hours.overtime, r, r.times(i.hours.overtime)));
  }
  if (d(i.hours.sunday).greaterThan(0)) {
    const r = hourly.times(2);
    earnings.push(line('sunday', 'Sunday / public holiday (× 2)', i.hours.sunday, r, r.times(i.hours.sunday)));
  }

  let gross = earnings.reduce((acc, l) => acc.plus(l.amount), ZERO);
  if (gross.isNegative()) gross = ZERO;
  const grossS = s(gross);
  const age = ageOn(i.dateOfBirth, i.table.endsOn);
  const paye = monthlyPaye(grossS, i.table, age, e.medicalAidMembers);
  const uif = uifContribution(grossS, i.table.uifCeilingMonthly);
  const sdl = sdlContribution(grossS, i.sdlLiable);
  const net = gross.minus(paye).minus(uif);
  return {
    earnings,
    gross: grossS,
    paye,
    uifEmployee: uif,
    otherDeductions: '0.00',
    net: s(net),
    uifEmployer: uif,
    sdl,
    employerCost: s(gross.plus(uif).plus(sdl)),
    hoursWorked: d(i.hours.normal).plus(i.hours.overtime).plus(i.hours.sunday).toFixed(2),
  };
}

// ----------------------------------------------------------------- labour cost allocation

/**
 * Split an employee's cost across project cost codes in proportion to approved
 * hours. Rounding differences go to the largest share, so the parts always add
 * up to the total. Returns [] when there are no hours (the cost is overhead).
 */
export function allocate(total: string, shares: { key: string; hours: string }[]): { key: string; amount: string }[] {
  const hours = shares.reduce((a, x) => a.plus(x.hours), ZERO);
  if (!hours.greaterThan(0) || !d(total).greaterThan(0)) return [];
  const parts = shares.map((x) => ({ key: x.key, amount: money(d(total).times(x.hours).dividedBy(hours)), hours: d(x.hours) }));
  const diff = d(total).minus(parts.reduce((a, x) => a.plus(x.amount), ZERO));
  if (!diff.isZero()) {
    const largest = parts.reduce((a, b) => (b.hours.greaterThan(a.hours) ? b : a));
    largest.amount = largest.amount.plus(diff);
  }
  return parts.filter((p) => !p.amount.isZero()).map((p) => ({ key: p.key, amount: p.amount.toFixed(2) }));
}

// ----------------------------------------------------------------- leave (BCEA)

export interface LeaveBalance {
  kind: 'annual' | 'sick' | 'family_responsibility';
  cycleStart: string;
  entitlement: string;
  taken: string;
  balance: string;
}

/**
 * Basic Conditions of Employment Act minimums for a 5-day week:
 *  - annual: 15 working days per 12-month cycle, accruing 1.25 days per completed month;
 *  - sick: 30 days per 36-month cycle (the first-six-months rule of 1 day per
 *    26 worked is not modelled; the full 30 shows from the start);
 *  - family responsibility: 3 days per 12-month cycle, after 4 months' service.
 * Cycles run from the employment start date.
 */
export function leaveBalances(startDate: string, today: string, approved: { kind: string; startsOn: string; days: string }[]): LeaveBalance[] {
  const months = (a: string, b: string) => {
    const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
    const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
    return (by - ay) * 12 + (bm - am) - (bd < ad ? 1 : 0);
  };
  const addMonths = (a: string, n: number) => {
    const [y, m, dd] = a.split('-').map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(y, m - 1 + n, dd));
    return dt.toISOString().slice(0, 10);
  };
  const served = Math.max(0, months(startDate, today));
  const cycle = (len: number) => addMonths(startDate, Math.floor(served / len) * len);
  const taken = (kind: string, from: string) =>
    approved.filter((l) => l.kind === kind && l.startsOn >= from && l.startsOn <= today).reduce((a, l) => a.plus(l.days), ZERO);

  const annualStart = cycle(12);
  const annualEntitled = Decimal.min(d(months(annualStart, today)).times('1.25'), d(15));
  const sickStart = cycle(36);
  const familyStart = annualStart;
  const familyEntitled = served >= 4 ? d(3) : ZERO;
  const row = (kind: LeaveBalance['kind'], start: string, ent: D): LeaveBalance => {
    const t = taken(kind, start);
    return { kind, cycleStart: start, entitlement: ent.toFixed(1), taken: t.toFixed(1), balance: ent.minus(t).toFixed(1) };
  };
  return [row('annual', annualStart, annualEntitled), row('sick', sickStart, d(30)), row('family_responsibility', familyStart, familyEntitled)];
}

/** Working days (Mon–Fri) between two dates inclusive. Public holidays are not excluded. */
export function workingDays(from: string, to: string): number {
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}
