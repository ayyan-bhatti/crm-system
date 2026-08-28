import { Link, useLocation, useParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopOrdersApi } from '../../api/shopResources';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { Card, EmptyState, ErrorBanner, Spinner, StatusBadge } from '../../components/common';
import { formatDate, link, money, orderLabel, td, th } from '../../ui';

/**
 * WHY THE ORDER CAN ARRIVE TWO DIFFERENT WAYS
 *
 * A guest has no session, so there is nothing `shopOrdersApi.get` could
 * fetch for them — the order they just placed is the ONLY copy of it they
 * are ever authorised to see, and it has to travel here as router state from
 * the checkout submission. A signed-in buyer could be re-fetched instead,
 * which is what happens if the state is missing (a reload, a bookmark) —
 * that path is closed to a guest, so their fallback is a plain message
 * rather than a crash.
 */
export default function OrderConfirmation() {
  const { id } = useParams();
  const location = useLocation();
  const { isSignedIn } = useBuyerAuth();

  const stateOrder = location.state?.order;
  const shouldFetch = !stateOrder && isSignedIn;

  const { data: fetchedOrder, loading, error } = useFetch(
    () => (shouldFetch ? shopOrdersApi.get(id) : Promise.resolve(null)),
    [shouldFetch, id]
  );

  const order = stateOrder || fetchedOrder;

  if (shouldFetch && loading) return <Spinner full />;
  if (shouldFetch && error) return <ErrorBanner message={error} />;

  if (!order) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <EmptyState
          title="We don't have this order's details anymore"
          hint="If you just placed it, check your email for the confirmation, or find it in your order history."
          action={
            <Link to="/shop/products" className={link}>
              Keep shopping
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <div className="animate-fade-rise text-center">
        <h1 className="font-display text-3xl font-semibold text-ink">Thank you for your order</h1>
        <p className="mt-2 text-sm text-ink-2">
          Order {orderLabel(order)}, placed {formatDate(order.createdAt)}.
        </p>
        <div className="mt-3">
          <StatusBadge value={order.status} />
        </div>
      </div>

      <Card className="mt-8 p-5">
        <table className="w-full">
          <thead className="border-b border-hairline">
            <tr>
              <th className={th}>Item</th>
              <th className={`${th} text-right`}>Qty</th>
              <th className={`${th} text-right`}>Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {order.items.map((item, index) => (
              <tr key={index}>
                <td className={td}>{item.product?.name || 'Product'}</td>
                <td className={`${td} text-right`}>{item.quantity}</td>
                <td className={`${td} text-right`}>{money(item.priceAtOrder * item.quantity)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline">
              <td className={td} colSpan={2}>
                <span className="font-medium text-ink-2">Total</span>
              </td>
              <td className={`${td} text-right text-base font-semibold text-ink`}>
                {money(order.total)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Card>

      <div className="mt-8 flex flex-wrap justify-center gap-4 text-sm">
        <Link to="/shop/products" className={link}>
          Keep shopping
        </Link>
        {isSignedIn && (
          <Link to="/shop/account/orders" className={link}>
            View your orders
          </Link>
        )}
      </div>
    </div>
  );
}
