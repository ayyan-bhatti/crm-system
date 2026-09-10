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
 * ONE DOM, TWO LAYOUTS. It is a vertical stepper on a phone and a horizontal
 * one from `md` up, and the switch is entirely CSS. Rendering two copies and
 * hiding one would have been easier to write and is the wrong trade: a screen
 * reader would read all six stages twice, and every test that looks a stage up
 * by its name would find two of it.
 *
 * NOTHING HERE RESTS ON COLOUR. Each marker carries a shape as well as a fill
 * — a tick for a stage that is done, a ring for the one in progress, an
 * outlined number for one still to come — the current stage says "Now" in
 * words, and every marker has a visually-hidden state ("Completed", "In
 * progress", "Not started yet") so the sequence survives being listened to.
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
      <div className="flex items-start gap-3 rounded-xl border border-critical/25 bg-critical-wash px-4 py-3.5 text-sm text-critical-ink">
        <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 fill-current" aria-hidden="true">
          <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
        </svg>
        <span>
          This order was cancelled, so it is not on its way.
          {order.payment?.status === 'refunded' && ' Your payment has been refunded in full.'}
        </span>
      </div>
    );
  }

  /*
   * The compact rail, for a list row: dots and connectors, no words. It is a
   * progress indicator rather than a legend, so every dot carries its stage
   * name in a visually-hidden span — otherwise the whole thing is invisible to
   * anyone not looking at it.
   */
  if (compact) {
    return (
      <ol className="flex items-center" aria-label="Delivery progress">
        {FULFILMENT_STEPS.map((step, index) => {
          const done = index <= current;
          const isCurrent = index === current;
          const last = index === FULFILMENT_STEPS.length - 1;

          return (
            <li key={step.value} className="flex flex-1 items-center last:flex-none">
              <span
                title={step.label}
                className={`h-2 w-2 shrink-0 rounded-full ${done ? 'bg-brand' : 'bg-rule'} ${
                  isCurrent ? 'ring-4 ring-brand/20' : ''
                }`}
              >
                <span className="sr-only">
                  {step.label}
                  {isCurrent ? ' (current)' : done ? ' (done)' : ' (not yet)'}
                </span>
              </span>
              {!last && (
                <span
                  aria-hidden="true"
                  className={`h-px flex-1 ${index < current ? 'bg-brand' : 'bg-rule'}`}
                />
              )}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <div>
      <ol className="flex flex-col md:flex-row md:items-stretch">
        {FULFILMENT_STEPS.map((step, index) => {
          const done = index <= current;
          const isCurrent = index === current;
          const last = index === FULFILMENT_STEPS.length - 1;

          return (
            <li
              key={step.value}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex gap-3.5 md:min-w-0 md:flex-1 md:flex-col md:gap-0 md:last:flex-none"
            >
              {/*
                The rail. Vertical on a phone (marker above a line that runs
                down beside the text), horizontal from md (marker beside a line
                that runs across to the next stage). The connector is only
                filled for the stretch already travelled.
              */}
              <div className="flex shrink-0 flex-col items-center md:w-full md:flex-row md:items-center">
                <Marker done={done} isCurrent={isCurrent} index={index} label={step.label} />
                {!last && (
                  <span
                    aria-hidden="true"
                    className={`w-px flex-1 md:h-px md:w-auto md:flex-1 ${
                      index < current ? 'bg-brand' : 'bg-rule'
                    }`}
                  />
                )}
              </div>

              <div className={`min-w-0 ${last ? 'pb-0' : 'pb-7'} md:pb-0 md:pr-5 md:pt-3.5`}>
                <p
                  className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold ${
                    isCurrent ? 'text-ink' : done ? 'text-ink-2' : 'text-muted'
                  }`}
                >
                  {step.label}
                  {/* Never colour alone: the current step says so in words too. */}
                  {isCurrent && (
                    <span className="rounded-full bg-brand-wash px-2 py-0.5 text-[11px] font-semibold text-brand-ink">
                      Now
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">{step.hint}</p>

                {step.value === 'shipped' && order.shippedAt && (
                  <p className="mt-1.5 text-xs font-medium text-ink-2">
                    Sent {formatDate(order.shippedAt)}
                  </p>
                )}
                {step.value === 'delivered' && order.deliveredAt && (
                  <p className="mt-1.5 text-xs font-medium text-ink-2">
                    Arrived {formatDate(order.deliveredAt)}
                  </p>
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
          className={`mt-6 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
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

/**
 * One marker on the rail.
 *
 * THREE STATES, THREE SHAPES. Completed is a filled disc with a tick, the
 * current stage is a filled disc inside a ring, and an upcoming stage is an
 * outlined disc carrying its position in the sequence. Take all the colour
 * away and the three are still told apart, which is the requirement.
 */
function Marker({ done, isCurrent, index, label }) {
  const base =
    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors';

  const skin = done
    ? 'bg-brand text-on-brand'
    : 'border border-rule bg-surface text-muted';

  return (
    <span className={`${base} ${skin} ${isCurrent ? 'ring-4 ring-brand/20' : ''}`}>
      <span aria-hidden="true">
        {done ? (
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-current">
            <path d="M8.2 14.4L4 10.2l1.4-1.4 2.8 2.8 6.4-6.4L16 6.6z" />
          </svg>
        ) : (
          index + 1
        )}
      </span>
      <span className="sr-only">
        {label}: {isCurrent ? 'in progress' : done ? 'completed' : 'not started yet'}
      </span>
    </span>
  );
}
