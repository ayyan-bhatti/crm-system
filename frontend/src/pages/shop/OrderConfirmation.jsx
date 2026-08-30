import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopOrdersApi, shopCheckoutApi } from '../../api/shopResources';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useCart } from '../../context/CartContext';
import DeliveryTimeline from '../../components/DeliveryTimeline';
import { Card, EmptyState, ErrorBanner, Spinner, StatusBadge } from '../../components/common';
import { formatDate, link, money, orderLabel, td, th, variantLabel } from '../../ui';

/**
 * The page a buyer lands on after checking out.
 *
 * IT ARRIVES TWO COMPLETELY DIFFERENT WAYS, and that is the whole design.
 *
 *   /order-confirmation/:id                  a cash-on-delivery order, which
 *                                            already exists. Straightforward.
 *   /order-confirmation?session_id=cs_…      Stripe has just redirected the
 *                                            buyer back. THE ORDER MAY NOT
 *                                            EXIST YET.
 *
 * The second case is the interesting one. The redirect is not proof of payment
 * — the webhook is — and on a fast connection the browser genuinely beats the
 * webhook back a good fraction of the time. Showing "something went wrong" to
 * somebody who has just successfully paid is the worst lie this page could
 * tell, so it does something else: it says it is confirming, asks the server
 * once to reconcile against Stripe directly, and polls a cheap endpoint until
 * an answer exists.
 */
export default function OrderConfirmation() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const { isSignedIn } = useBuyerAuth();

  const sessionId = params.get('session_id');

  if (sessionId) return <StripeReturn sessionId={sessionId} />;

  return <DirectOrder id={id} stateOrder={location.state?.order} isSignedIn={isSignedIn} />;
}

/**
 * The Stripe path: wait for the webhook, nudging it along once.
 */
function StripeReturn({ sessionId }) {
  const { clear } = useCart();
  const [state, setState] = useState({ status: 'pending', order: null, note: '' });
  const [error, setError] = useState('');
  const [gaveUp, setGaveUp] = useState(false);
  const attempts = useRef(0);
  const cleared = useRef(false);

  const check = useCallback(async () => {
    /*
     * The FIRST call reconciles — it asks Stripe directly, which is what
     * rescues the common case of the redirect beating the webhook. Subsequent
     * calls are the cheap read, because reconciling in a loop would make an
     * outbound API call every two seconds for a buyer who is simply waiting.
     */
    const first = attempts.current === 0;
    attempts.current += 1;

    return first ? shopCheckoutApi.reconcile(sessionId) : shopCheckoutApi.session(sessionId);
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function poll() {
      try {
        const result = await check();
        if (cancelled) return;

        setState(result);

        if (result.status === 'pending') {
          /*
           * Roughly 30 seconds of polling, then stop and say so. An infinite
           * poll is worse than giving up: it burns the buyer's battery and
           * still never tells them anything, whereas "your payment went
           * through, the order is being created, check your order history"
           * is both true and actionable.
           */
          if (attempts.current >= 15) {
            setGaveUp(true);
            return;
          }
          timer = setTimeout(poll, 2000);
          return;
        }

        // The order exists, so the cart is genuinely spent. Cleared here as
        // well as server-side because this browser's copy is what the header's
        // badge is counting.
        if (result.status === 'completed' && !cleared.current) {
          cleared.current = true;
          clear();
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Could not check your payment');
      }
    }

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [check, clear]);

  if (error) {
    return (
      <Shell>
        <ErrorBanner message={error} />
        <p className="text-sm text-ink-2">
          If you completed the payment, your order will still appear in{' '}
          <Link to="/account/orders" className={link}>
            your order history
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (state.status === 'pending') {
    return (
      <Shell>
        <div className="text-center">
          <Spinner full />
          <h1 className="font-display mt-2 text-2xl font-semibold text-ink">
            Confirming your payment
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-2">
            {gaveUp
              ? 'This is taking longer than usual. Your payment has not been lost — the order will appear in your order history shortly.'
              : 'This usually takes a couple of seconds. Please do not close this page.'}
          </p>
          {gaveUp && (
            <Link to="/account/orders" className={`${link} mt-4 inline-block`}>
              Go to your orders
            </Link>
          )}
        </div>
      </Shell>
    );
  }

  if (state.status !== 'completed' || !state.order) {
    return (
      <Shell>
        <EmptyState
          title="This payment did not go through"
          hint={
            state.note ||
            'Nothing has been charged and your cart is untouched. You can try again whenever you like.'
          }
          action={
            <Link to="/checkout" className={link}>
              Back to checkout
            </Link>
          }
        />
      </Shell>
    );
  }

  return <Confirmed order={state.order} paid />;
}

/** The cash-on-delivery path: the order already exists. */
function DirectOrder({ id, stateOrder, isSignedIn }) {
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
      <Shell>
        <EmptyState
          title="We don't have this order's details anymore"
          hint="If you just placed it, you will find it in your order history."
          action={
            <Link to="/products" className={link}>
              Keep shopping
            </Link>
          }
        />
      </Shell>
    );
  }

  return <Confirmed order={order} paid={false} />;
}

function Shell({ children }) {
  return <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">{children}</div>;
}

function Confirmed({ order, paid }) {
  return (
    <Shell>
      <div className="animate-fade-rise text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-good-wash">
          <svg viewBox="0 0 20 20" className="h-6 w-6 fill-good-ink" aria-hidden="true">
            <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm4 6.2l-4.7 4.7a1 1 0 01-1.42 0L6 11.02l1.42-1.42 1.17 1.18 4-4L14 8.2z" />
          </svg>
        </div>

        <h1 className="font-display text-3xl font-semibold text-ink">Thank you for your order</h1>
        <p className="mt-2 text-sm text-ink-2">
          Order {orderLabel(order)}, placed {formatDate(order.createdAt)}.
        </p>
        <p className="mt-1 text-sm text-ink-2">
          {paid
            ? 'Your payment has been received.'
            : 'You will pay when the order is delivered.'}
        </p>
        <div className="mt-3 flex justify-center gap-2">
          <StatusBadge value={order.fulfilment || 'processing'} />
        </div>
      </div>

      <Card className="mt-8 p-5">
        <h2 className="mb-4 text-sm font-semibold text-ink">Where your order is</h2>
        <DeliveryTimeline order={order} />
      </Card>

      <Card className="mt-6 p-5">
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
                <td className={td}>
                  {item.product?.name || 'Product'}
                  {/* Which colour and size went out — otherwise a buyer with
                      two colours of one thing cannot tell the lines apart. */}
                  {item.variant && (
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
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
        <Link to="/products" className={link}>
          Keep shopping
        </Link>
        <Link to="/account/orders" className={link}>
          View your orders
        </Link>
      </div>
    </Shell>
  );
}
