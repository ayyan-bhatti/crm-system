import { deliveryUrgency, URGENCY_STYLES } from '../ui';

/**
 * "Arriving tomorrow" / "Overdue by 2 days", as a chip.
 *
 * WHY IT RENDERS NOTHING MOST OF THE TIME.
 *
 * A badge on every row is not a signal, it is a column — and a column of
 * calm-coloured chips saying "arriving in nine days" is exactly the noise that
 * teaches somebody to stop reading the chips, which is how the one that matters
 * gets skipped. So this returns null unless the order is genuinely near its
 * promised date or past it.
 *
 * The threshold is deliberately the same one `deliveryUrgency` uses, because
 * two definitions of "urgent" — one for the buyer's timeline and one for the
 * staff list — is how a customer ends up seeing an alarm the person who could
 * act on it never saw.
 *
 * `showSoon` exists for the order DETAIL page, where there is room for a
 * two-or-three-days-out note and only one order to read, so the noise argument
 * does not apply.
 */
export default function UrgencyBadge({ order, showSoon = false, className = '' }) {
  const urgency = deliveryUrgency(order);

  const worthShowing =
    urgency.level === 'overdue' ||
    urgency.level === 'tomorrow' ||
    (showSoon && urgency.level === 'soon');

  if (!worthShowing) return null;

  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${URGENCY_STYLES[urgency.level]} ${className}`}
      title={`Estimated delivery ${new Date(order.estimatedDeliveryAt).toLocaleDateString()}`}
    >
      {urgency.level === 'overdue' && (
        <span aria-hidden="true" className="leading-none">
          ⚠
        </span>
      )}
      {urgency.label}
    </span>
  );
}
