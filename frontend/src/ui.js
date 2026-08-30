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
  // A declined sign-up request. Styled like deactivated rather than like a
  // failure: both are accounts that exist and cannot be used, and neither is
  // an error that somebody needs to go and fix.
  rejected: 'bg-critical-wash text-critical-ink',
  // Role
  admin: 'bg-brand-wash text-brand-ink',
  manager: 'bg-brand-wash text-brand-ink',
  sales_rep: 'bg-neutral-wash text-neutral-ink',
  // Delivery. `cancelled` and `processing` are already defined above and mean
  // the same thing here, so they are deliberately not repeated — a second
  // definition of the same key would silently be the one that wins.
  confirmed: 'bg-brand-wash text-brand-ink',
  shipped: 'bg-brand-wash text-brand-ink',
  out_for_delivery: 'bg-warning-wash text-warning-ink',
  delivered: 'bg-good-wash text-good-ink',
  // Payment
  paid: 'bg-good-wash text-good-ink',
  unpaid: 'bg-neutral-wash text-neutral-ink',
  refunded: 'bg-warning-wash text-warning-ink',
  failed: 'bg-critical-wash text-critical-ink',
};

// --- Delivery ----------------------------------------------------------------

/**
 * The delivery stages, in order, mirroring FULFILMENT_SEQUENCE on the server.
 *
 * DUPLICATED RATHER THAN FETCHED, and worth saying why: this drives a timeline
 * that has to render before any request resolves, and an extra round trip to
 * learn five constants that change roughly never would be a worse trade than
 * the duplication. The server remains the authority — it validates every
 * transition — so the cost of these drifting apart is a mislabelled step, not a
 * wrong state.
 */
export const FULFILMENT_STEPS = [
  { value: 'processing', label: 'Processing', hint: 'We have your order.' },
  { value: 'confirmed', label: 'Confirmed', hint: 'Your order is being prepared.' },
  { value: 'shipped', label: 'Shipped', hint: 'It has left our warehouse.' },
  { value: 'out_for_delivery', label: 'Out for delivery', hint: 'It is with the courier today.' },
  { value: 'delivered', label: 'Delivered', hint: 'It arrived.' },
];

export const FULFILMENT_LABELS = {
  ...Object.fromEntries(FULFILMENT_STEPS.map((step) => [step.value, step.label])),
  cancelled: 'Cancelled',
};

/** How far along the sequence a status is, or -1 for `cancelled`. */
export function fulfilmentIndex(value) {
  return FULFILMENT_STEPS.findIndex((step) => step.value === value);
}

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

/**
 * Date AND time, for the notes timeline.
 *
 * `formatDate` is deliberately date-only, because a table of records does not
 * need the minute a customer was created. A timeline does: two notes on the
 * same day are the common case, and "14 Mar 2026" three times in a row tells
 * the reader nothing about the order of a morning.
 */
export function formatDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Human labels for a storefront order's `paymentMethod` — shared between the
 * buyer-facing checkout form and the staff order-detail screen, so the same
 * value reads the same way on both sides.
 */
export const PAYMENT_METHOD_LABELS = {
  cod: 'Cash on delivery',
  card: 'Card (demo)',
  bank_transfer: 'Bank transfer (demo)',
};

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

// --- Placeholder product images ----------------------------------------------

/**
 * A deterministic set of background colours for generated product placeholders
 * — the same handful of hues used for the category bar chart's series colours,
 * so a placeholder reads as "part of this app" rather than a random swatch.
 */
const PLACEHOLDER_PALETTE = ['#2a78d6', '#1f9d78', '#c2762a', '#7c5cd6', '#c23a5e', '#2a9bc2'];

/** A short, stable hash of a string, used only to pick a palette index. */
function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Up to two initials from a product's name — "Standing Desk" becomes "SD",
 * a one-word name becomes its first letter.
 */
function productInitials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A generated "no photo yet" placeholder for a product with no `imageUrl` —
 * a neutral, on-brand square carrying the product's initials and category,
 * built as an inline SVG data URI so it needs no network request and never
 * 404s. This is what every product created before `imageUrl` existed falls
 * back to, and it is deliberately NOT a random stock photo: the point is that
 * it reads as "no photo yet", not as "this happens to be a photo of a desk".
 */
export function placeholderImage(product) {
  const name = product?.name || 'Product';
  const category = product?.category || '';
  const color = PLACEHOLDER_PALETTE[hashString(name + category) % PLACEHOLDER_PALETTE.length];
  const initials = productInitials(name);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">
    <rect width="480" height="480" fill="${color}" opacity="0.14"/>
    <rect width="480" height="480" fill="none" stroke="${color}" stroke-opacity="0.3" stroke-width="2"/>
    <text x="240" y="252" font-family="system-ui, sans-serif" font-size="120" font-weight="600" fill="${color}" text-anchor="middle">${initials}</text>
    ${category ? `<text x="240" y="330" font-family="system-ui, sans-serif" font-size="22" font-weight="500" fill="${color}" text-anchor="middle" opacity="0.85">${category}</text>` : ''}
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// --- Variants and galleries ---------------------------------------------------

/**
 * How a chosen variant reads on a line: "Midnight / M", or just "Midnight".
 *
 * Takes either shape the app produces — a live variant from the catalogue
 * (`{ color: { name } , size }`) or the snapshot stored on an order line
 * (`{ colorName, size }`). Two shapes exist for a good reason (the snapshot
 * must survive the variant being renamed or deleted), and handling both here
 * means no caller has to remember which one it is holding.
 */
export function variantLabel(variant) {
  if (!variant) return '';
  const colour = variant.colorName || variant.color?.name || '';
  const size = variant.size || '';
  return [colour, size].filter(Boolean).join(' / ');
}

/**
 * Every image for a product, primary first, with the placeholder as a floor.
 *
 * Always returns at least one entry, which is what lets a gallery render
 * `images[0]` unconditionally — the "no photo yet" placeholder is a real image,
 * so there is no empty-array branch anywhere downstream.
 */
export function galleryFor(product) {
  const all = [product?.imageUrl, ...(product?.images || [])].map((url) => (url || '').trim());
  const real = all.filter(Boolean);
  return real.length ? real : [placeholderImage(product)];
}

/**
 * The lowest price a product is available at, for a card's "from $x".
 *
 * Returns null when nothing overrides the base price, so a caller can render
 * the plain price rather than a misleading "from" on a product with exactly one
 * price.
 */
export function priceRange(product) {
  const prices = (product?.variants || []).map((v) => v.price ?? product.price);
  if (prices.length === 0) return null;

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? null : { min, max };
}
