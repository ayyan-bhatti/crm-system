import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { shopOrdersApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { useToast } from '../../components/Toast';
import useFetch from '../../hooks/useFetch';
import { Card, ErrorBanner, PageHeader, Spinner, StatusBadge } from '../../components/common';
import { btnPrimary, btnSecondary, formatDateTime, money, orderLabel, td, th } from '../../ui';

export default function BuyerOrderDetail() {
  const { id } = useParams();
  const { isSignedIn, loading: authLoading } = useBuyerAuth();
  const toast = useToast();

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
    if (!window.confirm('Request cancellation of this order?')) return;

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
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-10 sm:px-6">
      <PageHeader
        title={orderLabel(order)}
        subtitle={formatDateTime(order.createdAt)}
        action={<StatusBadge value={order.status} />}
      />

      <Card className="p-5">
        <table className="w-full">
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
                <td className={td}>{item.product?.name || 'Deleted product'}</td>
                <td className={`${td} text-right`}>{money(item.priceAtOrder)}</td>
                <td className={`${td} text-right`}>{item.quantity}</td>
                <td className={`${td} text-right`}>{money(item.priceAtOrder * item.quantity)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline">
              <td className={td} colSpan={3}>
                <span className="font-medium text-ink-2">Total</span>
              </td>
              <td className={`${td} text-right text-base font-semibold text-ink`}>
                {money(order.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>

      {isPending ? (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-ink">Need to change this order?</h2>
          <p className="mt-1 text-xs text-muted">
            Both actions send a request for approval — nothing changes until it is accepted.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={btnSecondary} disabled={busy} onClick={handleRequestCancel}>
              Request cancellation
            </button>
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => setEditingQty((v) => !v)}
            >
              {editingQty ? 'Cancel' : 'Request different quantities'}
            </button>
          </div>

          {editingQty && (
            <form onSubmit={submitEditRequest} className="mt-4 space-y-3 border-t border-hairline pt-4">
              {order.items
                .filter((item) => item.product)
                .map((item) => (
                  <div key={item.product._id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-ink-2">{item.product.name}</span>
                    <input
                      type="number"
                      min="0"
                      className="w-20 rounded-lg border border-hairline bg-raised px-2 py-1 text-right text-sm"
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

              <button type="submit" className={`${btnPrimary} w-full`} disabled={busy}>
                {busy ? <Spinner /> : 'Send request'}
              </button>
            </form>
          )}
        </Card>
      ) : (
        <p className="text-sm text-muted">
          This order is already {order.status} and can no longer be changed.
        </p>
      )}
    </div>
  );
}
