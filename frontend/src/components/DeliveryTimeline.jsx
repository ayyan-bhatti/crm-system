import { FULFILMENT_STEPS, fulfilmentIndex, formatDate, deliveryUrgency, URGENCY_STYLES } from '../ui';

/**
 * Where a parcel is, drawn as a sequence rather than written as a word.
 *
 * WHY A TIMELINE AND NOT JUST A BADGE
 *
 * "Shipped" on its own answers one question and raises two: what happened
 * before, and what happens next. A shopper checking an order wants to know how
 * far through it is, and a sequence shows that at a glance where a single label
 * requires them to already know the stages. The badge still exists — it is the
 * right thing in a table row, where there is no room for this — so both are
 * used, in the places each suits.
 *
 * Shared between the buyer's order page and the staff order detail, so the
 * customer and the person they ring about it are looking at the same picture.
 */
export default function DeliveryTimeline({ order, compact = false }) {
  const current = fulfilmentIndex(order.fulfilment);
  const urgency = deliveryUrgency(order);

  /*
   * A cancelled order is NOT rendered as a timeline with nothing lit up. It is
   * not at stage zero of a journey it is going to complete — it left the
   * sequence, and drawing the steps anyway invites the reader to expect
   * progress along them.
   */
  if (order.fulfilment === 'cancelled') {
    return (
      <div className="rounded-lg border border-critical/25 bg-critical-wash px-4 py-3 text-sm text-critical-ink">
        This order was cancelled, so it is not on its way.
        {order.payment?.status === 'refunded' && ' Your payment has been refunded in full.'}
      </div>
    );
  }

  return (
    <div>
      <ol className={compact ? 'flex items-center' : 'space-y-0'}>
        {FULFILMENT_STEPS.map((step, index) => {
          const done = index <= current;
          const isCurrent = index === current;
          const last = index === FULFILMENT_STEPS.length - 1;

          if (compact) {
            return (
              <li key={step.value} className="flex flex-1 items-center last:flex-none">
                <span
                  title={step.label}
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                    done ? 'bg-brand' : 'bg-rule'
                  } ${isCurrent ? 'ring-4 ring-brand/20' : ''}`}
                >
                  <span className="sr-only">
                    {step.label}
                    {isCurrent ? ' (current)' : done ? ' (done)' : ' (not yet)'}
                  </span>
                </span>
                {!last && (
                  <span className={`h-0.5 flex-1 ${index < current ? 'bg-brand' : 'bg-rule'}`} />
                )}
              </li>
            );
          }

          return (
            <li key={step.value} className="flex gap-3">
              {/* The rail: a dot per step, joined by a line that is only
                  coloured for the stretch already travelled. */}
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    done ? 'bg-brand text-white' : 'bg-neutral-wash text-muted'
                  } ${isCurrent ? 'ring-4 ring-brand/20' : ''}`}
                  aria-hidden="true"
                >
                  {done ? '✓' : index + 1}
                </span>
                {!last && (
                  <span
                    className={`w-0.5 flex-1 ${index < current ? 'bg-brand' : 'bg-rule'}`}
                    aria-hidden="true"
                  />
                )}
              </div>

              <div className={last ? 'pb-0' : 'pb-6'}>
                <p
                  className={`text-sm font-medium ${
                    isCurrent ? 'text-ink' : done ? 'text-ink-2' : 'text-muted'
                  }`}
                >
                  {step.label}
                  {/* Never colour alone: the current step says so in words too. */}
                  {isCurrent && (
                    <span className="ml-2 rounded-full bg-brand-wash px-2 py-0.5 text-[11px] font-semibold text-brand-ink">
                      Now
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-muted">{step.hint}</p>

                {step.value === 'shipped' && order.shippedAt && (
                  <p className="mt-1 text-xs text-ink-2">Sent {formatDate(order.shippedAt)}</p>
                )}
                {step.value === 'delivered' && order.deliveredAt && (
                  <p className="mt-1 text-xs text-ink-2">Arrived {formatDate(order.deliveredAt)}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/*
        The estimate is shown BELOW the sequence rather than pinned to the
        "Delivered" step, because it is a fact about the whole order and it
        stops being a prediction the moment the order actually arrives.
      */}
      {order.estimatedDeliveryAt && !order.deliveredAt && (
        <div
          /*
           * The estimate CHANGES APPEARANCE as it approaches, rather than
           * sitting in the same grey box from the day it is set to the day it
           * expires. A date rendered identically whether it is three weeks or
           * three hours away is information the reader has to do arithmetic on,
           * and nobody does that arithmetic on a page they are skimming.
           *
           * `role="alert"` only for the states that have actually gone wrong or
           * are about to. Announcing "arriving in nine days" to a screen reader
           * every time this mounts is noise, and noise is how a real alert gets
           * ignored.
           */
          role={urgency.level === 'overdue' || urgency.level === 'tomorrow' ? 'alert' : undefined}
          className={`mt-4 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${
            URGENCY_STYLES[urgency.level] || 'border-hairline bg-plane text-ink-2'
          }`}
        >
          {(urgency.level === 'overdue' || urgency.level === 'tomorrow') && (
            <span aria-hidden="true" className="mt-0.5 shrink-0 text-base leading-none">
              {urgency.level === 'overdue' ? '⚠' : '⏱'}
            </span>
          )}
          <span>
            {/* The urgency is stated in WORDS first — colour alone is not a
                message, and it is invisible to a third of the reasons somebody
                might be looking at this. */}
            {urgency.label && <span className="font-semibold">{urgency.label} · </span>}
            Estimated delivery{' '}
            <span className="font-semibold">{formatDate(order.estimatedDeliveryAt)}</span>
            {urgency.level === 'overdue' && (
              <span className="mt-0.5 block text-xs">
                This has passed its promised date and has not been marked delivered.
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
