import { btnSecondary, btnSmall, buildTrackingUrl, COURIER_LABELS } from '../ui';

/**
 * "Shipped with X — tracking number Y, [Track package]" — the courier half
 * of an order's delivery info, shared between the signed-in buyer's own
 * order page and the public no-login tracking page so the two never drift
 * apart in wording.
 *
 * Renders nothing when no courier is on the order yet — that is the ordinary
 * state for most of an order's life, not a missing-data case worth a message.
 *
 * The tracking number is set in tabular figures and given its own line rather
 * than being buried mid-sentence: it is the one string on this page somebody
 * actually has to read out, copy, or type into a courier's own box, and a
 * fourteen-character reference wrapped inside a paragraph is genuinely hard to
 * transcribe without losing your place.
 */
export default function CourierTrackingInfo({ order }) {
  if (!order.courier) return null;

  const trackingUrl = buildTrackingUrl(order.courier, order.trackingNumber);

  return (
    <div className="mt-6 border-t border-hairline pt-5">
      <p className="label-mono">On its way with</p>

      <p className="mt-1.5 text-sm font-medium text-ink">
        Shipped with {COURIER_LABELS[order.courier] || order.courier}
      </p>

      {order.trackingNumber && (
        <p className="mt-1 text-sm text-ink-2">
          Tracking number{' '}
          <span className="font-semibold text-ink tabular">{order.trackingNumber}</span>
        </p>
      )}

      {trackingUrl && (
        <a
          href={trackingUrl}
          target="_blank"
          rel="noreferrer"
          className={`${btnSecondary} ${btnSmall} mt-3.5`}
        >
          Track package
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
            <path d="M11 3h6v6h-2V6.4l-6.3 6.3-1.4-1.4L13.6 5H11zM4 6h4v2H5v7h7v-3h2v5H4z" />
          </svg>
        </a>
      )}

      {/*
        Only DHL gets a deep link; the other two open their own tracking page
        with nothing filled in. Saying so is the difference between a link that
        looks broken and one that is doing what it can — see `buildTrackingUrl`.
      */}
      {trackingUrl && order.courier !== 'dhl' && order.trackingNumber && (
        <p className="mt-2 text-xs text-muted">
          Paste the tracking number into the courier&rsquo;s own page — they do not accept it in
          the link.
        </p>
      )}
    </div>
  );
}
