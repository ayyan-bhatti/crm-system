/**
 * Shared Tailwind class strings and formatters.
 *
 * Tailwind's whole idea is utility classes in the markup, but repeating a
 * fifteen-class button definition across a dozen files is how a UI drifts.
 * Naming the recurring combinations here keeps every button, input and card
 * identical; anything genuinely one-off stays inline where it is used.
 *
 * Every colour below is a token from index.css — no raw hex in components.
 */

// --- Surfaces ---------------------------------------------------------------

export const card = 'rounded-xl border border-hairline bg-surface shadow-card';

// --- Buttons ----------------------------------------------------------------

const btnBase =
  'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium ' +
  'transition-all duration-150 focus:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-brand/40 focus-visible:ring-offset-2 focus-visible:ring-offset-plane ' +
  'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none';

export const btn = btnBase;

export const btnPrimary =
  `${btnBase} bg-brand text-white shadow-card hover:bg-brand-strong hover:shadow-lift ` +
  'active:bg-brand-ink';

export const btnSecondary =
  `${btnBase} border border-hairline bg-raised text-ink-2 hover:border-rule hover:bg-plane ` +
  'hover:text-ink';

export const btnGhost = `${btnBase} text-ink-2 hover:bg-neutral-wash hover:text-ink`;

export const btnDanger =
  `${btnBase} bg-critical text-white shadow-card hover:brightness-95 hover:shadow-lift`;

// --- Forms ------------------------------------------------------------------

export const input =
  'w-full rounded-lg border border-hairline bg-raised px-3 py-2 text-sm text-ink ' +
  'transition-colors placeholder:text-muted focus:border-brand focus:outline-none ' +
  'focus:ring-2 focus:ring-brand/20 disabled:bg-neutral-wash disabled:text-muted';

export const label = 'mb-1.5 block text-sm font-medium text-ink-2';

// --- Tables -----------------------------------------------------------------

export const th =
  'px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted';

export const td = 'px-4 py-3.5 text-sm text-ink-2';

export const link =
  'font-medium text-ink underline-offset-2 transition-colors hover:text-brand hover:underline';

// --- Status ------------------------------------------------------------------

/**
 * Colour per enum value, so a status looks identical everywhere it appears.
 *
 * These are the reserved status tokens — they mean good / pending / bad, and
 * are never reused as a chart series colour. Each pill pairs the colour with
 * its label, so meaning never rests on hue alone.
 */
export const STATUS_STYLES = {
  // Customer
  lead: 'bg-warning-wash text-warning-ink',
  active: 'bg-good-wash text-good-ink',
  inactive: 'bg-neutral-wash text-neutral-ink',
  // Order
  pending: 'bg-warning-wash text-warning-ink',
  completed: 'bg-good-wash text-good-ink',
  cancelled: 'bg-critical-wash text-critical-ink',
  // Account status. `active` and `pending` are already defined above and mean
  // the same thing here — a healthy account and one waiting on something.
  deactivated: 'bg-critical-wash text-critical-ink',
  // Role
  admin: 'bg-brand-wash text-brand-ink',
  manager: 'bg-brand-wash text-brand-ink',
  sales_rep: 'bg-neutral-wash text-neutral-ink',
};

/**
 * The chart colours, read from CSS custom properties rather than hard-coded, so
 * the palette lives in exactly one file. Recharts needs real values, not
 * `var(...)`, for some props — hence the resolved lookup.
 */
export const CHART_COLORS = {
  series: ['--color-series-1', '--color-series-2', '--color-series-3', '--color-series-4'],
  good: '--color-good',
  warning: '--color-warning',
  critical: '--color-critical',
  brand: '--color-brand',
  grid: '--color-hairline',
  axis: '--color-rule',
  muted: '--color-muted',
  surface: '--color-surface',
};

/** Resolve a CSS custom property to its computed value. */
export function token(name) {
  if (typeof window === 'undefined') return '#2a78d6';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#2a78d6';
}

// --- Formatters --------------------------------------------------------------

/** Currency for display. */
export function money(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(value) || 0);
}

/**
 * Compact currency for axis ticks and stat tiles, where "$12,400" is wider than
 * the space available: $12.4K, $1.2M.
 */
export function moneyCompact(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Format an ISO date string as a short, readable date. */
export function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Turn `sales_rep` into `Sales rep` for display. */
export function humanize(value) {
  if (!value) return '';
  const spaced = String(value).replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * How an order is named on screen.
 *
 * Prefers the human-readable number (`ORD-000142`), which is the point of
 * having one: it can be read down a phone line, quoted in an email, and typed
 * into the search box.
 *
 * Falls back to a SHORTENED `_id` for orders created before order numbers
 * existed. Shortened rather than shown in full because a 24-character hex
 * string in a table column is noise that pushes everything else off the screen
 * — and nobody was ever going to read it aloud anyway. The full id is still in
 * the URL, which is what anything mechanical uses.
 */
export function orderLabel(order) {
  if (order?.orderNumber) return order.orderNumber;
  if (!order?._id) return '—';

  return `#${String(order._id).slice(-6)}`;
}
