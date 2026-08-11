import { useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import { Card } from './common';
import { money, moneyCompact, token } from '../ui';

/* ===========================================================================
 * Chart building blocks.
 *
 * A few rules are applied consistently to every chart here, because they are
 * what separates a readable chart from a loud one:
 *
 *   - Thin marks. 2px lines, bars capped at 24px, area fills as a ~10% wash
 *     rather than a saturated block. The data is the only thing allowed to be
 *     loud.
 *   - Recessive chrome. Gridlines and axes are solid 1px hairlines one step off
 *     the surface — never dashed, which reads as "projection" when it is just a
 *     grid.
 *   - Separation by negative space. Touching marks are separated by a 2px gap in
 *     the surface colour, never by a border drawn around the mark.
 *   - Text never wears the series colour. Values and labels use text tokens; a
 *     coloured dot beside them carries the identity. A light hue like the aqua
 *     slot is illegible as text.
 *   - Every chart has a table view. Colour and tooltips enhance; they never gate
 *     access to a number.
 * ======================================================================== */

/** Shared axis styling. */
const axisProps = {
  stroke: 'var(--color-rule)',
  tick: { fill: 'var(--color-muted)', fontSize: 11 },
  tickLine: false,
  axisLine: false,
};

/**
 * Tooltip shared by every chart.
 *
 * Recharts' default is a white box with a border and the series colour used as
 * the label text; this restates it with our tokens and keeps the value in ink,
 * with a colour chip carrying the identity.
 */
function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 shadow-pop">
      {label !== undefined && (
        <p className="mb-1.5 text-xs font-medium text-muted">{label}</p>
      )}
      <ul className="space-y-1">
        {payload.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: entry.payload?.fill || entry.color }}
            />
            <span className="text-ink-2">{entry.name}</span>
            <span className="ml-auto font-semibold text-ink tabular">
              {formatter ? formatter(entry.value, entry) : entry.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Card wrapper for a chart: title, optional subtitle, and the chart/table toggle.
 *
 * The toggle is not a nicety. Three of the categorical hues sit below 3:1
 * contrast against this surface, which is only acceptable because the numbers
 * are also reachable without relying on colour at all.
 */
export function ChartCard({ title, subtitle, children, table, action, className = '' }) {
  const [showTable, setShowTable] = useState(false);

  return (
    <Card className={`flex flex-col p-5 ${className}`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>

        <div className="flex items-center gap-2">
          {action}
          {table && (
            <div className="flex rounded-lg border border-hairline p-0.5" role="group">
              {['Chart', 'Table'].map((mode) => {
                const isTable = mode === 'Table';
                const activeMode = showTable === isTable;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={activeMode}
                    onClick={() => setShowTable(isTable)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      activeMode
                        ? 'bg-neutral-wash text-ink'
                        : 'text-muted hover:text-ink-2'
                    }`}
                  >
                    {mode}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1">{showTable && table ? table : children}</div>
    </Card>
  );
}

/** The table twin rendered behind the "Table" toggle. */
export function DataTable({ columns, rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-hairline">
            {columns.map((col, i) => (
              <th
                key={col.key}
                className={`px-2 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted ${
                  i === 0 ? 'text-left' : 'text-right'
                }`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((col, i) => (
                <td
                  key={col.key}
                  className={`px-2 py-2 text-sm ${
                    i === 0 ? 'text-left text-ink-2' : 'text-right font-medium text-ink tabular'
                  }`}
                >
                  {/* A colour chip beside the first cell mirrors the chart's
                      identity channel without colouring the text itself. */}
                  {i === 0 && row.fill && (
                    <span
                      className="mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle"
                      style={{ background: row.fill }}
                    />
                  )}
                  {col.format ? col.format(row[col.key]) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Revenue over time — a single-series area chart.
 *
 * One series, so there is no legend: the card title already says what is
 * plotted, and a one-swatch legend box would just restate it. The last point
 * carries a direct label, because the current month is the number a reader
 * actually came for.
 */
export function RevenueTrend({ data }) {
  const brand = token('--color-brand');
  const surface = token('--color-surface');
  const lastIndex = data.length - 1;

  /**
   * Renders a marker and value on the final point only.
   *
   * Recharts calls this for every point, so it returns null for all but the
   * last — a value beside every point is chaos and goes unread. The label wears
   * an ink token, not the series colour: identity comes from the dot next to it.
   */
  const EndPointLabel = ({ cx, cy, index, payload }) => {
    if (index !== lastIndex || cx == null || cy == null) return null;
    return (
      <g>
        {/* 2px ring in the surface colour so the dot stays legible over the line. */}
        <circle cx={cx} cy={cy} r={4} fill={brand} stroke={surface} strokeWidth={2} />
        <text
          x={cx + 9}
          y={cy + 4}
          fontSize={11}
          fontWeight={600}
          fill="var(--color-ink)"
        >
          {moneyCompact(payload.revenue)}
        </text>
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={260}>
      {/* Right margin leaves room for the end label rather than clipping it. */}
      <AreaChart data={data} margin={{ top: 16, right: 52, bottom: 0, left: -8 }}>
        <defs>
          {/* A ~10% wash fading to nothing — a tint under the line, not a slab. */}
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={brand} stopOpacity={0.16} />
            <stop offset="100%" stopColor={brand} stopOpacity={0.01} />
          </linearGradient>
        </defs>

        {/* Horizontal rules only: vertical ones add ink without aiding reading
            of a value against the y-scale. Solid hairline, never dashed. */}
        <CartesianGrid stroke="var(--color-hairline)" strokeWidth={1} vertical={false} />

        <XAxis dataKey="label" {...axisProps} dy={6} />
        <YAxis {...axisProps} width={56} tickFormatter={moneyCompact} />

        <Tooltip
          cursor={{ stroke: 'var(--color-rule)', strokeWidth: 1 }}
          content={<ChartTooltip formatter={(v) => money(v)} />}
        />

        <Area
          type="monotone"
          dataKey="revenue"
          name="Revenue"
          stroke={brand}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="url(#revenueFill)"
          // Only the final point is marked and labelled — see EndPointLabel.
          // The active dot appears on hover for every other point.
          dot={<EndPointLabel />}
          activeDot={{ r: 4, fill: brand, stroke: surface, strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * A donut for part-to-whole at a glance.
 *
 * Kept to three or four segments — past about six, slices become impossible to
 * compare and a bar chart is the honest answer. The total sits in the middle,
 * which is the one number a reader wants that the slices cannot show.
 */
export function StatusDonut({ data, total, totalLabel }) {
  const surface = token('--color-surface');

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div className="relative h-[168px] w-[168px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={54}
              outerRadius={78}
              // The 2px stroke in the surface colour IS the gap between
              // segments — a separator made of negative space rather than a
              // border drawn around each slice.
              stroke={surface}
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
            >
              {data.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>

        {/* Centre label. pointer-events-none so it never blocks a hover. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold text-ink">{total}</span>
          <span className="text-[11px] uppercase tracking-wider text-muted">{totalLabel}</span>
        </div>
      </div>

      {/*
        The legend is always present and carries the value beside each label, so
        the chart is readable without matching colours by eye — and without
        relying on the tooltip.
      */}
      <ul className="w-full space-y-2">
        {data.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2.5 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: entry.fill }}
            />
            <span className="text-ink-2">{entry.name}</span>
            <span className="ml-auto font-semibold text-ink tabular">{entry.value}</span>
            <span className="w-10 text-right text-xs text-muted tabular">
              {total ? `${Math.round((entry.value / total) * 100)}%` : '0%'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Revenue by category — a horizontal bar chart.
 *
 * Horizontal because category names are words, and words fit along a vertical
 * axis without rotating. Every bar is the SAME colour: the categories have no
 * natural order, and shading them by value would double-encode length as hue —
 * spending the only free channel on information the bar already shows.
 */
export function CategoryBar({ data }) {
  const brand = token('--color-brand');

  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 46)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--color-hairline)" strokeWidth={1} horizontal={false} />
        <XAxis type="number" {...axisProps} tickFormatter={moneyCompact} />
        <YAxis type="category" dataKey="category" {...axisProps} width={104} />
        <Tooltip
          cursor={{ fill: 'var(--color-neutral-wash)' }}
          content={<ChartTooltip formatter={(v) => money(v)} />}
        />
        <Bar
          dataKey="revenue"
          name="Revenue"
          fill={brand}
          // Rounded at the data end, square at the baseline — the bar grows
          // from the axis, and a rounded root would detach it.
          radius={[0, 4, 4, 0]}
          // Capped rather than filling the band, so the leftover is air.
          barSize={20}
          label={{
            position: 'right',
            formatter: (v) => moneyCompact(v),
            fill: 'var(--color-ink-2)',
            fontSize: 11,
            fontWeight: 600,
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * The 12-point sparkline in a stat tile.
 *
 * No axes, no grid, no labels — it carries shape, not values. The tile's own
 * number is the value; this only says which way it has been going.
 */
export function Sparkline({ data, dataKey, color }) {
  const stroke = color || token('--color-brand');

  return (
    <ResponsiveContainer width="100%" height={36}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={`spark-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.18} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={stroke}
          strokeWidth={1.5}
          fill={`url(#spark-${dataKey})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
