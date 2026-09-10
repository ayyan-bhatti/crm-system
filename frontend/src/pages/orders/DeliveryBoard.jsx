import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ordersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import useCountUp from '../../hooks/useCountUp';
import {
  Button,
  ButtonLink,
  Card,
  CardSkeleton,
  EmptyState,
  ErrorBanner,
  PageHeader,
  StatusBadge,
} from '../../components/common';
import { useToast } from '../../components/Toast';
import UrgencyBadge from '../../components/UrgencyBadge';
import {
  FULFILMENT_STEPS,
  URGENCY_STYLES,
  deliveryUrgency,
  formatDate,
  fulfilmentIndex,
  link,
  money,
  orderLabel,
} from '../../ui';

/**
 * Every parcel still on its way, worst first.
 *
 * WHY THIS IS A SEPARATE PAGE FROM THE ORDER LIST.
 *
 * They answer different questions. The order list answers "what did we sell?"
 * — it is a ledger, sorted by date, paginated, filtered by commercial status,
 * and it is the right tool for looking something up. This answers "what should
 * I deal with first?", which is a queue, not a ledger. Bolting a priority sort
 * onto the list would have made one screen do both jobs badly: the ranking that
 * matters here is a comparison between the promised date and today, which no
 * stored column can express and no index can sort.
 *
 * The ranking comes from the SERVER, deliberately. The client renders the order
 * it is given rather than re-sorting, because two implementations of "urgent"
 * is exactly how the badge on a row and the position of that row start
 * disagreeing.
 *
 * SO THIS IS CARDS AND NOT A TABLE, and that follows from the same reasoning.
 * A table invites reading down a column and comparing values; a queue is read
 * top to bottom and acted on one item at a time. Each card carries the whole
 * decision — what it is, how late it is, who is waiting, and the single button
 * that moves it on — so nothing has to be assembled across columns.
 *
 * Staff advance a parcel from here without opening it. That is the entire point
 * of a board: the common action on an urgent order is "it moved", and making
 * somebody open a detail page to say so is what stops it being said.
 */
export default function DeliveryBoard() {
  const toast = useToast();
  const [busyId, setBusyId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const { data, loading, error } = useFetch(() => ordersApi.deliveries(), [reloadKey]);

  const orders = data?.data || [];
  const summary = data?.summary;

  async function advance(order) {
    const next = FULFILMENT_STEPS[fulfilmentIndex(order.fulfilment) + 1];
    if (!next) return;

    setBusyId(order._id);
    try {
      /*
       * The existing estimate is sent back unchanged.
       *
       * The API requires a date on anything at or past `shipped`, and every
       * order now carries one from checkout — but re-sending it explicitly
       * rather than relying on the stored value keeps this call self-contained,
       * and means a legacy order with no estimate fails loudly here instead of
       * being advanced into a state where the customer is shown nothing.
       */
      await ordersApi.updateFulfilment(order._id, next.value, order.estimatedDeliveryAt);
      toast.success(`${orderLabel(order)} → ${next.label}`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update this delivery'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Commerce"
        title="Deliveries"
        subtitle="Everything still on its way, most urgent first. Move a parcel on without opening it."
        action={
          <ButtonLink variant="secondary" to="/crm/orders">
            All orders
          </ButtonLink>
        }
      />

      <ErrorBanner message={error} />

      {/*
        The headline counts come from the server's own ranking. A board whose
        summary is computed separately from its list is a board that will one
        day say "2 overdue" above three red rows.
      */}
      {summary && (
        <div className="bento-grid stagger-children mb-5">
          {/* Overdue gets the wide tile — it is the one number on this board
              that means something already went wrong, not just "coming up". */}
          <div className="bento-lg">
            <Tile label="Overdue" value={summary.overdue} tone="critical" />
          </div>
          <Tile label="Out for delivery" value={summary.outForDelivery} tone="warning" />
          <Tile label="Due today or tomorrow" value={summary.dueSoon} tone="warning" />
          <Tile label="Express" value={summary.express} tone="brand" />
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Card key={index}>
              <CardSkeleton lines={3} />
            </Card>
          ))}
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing in flight"
            hint="Every order has either arrived or has not been sent yet."
          />
        </Card>
      ) : (
        /*
          A list of cards, in the ORDER THE SERVER GAVE THEM. Grouping them by
          urgency would be a second ranking sitting on top of the first, and the
          two would eventually disagree — the urgency colour on each card says
          the same thing without moving anything.
        */
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {orders.map((order) => (
            <DeliveryCard
              key={order._id}
              order={order}
              busy={busyId === order._id}
              onAdvance={() => advance(order)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One parcel, as a card: what it is, how urgent, who is waiting, and the one
 * button that moves it on.
 *
 * The urgency colour is carried on a left edge rather than by tinting the whole
 * card. A wash behind body text is the fastest way to lose the contrast the
 * status tokens were tuned for, and a queue where three cards in six are pink
 * reads as decoration rather than as an alarm.
 */
function DeliveryCard({ order, busy, onAdvance }) {
  const urgency = deliveryUrgency(order);
  const next = FULFILMENT_STEPS[fulfilmentIndex(order.fulfilment) + 1];
  const express = order.deliverySpeed === 'express';

  const edge = {
    overdue: 'before:bg-critical',
    tomorrow: 'before:bg-warning',
    soon: 'before:bg-rule',
  }[urgency.level];

  return (
    <li
      className={`relative flex flex-col overflow-hidden rounded-xl border bg-surface p-4 shadow-card transition-shadow hover:shadow-lift ${
        edge
          ? `before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${edge}`
          : ''
      } ${urgency.level === 'overdue' ? 'border-critical/30' : 'border-hairline'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <Link to={`/crm/orders/${order._id}`} className={`${link} font-mono text-xs tabular`}>
          {orderLabel(order)}
        </Link>
        {/* Express is stated, not implied by position — a card's rank is
            invisible once you are looking at one card. */}
        {express && (
          <span className="rounded-full border border-brand/30 bg-brand-wash px-2 py-0.5 text-[11px] font-semibold text-brand-ink">
            Express
          </span>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Avatar name={order.customer?.name} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">
            {order.customer?.name || 'Unknown customer'}
          </p>
          {order.assignedTo?.name && (
            <p className="truncate text-xs text-muted">{order.assignedTo.name}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <StatusBadge value={order.fulfilment || 'processing'} />
        <UrgencyBadge order={order} showSoon />
      </div>

      <dl className="mt-4 flex items-end justify-between gap-3 border-t border-hairline pt-3">
        <div>
          <dt className="label-mono">Value</dt>
          <dd className="mt-0.5 text-sm font-semibold text-ink tabular">{money(order.total)}</dd>
        </div>
        {order.estimatedDeliveryAt && (
          <div className="text-right">
            <dt className="label-mono">Due</dt>
            <dd className="mt-0.5 text-sm text-ink-2 tabular">
              {formatDate(order.estimatedDeliveryAt)}
            </dd>
          </div>
        )}
      </dl>

      {/*
        One button, and it names the next stage rather than saying "Advance".
        Somebody scanning a queue should not have to remember what comes after
        "At the warehouse". It is the page's only filled control, because
        advancing a parcel is the only thing this screen is for.
      */}
      {next && (
        <Button
          className="mt-4 w-full"
          loading={busy}
          loadingLabel="Updating…"
          onClick={onAdvance}
        >
          Mark {next.label.toLowerCase()}
        </Button>
      )}
    </li>
  );
}

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Initials disc; hidden from screen readers since the name follows it. */
function Avatar({ name }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-wash text-[11px] font-semibold tracking-wide text-brand-ink"
    >
      {initialsOf(name)}
    </span>
  );
}

function Tile({ label, value, tone }) {
  const display = useCountUp(value);
  const tones = {
    critical: `border ${URGENCY_STYLES.overdue}`,
    warning: `border ${URGENCY_STYLES.tomorrow}`,
    brand: 'border border-brand/25 bg-brand-wash text-brand-ink',
  };

  return (
    <div
      className={`rounded-xl px-4 py-3.5 transition-colors duration-300 ${
        // A zero is deliberately NOT coloured. A red tile reading "0 overdue"
        // is an alarm for something that is not happening.
        value > 0 ? tones[tone] : 'border border-hairline bg-surface text-ink-2 shadow-card'
      }`}
    >
      <p className="text-2xl font-semibold">{display}</p>
      <p className="mt-0.5 text-xs font-medium">{label}</p>
    </div>
  );
}
