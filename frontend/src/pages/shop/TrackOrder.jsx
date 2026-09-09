import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { trackingApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { Card, ErrorBanner, Field, Spinner, StatusBadge } from '../../components/common';
import DeliveryTimeline from '../../components/DeliveryTimeline';
import CourierTrackingInfo from '../../components/CourierTrackingInfo';
import { btnPrimary, formatDate, input, link } from '../../ui';

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
 */
export default function TrackOrder() {
  const { isSignedIn, loading: authLoading } = useBuyerAuth();
  const [form, setForm] = useState({ orderNumber: '', email: '' });
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
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

  if (authLoading) return <Spinner full />;

  return (
    <div className="mx-auto max-w-xl space-y-6 px-4 py-10 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Track your order</h1>
        <p className="mt-1 text-sm text-ink-2">
          {isSignedIn
            ? 'Your orders and their delivery status are in your account.'
            : 'Enter your order number and the email you used to place it.'}
        </p>
      </div>

      {isSignedIn ? (
        <Card className="p-5">
          <p className="text-sm text-ink-2">
            You&apos;re signed in, so there&apos;s no need to look an order up by email — every
            order you&apos;ve placed, and its delivery status, is already in your order history.
          </p>
          <Link to="/account/orders" className={`${link} mt-3 inline-block text-sm font-medium`}>
            Go to your orders
          </Link>
        </Card>
      ) : (
        <Card className="p-5">
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <Field
              label="Order number"
              required
              hint="e.g. ORD-000142 — on your confirmation email."
            >
              <input
                type="text"
                className={input}
                value={form.orderNumber}
                onChange={(e) => setForm({ ...form, orderNumber: e.target.value })}
                placeholder="ORD-000142"
              />
            </Field>

            <Field label="Email" required>
              <input
                type="email"
                className={input}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="you@example.com"
              />
            </Field>

            {error && <ErrorBanner message={error} />}

            <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
              {submitting ? <Spinner /> : 'Track order'}
            </button>
          </form>
        </Card>
      )}

      {result && (
        <Card className="p-5">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Order</p>
              <p className="text-lg font-semibold text-ink">{result.orderNumber}</p>
              <p className="text-xs text-muted">
                Placed {formatDate(result.createdAt)} · {result.itemCount} item
                {result.itemCount === 1 ? '' : 's'}
              </p>
            </div>
            <StatusBadge value={result.fulfilment} />
          </div>

          <DeliveryTimeline order={result} />
          <CourierTrackingInfo order={result} />
        </Card>
      )}
    </div>
  );
}
