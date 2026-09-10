import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import useFetch from '../../hooks/useFetch';
import { shopOrdersApi, shopCheckoutApi } from '../../api/shopResources';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useCart } from '../../context/CartContext';
import DeliveryTimeline from '../../components/DeliveryTimeline';
import {
  ButtonLink,
  Card,
  EmptyState,
  ErrorBanner,
  Spinner,
  StatusBadge,
} from '../../components/common';
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
        <div className="py-10 text-center">
          <Spinner full />
          <h1 className="font-display mt-2 text-[28px] leading-tight text-ink">
            Confirming your payment
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-2">
            {gaveUp
              ? 'This is taking longer than usual. Your payment has not been lost — the order will appear in your order history shortly.'
              : 'This usually takes a couple of seconds. Please do not close this page.'}
          </p>
          {gaveUp && (
            <ButtonLink to="/account/orders" variant="secondary" className="mt-6">
              Go to your orders
            </ButtonLink>
          )}
        </div>
      </Shell>
    );
  }

  if (state.status !== 'completed' || !state.order) {
    return (
      <Shell>
        <Card>
          <EmptyState
            title="This payment did not go through"
            hint={
              state.note ||
              'Nothing has been charged and your cart is untouched. You can try again whenever you like.'
            }
            action={<ButtonLink to="/checkout">Back to checkout</ButtonLink>}
          />
        </Card>
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
        <Card>
          <EmptyState
            title="We don't have this order's details anymore"
            hint="If you just placed it, you will find it in your order history."
            action={<ButtonLink to="/products">Keep shopping</ButtonLink>}
          />
        </Card>
      </Shell>
    );
  }

  return <Confirmed order={order} paid={false} />;
}

function Shell({ children }) {
  return <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">{children}</div>;
}

/**
 * What happens next, in three sentences.
 *
 * This is the part a confirmation page usually leaves out, and it is the part
 * the buyer is actually wondering about. "Thank you" answers a question nobody
 * asked; "we will email you when it ships" answers the one they have.
 */
function WhatHappensNext({ paid }) {
  const steps = [
    ['A confirmation email', 'On its way now, with everything on this page in it.'],
    ['We pack your order', 'You will get an email the moment it leaves the warehouse.'],
    [
      paid ? 'Delivery' : 'Pay on delivery',
      paid
        ? 'Track it from your order page at any point along the way.'
        : 'Have the exact amount ready for the courier when they arrive.',
    ],
  ];

  return (
    <Card className="mt-6 p-6">
      <h2 className="font-display text-[22px] leading-none text-ink">What happens next</h2>
      <ol className="mt-5 space-y-5">
        {steps.map(([title, detail], index) => (
          <li key={title} className="flex gap-4">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-rule text-xs font-semibold text-ink-2"
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Confirmed({ order, paid }) {
  return (
    <Shell>
      <div className="animate-fade-rise">
        <div className="text-center">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-good-wash">
            <svg viewBox="0 0 20 20" className="h-7 w-7 fill-good-ink" aria-hidden="true">
              <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm4 6.2l-4.7 4.7a1 1 0 01-1.42 0L6 11.02l1.42-1.42 1.17 1.18 4-4L14 8.2z" />
            </svg>
          </div>

          <p className="label-mono">Order confirmed</p>
          <h1 className="font-display mt-2 text-[34px] leading-tight text-ink sm:text-[40px]">
            Thank you for your order
          </h1>
          <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink-2">
            {paid
              ? 'Your payment has been received and we are getting your order ready.'
              : 'We are getting your order ready. You will pay the courier when it arrives.'}
          </p>
        </div>

        {/*
          The order number, given a line of its own rather than folded into a
          sentence. It is the one string on this page somebody will need again
          — quoted in an email, read down a phone line — and burying a reference
          mid-paragraph is how it gets mistyped.
        */}
        <dl className="mt-8 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3">
          <div className="bg-surface px-5 py-4">
            <dt className="label-mono">Order number</dt>
            <dd className="mt-1.5 text-sm font-semibold text-ink tabular">{orderLabel(order)}</dd>
          </div>
          <div className="bg-surface px-5 py-4">
            <dt className="label-mono">Placed</dt>
            <dd className="mt-1.5 text-sm font-semibold text-ink">{formatDate(order.createdAt)}</dd>
          </div>
          <div className="bg-surface px-5 py-4">
            <dt className="label-mono">Status</dt>
            <dd className="mt-1.5">
              <StatusBadge value={order.fulfilment || 'processing'} />
            </dd>
          </div>
        </dl>
      </div>

      <Card className="mt-6 p-6">
        <h2 className="font-display text-[22px] leading-none text-ink">Where your order is</h2>
        <div className="mt-6">
          <DeliveryTimeline order={order} />
        </div>
      </Card>

      <WhatHappensNext paid={paid} />

      <Card className="mt-6 overflow-hidden">
        <h2 className="px-6 pb-4 pt-6 font-display text-[22px] leading-none text-ink">
          Your items
        </h2>
        <div className="w-full overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="border-y border-hairline bg-plane">
              <tr>
                <th className={th}>Item</th>
                <th className={`${th} text-right`}>Qty</th>
                <th className={`${th} text-right`}>Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {order.items.map((item, index) => (
                <tr key={index}>
                  <td className={`${td} font-medium text-ink`}>
                    {item.product?.name || 'Product'}
                    {/* Which colour and size went out — otherwise a buyer with
                        two colours of one thing cannot tell the lines apart. */}
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
                  <td className={`${td} text-right tabular`}>{item.quantity}</td>
                  <td className={`${td} text-right tabular`}>
                    {money(item.priceAtOrder * item.quantity)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-hairline bg-plane">
                <td className={td} colSpan={2}>
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

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <ButtonLink to="/account/orders" size="lg">
          View your orders
        </ButtonLink>
        <ButtonLink to="/products" variant="secondary" size="lg">
          Keep shopping
        </ButtonLink>
      </div>
    </Shell>
  );
}
