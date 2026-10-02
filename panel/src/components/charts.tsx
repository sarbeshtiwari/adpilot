import { useMemo, useState, type ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { useTheme } from '../lib/theme';
import { seriesColors, sequential } from '../lib/palette';
import { compact, dateShort, num, usd, usdCompact } from '../lib/format';
import { cx } from './ui';

/**
 * Chart shell: title, legend, and a table toggle. The table view is not
 * decoration — it is the accessibility relief for series whose fill sits below
 * 3:1 on the light surface, and the fallback for colour-vision differences.
 */
function ChartFrame({
  title, subtitle, legend, table, children, tall,
}: { title: string; subtitle?: string; legend?: ReactNode; table?: ReactNode; children: ReactNode; tall?: boolean }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div className="rounded-xl border border-hairline bg-panel p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-mute">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-3">
          {legend}
          {table && (
            <button onClick={() => setShowTable((s) => !s)}
              className="rounded-md border border-hairline px-2 py-1 text-2xs font-medium text-ink-mute hover:text-ink">
              {showTable ? 'Chart' : 'Table'}
            </button>
          )}
        </div>
      </div>
      {showTable && table ? (
        <div className="max-h-72 overflow-auto">{table}</div>
      ) : (
        <div className={tall ? 'h-72' : 'h-56'}>{children}</div>
      )}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {items.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1.5 text-2xs font-medium text-ink-soft">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} aria-hidden />
          {s.label}
        </span>
      ))}
    </div>
  );
}

type TipRow = { label: string; value: string; color?: string };

function TooltipCard({ heading, rows }: { heading: string; rows: TipRow[] }) {
  return (
    <div className="rounded-lg border border-hairline bg-panel px-3 py-2 text-xs shadow-pop">
      <p className="mb-1 font-semibold text-ink">{heading}</p>
      {rows.map((r) => (
        <p key={r.label} className="tnum flex items-center justify-between gap-4 text-ink-soft">
          <span className="inline-flex items-center gap-1.5">
            {r.color && <span className="h-2 w-2 rounded-[2px]" style={{ background: r.color }} aria-hidden />}
            {r.label}
          </span>
          <span className="font-medium text-ink">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

const axisStyle = { fontSize: 11, fill: 'rgb(var(--ink-mute))' };

export type SeriesPoint = {
  date: string; impressions: number; clicks: number;
  spendMicros: string; payoutMicros: string; platformMicros: string;
};

/** One metric, one scale. Never paired with a second axis. */
export function TrendChart({
  data, title, subtitle, metric, format = 'number', slot = 0, tall,
}: {
  data: SeriesPoint[]; title: string; subtitle?: string;
  metric: 'impressions' | 'clicks' | 'spendMicros' | 'payoutMicros' | 'platformMicros';
  format?: 'number' | 'money'; slot?: number; tall?: boolean;
}) {
  const { dark } = useTheme();
  const color = seriesColors(dark)[slot];
  const id = `grad-${metric}-${slot}`;

  const rows = useMemo(
    () => data.map((d) => ({ date: d.date, value: format === 'money' ? Number(d[metric]) / 1e6 : Number(d[metric]) })),
    [data, metric, format],
  );
  const fmt = (v: number) => (format === 'money' ? usd(v * 1e6) : num(v));
  const total = rows.reduce((a, b) => a + b.value, 0);

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle ?? `${fmt(total)} total`}
      tall={tall}
      table={
        <table className="w-full text-xs">
          <thead><tr className="text-left text-ink-mute"><th className="py-1 font-medium">Date</th><th className="py-1 text-right font-medium">{title}</th></tr></thead>
          <tbody className="tnum divide-y divide-hairline">
            {rows.map((r) => <tr key={r.date}><td className="py-1 text-ink-soft">{r.date}</td><td className="py-1 text-right text-ink">{fmt(r.value)}</td></tr>)}
          </tbody>
        </table>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={color} stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--hairline))" vertical={false} />
          <XAxis dataKey="date" tickFormatter={dateShort} tick={axisStyle} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={64}
            tickFormatter={(v: number) => (format === 'money' ? usdCompact(v * 1e6) : compact(v))} />
          <Tooltip
            cursor={{ stroke: 'rgb(var(--ink-mute))', strokeWidth: 1, strokeDasharray: '3 3' }}
            content={({ active, payload, label }) =>
              active && payload?.length
                ? <TooltipCard heading={new Date(String(label)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    rows={[{ label: title, value: fmt(Number(payload[0].value)), color }]} />
                : null}
          />
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${id})`}
            dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'rgb(var(--panel))' }} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Money split: payout + platform margin stack to total spend — one $ scale. */
export function RevenueSplitChart({ data, title = 'Where the money went', showPlatform = true }: {
  data: SeriesPoint[]; title?: string; showPlatform?: boolean;
}) {
  const { dark } = useTheme();
  const [c1, c2] = seriesColors(dark);
  const rows = useMemo(
    () => data.map((d) => ({
      date: d.date,
      payout: Number(d.payoutMicros) / 1e6,
      platform: Number(d.platformMicros) / 1e6,
    })),
    [data],
  );
  const series = showPlatform
    ? [{ key: 'payout', label: 'Paid to end users', color: c1 }, { key: 'platform', label: 'Platform margin', color: c2 }]
    : [{ key: 'payout', label: 'Your earnings', color: c1 }];

  return (
    <ChartFrame
      title={title}
      subtitle={`${usd(rows.reduce((a, b) => a + b.payout + (showPlatform ? b.platform : 0), 0) * 1e6)} over the period`}
      legend={<Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      tall
      table={
        <table className="w-full text-xs">
          <thead><tr className="text-left text-ink-mute">
            <th className="py-1 font-medium">Date</th>
            {series.map((s) => <th key={s.key} className="py-1 text-right font-medium">{s.label}</th>)}
          </tr></thead>
          <tbody className="tnum divide-y divide-hairline">
            {rows.map((r) => (
              <tr key={r.date}>
                <td className="py-1 text-ink-soft">{r.date}</td>
                {series.map((s) => <td key={s.key} className="py-1 text-right text-ink">{usd((r as never as Record<string, number>)[s.key] * 1e6)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--hairline))" vertical={false} />
          <XAxis dataKey="date" tickFormatter={dateShort} tick={axisStyle} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => usdCompact(v * 1e6)} />
          <Tooltip
            cursor={{ stroke: 'rgb(var(--ink-mute))', strokeWidth: 1, strokeDasharray: '3 3' }}
            content={({ active, payload, label }) =>
              active && payload?.length
                ? <TooltipCard
                    heading={new Date(String(label)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                    rows={[
                      ...payload.map((p) => ({
                        label: series.find((s) => s.key === p.dataKey)?.label ?? String(p.dataKey),
                        value: usd(Number(p.value) * 1e6),
                        color: String(p.color),
                      })),
                      { label: 'Total', value: usd(payload.reduce((a, p) => a + Number(p.value), 0) * 1e6) },
                    ]} />
                : null}
          />
          {series.map((s) => (
            // 2px surface-coloured stroke keeps a visible gap between stacked fills.
            <Area key={s.key} type="monotone" dataKey={s.key} stackId="money" stroke="rgb(var(--panel))"
              strokeWidth={2} fill={s.color} fillOpacity={0.85} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export type BarRow = { key: string; label: string; value: number; secondary?: string };

/** Ranked magnitude. Sequential one-hue ramp + a direct label on every row. */
export function BarList({ title, subtitle, rows, unit = 'impressions', take = 8 }: {
  title: string; subtitle?: string; rows: BarRow[]; unit?: string; take?: number;
}) {
  const { dark } = useTheme();
  const top = rows.slice(0, take);
  const max = Math.max(...top.map((r) => r.value), 1);

  if (top.length === 0) {
    return (
      <div className="rounded-xl border border-hairline bg-panel p-5 shadow-card">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <p className="py-10 text-center text-xs text-ink-mute">No delivery in this period</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-hairline bg-panel p-5 shadow-card">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-ink-mute">{subtitle}</p>}
      </div>
      <ul className="space-y-2.5">
        {top.map((r, i) => (
          <li key={r.key}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="truncate text-xs font-medium text-ink" title={r.label}>{r.label}</span>
              <span className="tnum shrink-0 text-xs text-ink-soft">
                {num(r.value)}
                {r.secondary && <span className="ml-1.5 text-ink-mute">{r.secondary}</span>}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface">
              <div className="h-full rounded-full transition-all"
                style={{ width: `${Math.max((r.value / max) * 100, 2)}%`, background: sequential(dark, 1 - i / Math.max(top.length - 1, 1)) }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-2xs text-ink-mute">Ranked by {unit}</p>
    </div>
  );
}

/** Vertical bars for a small categorical set (e.g. delivery by AI surface). */
export function CategoryBars({ title, subtitle, rows, valueLabel = 'Impressions' }: {
  title: string; subtitle?: string; rows: BarRow[]; valueLabel?: string;
}) {
  const { dark } = useTheme();
  const color = seriesColors(dark)[0];
  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      table={
        <table className="w-full text-xs">
          <thead><tr className="text-left text-ink-mute"><th className="py-1 font-medium">Surface</th><th className="py-1 text-right font-medium">{valueLabel}</th></tr></thead>
          <tbody className="tnum divide-y divide-hairline">
            {rows.map((r) => <tr key={r.key}><td className="py-1 text-ink-soft">{r.label}</td><td className="py-1 text-right text-ink">{num(r.value)}</td></tr>)}
          </tbody>
        </table>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--hairline))" vertical={false} />
          <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={false} interval={0} height={40}
            tickFormatter={(v: string) => (v.length > 12 ? `${v.slice(0, 11)}…` : v)} />
          <YAxis tick={axisStyle} tickLine={false} axisLine={false} width={56} tickFormatter={compact} />
          <Tooltip cursor={{ fill: 'rgb(var(--hairline) / 0.35)' }}
            content={({ active, payload }) =>
              active && payload?.length
                ? <TooltipCard heading={String(payload[0].payload.label)}
                    rows={[{ label: valueLabel, value: num(Number(payload[0].value)), color }]} />
                : null} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={44}>
            {rows.map((r) => <Cell key={r.key} fill={color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

/** Inline sparkline for table rows — no axes, no tooltip. */
export function Spark({ values, slot = 0 }: { values: number[]; slot?: number }) {
  const { dark } = useTheme();
  const color = seriesColors(dark)[slot];
  const max = Math.max(...values, 1);
  return (
    <svg viewBox="0 0 100 24" className="h-6 w-24" preserveAspectRatio="none" aria-hidden>
      <polyline
        points={values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * 100},${24 - (v / max) * 22}`).join(' ')}
        fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const chartCx = cx;
