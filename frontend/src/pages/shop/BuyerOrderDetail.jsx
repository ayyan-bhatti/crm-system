import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopOrdersApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import useFetch from '../../hooks/useFetch';
import {
  Breadcrumb,
  Button,
  Card,
  ErrorBanner,
  Spinner,
  StatusBadge,
} from '../../components/common';
import DeliveryTimeline from '../../components/DeliveryTimeline';
import CourierTrackingInfo from '../../components/CourierTrackingInfo';
import {
  formatDateTime,
  input,
  money,
  orderLabel,
  PAYMENT_METHOD_LABELS,
  td,
  th,
  variantLabel,
} from '../../ui';

/**
 * One of the buyer's own orders.
 *
 * THE ORDER OF THE PAGE IS THE ORDER OF THE QUESTIONS. Where is it, what was
 * in it, and only then — can I still change it. The change controls are last
 * because they only exist for a `pending` order and because they are the least
 * likely reason anyone opened this page; putting them near the top would give
 * the impression that an order in progress is something to manage rather than
 * something to wait for.
 */
export default function BuyerOrderDetail() {
  const { id } = useParams();
  const { isSignedIn, loading: authLoading } = useBuyerAuth();
  const toast = useToast();
  const confirm = useConfirm();

  const { data: order, loading, error, reload } = useFetch(
    () => (isSignedIn ? shopOrdersApi.get(id) : Promise.resolve(null)),
    [isSignedIn, id]
  );

  const [busy, setBusy] = useState(false);
  const [editingQty, setEditingQty] = useState(false);
  const [quantities, setQuantities] = useState({});

  useEffect(() => {
    if (!order) return;
    const seed = {};
    order.items.forEach((item) => {
      if (item.product) seed[item.product._id] = item.quantity;
    });
    setQuantities(seed);
  }, [order]);

  if (authLoading) return <Spinner full />;
  if (!isSignedIn) {
    return <Navigate to="/login" replace state={{ from: `/account/orders/${id}` }} />;
  }
  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!order) return null;

  const isPending = order.status === 'pending';

  async function handleRequestCancel() {
    const ok = await confirm('Request cancellation of this order?', { confirmLabel: 'Request cancellation' });
    if (!ok) return;

    setBusy(true);
    try {
      const result = await shopOrdersApi.requestCancel(id);
      toast.success(result.message || 'Your cancellation request has been sent for approval.');
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the cancellation request'));
    } finally {
      setBusy(false);
    }
  }

  async function submitEditRequest(event) {
    event.preventDefault();
    setBusy(true);

    try {
      const items = order.items
        .filter((item) => item.product)
        .map((item) => ({
          product: item.product._id,
          quantity: quantities[item.product._id],
        }));

      const result = await shopOrdersApi.requestEdit(id, items);
      toast.success(result.message || 'Your edit request has been sent for approval.');
      setEditingQty(false);
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the edit request'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <Breadcrumb
        className="mb-6"
        items={[
          { label: 'Your orders', to: '/account/orders' },
          { label: orderLabel(order) },
        ]}
      />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="label-mono">Order</p>
          <h1 className="font-display mt-2 text-[32px] leading-tight text-ink sm:text-[36px]">
            {orderLabel(order)}
          </h1>
          <p className="mt-2 text-sm text-ink-2">Placed {formatDateTime(order.createdAt)}</p>
        </div>

        {/*
         * The DELIVERY status, not the commercial one. This is the buyer's
         * page, and "pending" is an answer to a question they did not ask —
         * it means "staff have not marked this fulfilled", which is internal
         * bookkeeping. What they want to know is where the parcel is.
         */}
        <div className="shrink-0 pt-1">
          <StatusBadge value={order.fulfilment || 'processing'} />
        </div>
      </div>

      <div className="mt-8 space-y-6">
        <Card className="p-6">
          <h2 className="font-display text-[22px] leading-none text-ink">Where your order is</h2>
          <div className="mt-6">
            <DeliveryTimeline order={order} />
          </div>
          <CourierTrackingInfo order={order} />
        </Card>

        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-3 px-6 pb-4 pt-6">
            <h2 className="font-display text-[22px] leading-none text-ink">Your items</h2>
            {order.paymentMethod && (
              <p className="text-xs text-muted">
                Paid by {PAYMENT_METHOD_LABELS[order.paymentMethod] || order.paymentMethod}
              </p>
            )}
          </div>

          {/*
            One table, scrolling inside its own box on a narrow screen rather
            than dragging the page sideways. A second card-shaped copy for
            phones was the alternative and is worse: two DOM copies of every
            line, read twice by a screen reader, kept in sync by hand.
          */}
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-left">
              <caption className="sr-only">Items in order {orderLabel(order)}</caption>
              <thead className="border-y border-hairline bg-plane">
                <tr>
                  <th className={th}>Item</th>
                  <th className={`${th} text-right`}>Unit price</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Line total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {order.items.map((item, index) => (
                  <tr key={index}>
                    <td className={`${td} font-medium text-ink`}>
                      {item.product?.name || 'Deleted product'}
                      {/* Which colour and size. Two lines of the same product in
                          different colours are otherwise indistinguishable. */}
                      {item.variant && (
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs font-normal text-muted">
                          {item.variant.colorHex && (
                            <span
                              aria-hidden="true"
                              className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-ink/15"
                              style={{ backgroundColor: item.variant.colorHex }}
                            />
                          )}
                          {variantLabel(item.variant)}
                        </span>
                      )}
                    </td>
                    <td className={`${td} text-right tabular`}>{money(item.priceAtOrder)}</td>
                    <td className={`${td} text-right tabular`}>{item.quantity}</td>
                    <td className={`${td} text-right tabular`}>
                      {money(item.priceAtOrder * item.quantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-hairline bg-plane">
                  <td className={td} colSpan={3}>
                    <span className="font-semibold text-ink">Total</span>
                  </td>
                  <td className={`${td} text-right text-base font-semibold text-ink tabular`}>
                    {money(order.total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        {isPending ? (
          <Card className="p-6">
            <h2 className="font-display text-[22px] leading-none text-ink">
              Need to change this order?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Both actions send a request for approval — nothing changes until it is accepted.
            </p>

            <div className="mt-5 flex flex-wrap gap-2.5">
              <Button variant="secondary" disabled={busy} onClick={handleRequestCancel}>
                Request cancellation
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                aria-expanded={editingQty}
                onClick={() => setEditingQty((v) => !v)}
              >
                {editingQty ? 'Cancel' : 'Request different quantities'}
              </Button>
            </div>

            {editingQty && (
              <form
                onSubmit={submitEditRequest}
                noValidate
                className="mt-6 space-y-4 border-t border-hairline pt-6"
              >
                <p className="label-mono">New quantities</p>

                {order.items
                  .filter((item) => item.product)
                  .map((item) => (
                    <div
                      key={item.product._id}
                      className="flex items-center justify-between gap-4 text-sm"
                    >
                      <span className="min-w-0 font-medium text-ink">{item.product.name}</span>
                      <input
                        type="number"
                        min="0"
                        className={`${input} max-w-[6rem] shrink-0 text-right tabular`}
                        value={quantities[item.product._id] ?? item.quantity}
                        onChange={(e) =>
                          setQuantities({
                            ...quantities,
                            [item.product._id]: Math.max(0, Number(e.target.value)),
                          })
                        }
                        aria-label={`New quantity for ${item.product.name}`}
                      />
                    </div>
                  ))}

                <p className="text-xs leading-relaxed text-muted">
                  Set a quantity to 0 to remove that item from the request.
                </p>

                <Button type="submit" className="w-full" loading={busy} loadingLabel="Sending…">
                  Send request
                </Button>
              </form>
            )}
          </Card>
        ) : (
          <div className="rounded-xl border border-hairline bg-sunken/60 px-5 py-4 text-sm text-ink-2">
            This order is already {order.status} and can no longer be changed.
          </div>
        )}
      </div>
    </div>
  );
}
