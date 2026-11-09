import { useState, type ReactNode } from 'react';
import { BarChart3, Table2 } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart } from 'recharts';
import { Card, CardHeader, cx } from './ui';

// ---------------------------------------------------------------------------
// ChartCard: every chart ships with a table-view twin (accessible equivalent).
// ---------------------------------------------------------------------------
export interface TableView {
  columns: string[];
  rows: (string | number)[][];
}

export function ChartCard({
  title,
  subtitle,
  actions,
  table,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  table: TableView;
  children: ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className={cx('flex flex-col', className)}>
      <CardHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            {actions}
            <div className="flex rounded-lg border border-line p-0.5">
              {[
                [false, BarChart3, 'Chart view'],
                [true, Table2, 'Table view'],
              ].map(([val, Icon, lbl]) => (
                <button
                  key={String(val)}
                  onClick={() => setAsTable(val as boolean)}
                  aria-label={lbl as string}
                  aria-pressed={asTable === val}
                  className={cx('rounded-md p-1', asTable === val ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2')}
                >
                  {(() => {
                    const I = Icon as typeof BarChart3;
                    return <I className="size-3.5" />;
                  })()}
                </button>
              ))}
            </div>
          </>
        }
      />
      <div className="mt-4 flex-1">
        {asTable ? (
          <div className="max-h-72 overflow-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  {table.columns.map((c, i) => (
                    <th key={c} className={cx('px-3 py-2 text-xs font-medium text-ink-3', i > 0 ? 'text-right' : 'text-left')}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, ri) => (
                  <tr key={ri} className="border-t border-line">
                    {r.map((cell, ci) => (
                      <td key={ci} className={cx('px-3 py-1.5 text-ink', ci > 0 && 'num text-right')}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Legend: always present for >= 2 series; text stays in ink, swatch carries identity.
// ---------------------------------------------------------------------------
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded-full" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

function TooltipBox({ title, rows }: { title: string; rows: { label: string; value: string; color: string }[] }) {
  return (
    <div className="min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 py-0.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: r.color }} />
          <span className="text-ink-2">{r.label}</span>
          <span className="num ml-auto pl-3 font-medium text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

const AXIS = { stroke: 'var(--axis)', fontSize: 11, tickLine: false, axisLine: false, tick: { fill: 'var(--text-3)' } } as const;

// ---------------------------------------------------------------------------
// Multi-series line chart on ONE axis, crosshair + tooltip, endpoint labels.
// ---------------------------------------------------------------------------
export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

export function TrendChart<T extends Record<string, string | number>>({
  data,
  xKey,
  series,
  format,
  height = 260,
}: {
  data: T[];
  xKey: keyof T & string;
  series: SeriesDef[];
  format: (v: number) => string;
  height?: number;
}) {
  const last = data[data.length - 1];
  // Endpoint labels: when two series finish close together, push their labels
  // apart vertically so they never overlap (higher value up, lower value down).
  const offsets: Record<string, number> = {};
  if (last) {
    const max = Math.max(...data.flatMap((d) => series.map((s) => Number(d[s.key]))), 1);
    const ranked = [...series].sort((a, b) => Number(last[b.key]) - Number(last[a.key]));
    ranked.forEach((s, i) => {
      const prev = ranked[i - 1];
      const close = prev && Math.abs(Number(last[prev.key]) - Number(last[s.key])) / max < 0.06;
      offsets[s.key] = close ? (offsets[prev.key] ?? -6) + 13 : i === 0 ? -6 : 0;
    });
    if (ranked.length > 1 && !Object.values(offsets).some((o) => o > 0)) ranked.forEach((s) => (offsets[s.key] = 0));
  }
  return (
    <div>
      {series.length > 1 && <Legend items={series} />}
      <div style={{ height }} className="mt-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 64, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey={xKey as string} {...AXIS} dy={6} />
            <YAxis {...AXIS} width={64} tickFormatter={(v: number) => format(v)} />
            <Tooltip
              cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TooltipBox
                    title={String(label)}
                    rows={series.map((s) => ({
                      label: s.label,
                      color: s.color,
                      value: format(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0)),
                    }))}
                  />
                ) : null
              }
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4.5, strokeWidth: 2, stroke: 'var(--chart-surface)', fill: s.color }}
                isAnimationActive={false}
                label={({ index, x, y }: { index?: number; x?: number | string; y?: number | string }) =>
                  index === data.length - 1 && last ? (
                    <text x={Number(x) + 8} y={Number(y) + 4 + (offsets[s.key] ?? 0)} fontSize={11} fill="var(--text-2)" fontWeight={500}>
                      {format(Number(last[s.key]))}
                    </text>
                  ) : (
                    <g />
                  )
                }
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-series sparkline for KPI tiles (series slot 1; the tile title names it).
// ---------------------------------------------------------------------------
export function Sparkline({ data, color = 'var(--series-1)', label }: { data: number[]; color?: string; label: string }) {
  const points = data.map((v, i) => ({ i, v }));
  return (
    <div className="mt-3 h-10" role="img" aria-label={`${label} trend: ${data.join(', ')}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`spark-${label.replace(/\W/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={`url(#spark-${label.replace(/\W/g, '')})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars (HTML). One series = one colour; ordered categories may pass
// an ordinal ramp. Value labels sit outside the bar end; hover shows a tooltip.
// ---------------------------------------------------------------------------
export function BarList({
  rows,
  format,
  colorFor,
}: {
  rows: { label: string; value: number; note?: string }[];
  format: (v: number) => string;
  colorFor?: (index: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="space-y-2.5">
      {rows.map((r, i) => (
        <div key={r.label} className="group" title={`${r.label}: ${format(r.value)}${r.note ? ` · ${r.note}` : ''}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate text-ink-2">{r.label}</span>
            <span className="num shrink-0 font-medium text-ink">{format(r.value)}</span>
          </div>
          <div className="h-2 rounded-full bg-surface-3">
            <div
              className="h-full rounded-full transition-opacity group-hover:opacity-80"
              style={{ width: `${(r.value / max) * 100}%`, background: colorFor ? colorFor(i) : 'var(--series-1)' }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Ordinal blue ramp for ordered tiers (e.g. B-BBEE level 1 → 5+). */
export const ORDINAL = ['var(--ord-5)', 'var(--ord-4)', 'var(--ord-3)', 'var(--ord-2)', 'var(--ord-1)'];
