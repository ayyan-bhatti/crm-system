import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ordersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import {
  Card,
  ErrorBanner,
  PageHeader,
  Spinner,
  StatusBadge,
} from '../../components/common';
import { btnDanger, btnPrimary, btnSecondary, formatDate, link, money, td, th } from '../../ui';

/**
 * A single order, plus the status controls.
 *
 * The two status actions are the only place in the UI that moves stock, which
 * is why they are here rather than buried in a form:
 *   Complete  — decrements stock for every line
 *   Cancel    — restores it, if it had been taken
 */
export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  /*
   * Feedback goes through the toast system rather than a banner on this page.
   *
   * Deleting an order navigates away, and a message rendered by this component
   * would disappear with it — the user would be returned to the list with no
   * confirmation that anything happened. A toast lives above the routes and
   * survives the navigation that caused it.
   */
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const { data: order, loading, error, reload } = useFetch(() => ordersApi.get(id), [id]);

  async function changeStatus(status) {
    const messages = {
      completed: 'Complete this order? Stock will be deducted for every item.',
      cancelled: 'Cancel this order? Any deducted stock will be returned.',
    };

    if (!window.confirm(messages[status])) return;

    setBusy(true);

    try {
      await ordersApi.update(id, { status });
      toast.success(
        status === 'completed' ? 'Order completed and stock updated.' : 'Order cancelled.'
      );
      reload();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update the order'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm('Delete this order? This cannot be undone.')) return;

    setBusy(true);

    try {
      await ordersApi.remove(id);
      // Raised BEFORE navigating: the toast outlives this component, so the
      // user arrives at the list already knowing the delete succeeded.
      toast.success('Order deleted.');
      navigate('/orders', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the order'));
      setBusy(false);
    }
  }

  if (loading) return <Spinner full />;
  if (error) return <ErrorBanner message={error} />;
  if (!order) return null;

  const isPending = order.status === 'pending';
  const isCompleted = order.status === 'completed';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Order"
        subtitle={formatDate(order.createdAt)}
        action={
          <div className="flex flex-wrap gap-2">
            {isPending && (
              <button
                type="button"
                className={btnPrimary}
                onClick={() => changeStatus('completed')}
                disabled={busy}
              >
                Complete order
              </button>
            )}
            {(isPending || isCompleted) && (
              <button
                type="button"
                className={btnSecondary}
                onClick={() => changeStatus('cancelled')}
                disabled={busy}
              >
                Cancel order
              </button>
            )}
            <button type="button" className={btnDanger} onClick={handleDelete} disabled={busy}>
              Delete
            </button>
          </div>
        }
      />


      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Customer</p>
            {order.customer ? (
              <Link to={`/customers/${order.customer._id}`} className={`${link} text-sm`}>
                {order.customer.name}
              </Link>
            ) : (
              <p className="text-sm text-muted">Unknown</p>
            )}
            {order.customer?.company && (
              <p className="text-xs text-muted">{order.customer.company}</p>
            )}
          </div>

          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Status</p>
            <div className="mt-1">
              <StatusBadge value={order.status} />
            </div>
            {order.completedAt && (
              <p className="mt-1 text-xs text-muted">
                Completed {formatDate(order.completedAt)}
              </p>
            )}
          </div>
        </div>

        <table className="w-full">
          <thead className="border-y border-hairline bg-plane">
            <tr>
              <th className={th}>Product</th>
              <th className={`${th} text-right`}>Unit price</th>
              <th className={`${th} text-right`}>Qty</th>
              <th className={`${th} text-right`}>Line total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {order.items.map((item, index) => (
              <tr key={index}>
                <td className={td}>
                  {item.product ? (
                    <Link to={`/products/${item.product._id}`} className={link}>
                      {item.product.name}
                    </Link>
                  ) : (
                    <span className="text-muted">Deleted product</span>
                  )}
                  {item.product?.sku && <p className="text-xs text-muted">{item.product.sku}</p>}
                </td>
                {/*
                  priceAtOrder, not the product's current price — this is what
                  the customer was actually charged at the time.
                */}
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

        <p className="mt-4 text-xs text-muted">
          Placed by {order.createdBy?.name || 'unknown'} on {formatDate(order.createdAt)}. Prices
          shown are those recorded at the time of the order.
        </p>
      </Card>
    </div>
  );
}
