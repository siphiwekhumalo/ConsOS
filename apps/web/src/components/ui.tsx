import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, OctagonAlert, Sparkles, X, type LucideIcon } from 'lucide-react';
import { initials } from '../lib/format';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// --------------------------------------------------------------------------- Buttons

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
const BUTTON: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white shadow-card hover:bg-brand-hover',
  secondary: 'bg-surface text-ink ring-1 ring-inset ring-line-strong shadow-card hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-3 hover:text-ink',
  danger: 'bg-critical text-white hover:opacity-90',
};

export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  loading,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-2.5 text-[13px]' : 'h-9 px-3.5 text-sm',
        BUTTON[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : Icon && <Icon className="size-4" strokeWidth={2} />}
      {children}
    </button>
  );
}

// --------------------------------------------------------------------------- Badges & status

type Tone = 'neutral' | 'brand' | 'good' | 'warning' | 'serious' | 'critical';
const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-ink-2 ring-line',
  brand: 'bg-brand-soft text-brand-ink ring-brand/20',
  good: 'bg-good-soft text-good-ink ring-good/25',
  warning: 'bg-warning-soft text-warning-ink ring-warning/30',
  serious: 'bg-serious-soft text-serious-ink ring-serious/30',
  critical: 'bg-critical-soft text-critical-ink ring-critical/25',
};

export function Badge({ tone = 'neutral', dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', TONE[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS_ICON = { good: CheckCircle2, warning: AlertTriangle, serious: AlertTriangle, critical: OctagonAlert } as const;

/** Status always carries icon + label, never colour alone. */
export function StatusPill({ status, children }: { status: keyof typeof STATUS_ICON; children: ReactNode }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={status}>
      <Icon className="size-3.5" strokeWidth={2.25} />
      {children}
    </Badge>
  );
}

// --------------------------------------------------------------------------- Surfaces

export function Card({ children, className, padded = true }: { children: ReactNode; className?: string; padded?: boolean }) {
  return <div className={cx('rounded-xl border border-line bg-surface shadow-card', padded && 'p-5', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5">{eyebrow}</div>}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** KPI tile: proportional figures for the hero value (no tabular-nums). */
export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  delta,
  children,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  delta?: { value: string; good: boolean };
  children?: ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-ink-2">{label}</span>
        {Icon && (
          <span className="grid size-7 place-items-center rounded-md bg-surface-3 text-ink-2">
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
        )}
      </div>
      <div className="mt-3 text-[26px] font-semibold leading-none tracking-tight text-ink">{value}</div>
      <div className="mt-2 flex items-center gap-2 text-xs text-ink-3">
        {delta && (
          <span className={cx('font-medium', delta.good ? 'text-good-ink' : 'text-critical-ink')}>{delta.value}</span>
        )}
        {hint}
      </div>
      {children}
    </Card>
  );
}

// --------------------------------------------------------------------------- Tables

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}
export const Th = ({ children, right, className }: { children?: ReactNode; right?: boolean; className?: string }) => (
  <th
    className={cx(
      'whitespace-nowrap border-b border-line bg-surface-2 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-3 first:pl-5 last:pr-5',
      right && 'text-right',
      className,
    )}
  >
    {children}
  </th>
);
export const Td = ({ children, right, className, mono }: { children?: ReactNode; right?: boolean; className?: string; mono?: boolean }) => (
  <td className={cx('border-b border-line px-4 py-3 text-ink first:pl-5 last:pr-5', right && 'num whitespace-nowrap text-right', mono && 'whitespace-nowrap font-mono text-[13px]', className)}>
    {children}
  </td>
);
export const Tr = ({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) => (
  <tr onClick={onClick} className={cx('transition-colors last:[&>td]:border-b-0 hover:bg-surface-2', onClick && 'cursor-pointer', className)}>
    {children}
  </tr>
);

// --------------------------------------------------------------------------- Forms

const FIELD_BASE =
  'block rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 shadow-card transition focus:border-brand focus:outline-none focus:ring-4 focus:ring-[var(--ring)]';
/** Full width unless the caller sets its own width (avoids w-full vs w-* conflicts). */
const field = (className?: string) => cx(FIELD_BASE, !/(^|\s)(w-|min-w-|max-w-)/.test(className ?? '') && 'w-full', className);

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(field(p.className), 'h-9')} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(field(p.className), 'h-9 pr-8')} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={field(p.className)} />;

// --------------------------------------------------------------------------- Feedback

export function Alert({ tone = 'critical', title, children }: { tone?: 'critical' | 'warning' | 'good' | 'info'; title?: string; children: ReactNode }) {
  const styles = {
    critical: ['bg-critical-soft text-critical-ink', OctagonAlert],
    warning: ['bg-warning-soft text-warning-ink', AlertTriangle],
    good: ['bg-good-soft text-good-ink', CheckCircle2],
    info: ['bg-info-soft text-info-ink', Info],
  } as const;
  const [cls, Icon] = styles[tone];
  return (
    <div className={cx('flex gap-2.5 rounded-lg px-3.5 py-3 text-sm', cls)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div>
        {title && <div className="font-medium">{title}</div>}
        <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <span className="grid size-11 place-items-center rounded-xl bg-surface-3 text-ink-3">
        <Icon className="size-5" />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-ink">{title}</h3>
      {children && <p className="mt-1 max-w-sm text-sm text-ink-2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-surface-3', className)} />;
}

/** Marks every screen that shows sample data, so it can never be mistaken for real records. */
export function PreviewBanner({ module }: { module: string }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-dashed border-brand/40 bg-brand-soft px-4 py-3 text-sm text-brand-ink">
      <Sparkles className="mt-0.5 size-4 shrink-0" />
      <div>
        <span className="font-semibold">Design preview · sample data.</span> The {module} backend is not built yet. Figures on this
        page are illustrative and are not your organisation's records.
      </div>
    </div>
  );
}

export function SampleChip() {
  return <span className="rounded-md border border-dashed border-line-strong px-1.5 py-0.5 text-[11px] font-medium text-ink-3">Sample data</span>;
}

// --------------------------------------------------------------------------- Misc

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cx(
        'grid shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand-ink ring-1 ring-brand/15',
        size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs',
      )}
    >
      {initials(name)}
    </span>
  );
}

export function Progress({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'good' | 'warning' | 'critical' }) {
  const bar = { brand: 'bg-brand', good: 'bg-good', warning: 'bg-warning', critical: 'bg-critical' }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={cx('h-full rounded-full', bar)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number; icon?: LucideIcon }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="mb-6 flex gap-6 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 pb-3 pt-1 text-sm font-medium transition-colors',
            value === t.id ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
          )}
        >
          {t.icon && <t.icon className="size-4" />}
          {t.label}
          {t.count !== undefined && (
            <span className="rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold text-ink-2">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[10vh]">
      <div className="fixed inset-0 bg-[var(--overlay)] backdrop-blur-[2px]" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cx('relative w-full rounded-2xl border border-line bg-surface shadow-pop', wide ? 'max-w-2xl' : 'max-w-lg')}
      >
        <div className="flex items-start justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-surface-3 hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');
