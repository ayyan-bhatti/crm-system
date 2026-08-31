import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ordersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import {
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
  StatusBadge,
  TableSkeleton,
} from '../../components/common';
import { useToast } from '../../components/Toast';
import UrgencyBadge from '../../components/UrgencyBadge';
import {
  FULFILMENT_STEPS,
  btnSecondary,
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
        title="Deliveries"
        subtitle="Everything still on its way, most urgent first."
        action={
          <Link to="/crm/orders" className={btnSecondary}>
            All orders
          </Link>
        }
      />

      <ErrorBanner message={error} />

      {/*
        The headline counts come from the server's own ranking. A board whose
        summary is computed separately from its list is a board that will one
        day say "2 overdue" above three red rows.
      */}
      {summary && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Overdue" value={summary.overdue} tone="critical" />
          <Tile label="Out for delivery" value={summary.outForDelivery} tone="warning" />
          <Tile label="Due today or tomorrow" value={summary.dueSoon} tone="warning" />
          <Tile label="Express" value={summary.express} tone="brand" />
        </div>
      )}

      <Card>
        {loading ? (
          <TableSkeleton rows={5} columns={4} />
        ) : orders.length === 0 ? (
          <EmptyState
            title="Nothing in flight"
            hint="Every order has either arrived or has not been sent yet."
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {orders.map((order) => {
              const urgency = deliveryUrgency(order);
              const next = FULFILMENT_STEPS[fulfilmentIndex(order.fulfilment) + 1];
              const express = order.deliverySpeed === 'express';

              return (
                <li
                  key={order._id}
                  className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5 transition-colors hover:bg-plane ${
                    urgency.level === 'overdue' ? 'bg-critical-wash/40' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/crm/orders/${order._id}`}
                        className={`${link} font-mono text-xs`}
                      >
                        {orderLabel(order)}
                      </Link>
                      <StatusBadge value={order.fulfilment || 'processing'} />
                      <UrgencyBadge order={order} showSoon />
                      {/* Express is stated, not implied by position — a row's
                          rank is invisible once you are looking at one row. */}
                      {express && (
                        <span className="rounded-full border border-brand/30 bg-brand-wash px-2 py-0.5 text-[11px] font-semibold text-brand-ink">
                          Express
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-ink-2">
                      {order.customer?.name || 'Unknown customer'}
                      {order.assignedTo?.name && (
                        <span className="text-muted"> · {order.assignedTo.name}</span>
                      )}
                    </p>
                  </div>

                  <div className="text-right text-xs text-muted">
                    <p className="text-sm font-medium text-ink tabular">{money(order.total)}</p>
                    {order.estimatedDeliveryAt && (
                      <p>Due {formatDate(order.estimatedDeliveryAt)}</p>
                    )}
                  </div>

                  {/*
                    One button, and it names the next stage rather than saying
                    "Advance". Somebody scanning a queue should not have to
                    remember what comes after "At the warehouse".
                  */}
                  {next && (
                    <button
                      type="button"
                      className={btnSecondary}
                      disabled={busyId === order._id}
                      onClick={() => advance(order)}
                    >
                      {busyId === order._id ? <Spinner /> : `Mark ${next.label.toLowerCase()}`}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, tone }) {
  const tones = {
    critical: 'border-critical/25 bg-critical-wash text-critical-ink',
    warning: 'border-warning/30 bg-warning-wash text-warning-ink',
    brand: 'border-brand/25 bg-brand-wash text-brand-ink',
  };

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        // A zero is deliberately NOT coloured. A red tile reading "0 overdue"
        // is an alarm for something that is not happening.
        value > 0 ? tones[tone] : 'border-hairline bg-surface text-ink-2'
      }`}
    >
      <p className="text-2xl font-semibold tabular">{value}</p>
      <p className="mt-0.5 text-xs font-medium">{label}</p>
    </div>
  );
}
