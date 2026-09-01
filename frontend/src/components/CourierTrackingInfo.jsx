import { btnSecondary, buildTrackingUrl, COURIER_LABELS } from '../ui';

/**
 * "Shipped with X — tracking number Y, [Track package]" — the courier half
 * of an order's delivery info, shared between the signed-in buyer's own
 * order page and the public no-login tracking page so the two never drift
 * apart in wording.
 *
 * Renders nothing when no courier is on the order yet — that is the ordinary
 * state for most of an order's life, not a missing-data case worth a message.
 */
export default function CourierTrackingInfo({ order }) {
  if (!order.courier) return null;

  const trackingUrl = buildTrackingUrl(order.courier, order.trackingNumber);

  return (
    <p className="mt-4 border-t border-hairline pt-4 text-sm text-ink-2">
      Shipped with {COURIER_LABELS[order.courier] || order.courier}
      {order.trackingNumber && <> — tracking number {order.trackingNumber}</>}
      {trackingUrl && (
        <>
          {'. '}
          <a
            href={trackingUrl}
            target="_blank"
            rel="noreferrer"
            className={`${btnSecondary} mt-2 inline-block`}
          >
            Track package
          </a>
        </>
      )}
    </p>
  );
}
