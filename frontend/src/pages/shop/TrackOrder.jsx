import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { trackingApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import {
  Breadcrumb,
  Button,
  ErrorBanner,
  Field,
  Skeleton,
  StatusBadge,
  useFormValidation,
  validators,
} from '../../components/common';
import DeliveryTimeline from '../../components/DeliveryTimeline';
import CourierTrackingInfo from '../../components/CourierTrackingInfo';
import { formatDate, input } from '../../ui';

/**
 * The public "track my order" page — no sign-in REQUIRED, on purpose.
 *
 * A guest checkout never gets a buyer account at all, so gating tracking
 * behind a login would leave exactly the shopper most likely to need this
 * page unable to reach it. Order number + email is the two-factor lookup a
 * real courier's own tracking page uses (order/tracking number plus the name
 * or postcode on the parcel) — see `POST /api/shop/track` for why the two
 * are never distinguished in a failure. That check is unweakened here.
 *
 * A SIGNED-IN buyer is a different case: their own order history already
 * shows this same delivery information, keyed off an order they are already
 * authenticated to see — asking them to re-prove which email placed the
 * order is a second, worse lookup for something the app already knows. So a
 * signed-in visitor is pointed at their own history instead of the guest
 * lookup form, rather than the form asking for an email that is redundant.
 *
 * Deliberately thinner than the signed-in buyer's own order page: no items,
 * no prices, no address. This is a delivery status page, not a receipt.
 *
 * THE CLIENT-SIDE VALIDATION IS ABOUT SAVING A ROUND TRIP, NOT ABOUT TRUST.
 * The server still refuses a malformed lookup; what this adds is telling
 * somebody they have mistyped their address before they wait for a network
 * request to tell them the same thing in a vaguer way. `useFormValidation`
 * holds its tongue until a field has been blurred or the form submitted, so
 * nobody is shouted at mid-typing.
 */
const RULES = {
  orderNumber: validators.required('Order number'),
  email: validators.email,
};

export default function TrackOrder() {
  const { isSignedIn, loading: authLoading } = useBuyerAuth();
  const [form, setForm] = useState({ orderNumber: '', email: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);

  const errors = visibleErrors(form);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!validate(form)) return;

    setError('');
    setResult(null);
    setSubmitting(true);

    try {
      const data = await trackingApi.track(form.orderNumber, form.email);
      setResult(data);
    } catch (err) {
      setError(errorMessage(err, 'Could not find that order'));
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6 sm:py-16">
        <p role="status" className="sr-only">
          Loading
        </p>
        <div aria-hidden="true">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-4 h-11 w-3/4" />
          <Skeleton className="mt-8 h-48 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-14">
      <Breadcrumb
        items={[{ label: 'Home', to: '/' }, { label: 'Track an order' }]}
        className="mb-6"
      />

      <header>
        <p className="label-mono">Delivery</p>
        <h1 className="font-display mt-2 text-[34px] leading-[1.05] text-ink sm:text-[44px]">
          Track your order
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-2">
          {isSignedIn
            ? 'Your orders and their delivery status are already in your account — no lookup needed.'
            : 'Enter your order number and the email you used to place it. Both have to match the order, which is what stops anyone else looking it up.'}
        </p>
      </header>

      <div className="mt-10 border-t border-hairline pt-10">
        {isSignedIn ? (
          <div className="rounded-lg border border-hairline bg-surface p-7">
            <p className="text-sm leading-relaxed text-ink-2">
              You&apos;re signed in, so there&apos;s no need to look an order up by email — every
              order you&apos;ve placed, and its delivery status, is already in your order history.
            </p>
            <Link
              to="/account/orders"
              className="mt-4 inline-block text-sm font-semibold text-ink underline decoration-rule underline-offset-4 transition-colors hover:decoration-brand"
            >
              Go to your orders
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <Field
              label="Order number"
              required
              error={errors.orderNumber}
              hint="e.g. ORD-000142 — it is on your confirmation email."
            >
              <input
                type="text"
                className={input}
                value={form.orderNumber}
                onChange={(e) => setForm({ ...form, orderNumber: e.target.value })}
                onBlur={() => markTouched('orderNumber')}
                aria-invalid={errors.orderNumber ? true : undefined}
                placeholder="ORD-000142"
              />
            </Field>

            <Field label="Email address" required error={errors.email}>
              <input
                type="email"
                className={input}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                onBlur={() => markTouched('email')}
                aria-invalid={errors.email ? true : undefined}
                placeholder="you@example.com"
              />
            </Field>

            <ErrorBanner message={error} />

            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={submitting}
              loadingLabel="Looking it up…"
            >
              Track order
            </Button>
          </form>
        )}
      </div>

      {result && (
        <section className="mt-10 rounded-lg border border-hairline bg-surface p-6 sm:p-7">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-hairline pb-5">
            <div>
              <p className="label-mono">Order</p>
              <p className="font-display mt-1.5 text-[26px] leading-none text-ink">
                {result.orderNumber}
              </p>
              <p className="mt-2 text-xs text-muted">
                Placed {formatDate(result.createdAt)} · {result.itemCount} item
                {result.itemCount === 1 ? '' : 's'}
              </p>
            </div>
            <StatusBadge value={result.fulfilment} />
          </div>

          <DeliveryTimeline order={result} />
          <CourierTrackingInfo order={result} />
        </section>
      )}
    </div>
  );
}
