const zarFull = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 });
const zarCents = new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' });
const plain = new Intl.NumberFormat('en-ZA');

/** Display only. Money stays a decimal string everywhere else; never do arithmetic on these. */
export function zar(v: string | number | null | undefined, cents = false) {
  if (v === null || v === undefined || v === '') return '—';
  return (cents ? zarCents : zarFull).format(Number(v));
}

/** R 312.0m, R 41.2m, R 950k */
export function zarCompact(v: string | number | null | undefined) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `R ${(n / 1e9).toFixed(2)}bn`;
  if (abs >= 1e6) return `R ${(n / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `R ${(n / 1e3).toFixed(0)}k`;
  return `R ${n.toFixed(0)}`;
}

export const num = (v: number) => plain.format(v);

export const pct = (v: number, digits = 1) => `${v.toFixed(digits)}%`;

export function date(v: string | Date) {
  return new Date(v).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function dateTime(v: string | Date) {
  return new Date(v).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relative(v: string | Date) {
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return date(v);
}

export const label = (s: string) => s.replace(/_/g, ' ');

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
