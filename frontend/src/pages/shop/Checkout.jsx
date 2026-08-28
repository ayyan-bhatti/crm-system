import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useCart } from '../../context/CartContext';
import { shopCheckoutApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../../components/common';
import { btnPrimary, input, money } from '../../ui';

/** Demo payment methods — this storefront has no real payment processor behind it. */
const PAYMENT_METHODS = [
  { value: 'cod', label: 'Cash on delivery' },
  { value: 'card', label: 'Card (demo)' },
  { value: 'bank_transfer', label: 'Bank transfer (demo)' },
];

/**
 * Checkout requires a signed-in buyer.
 *
 * This used to also accept a guest checkout — add to cart without an
 * account, check out with a one-off name/email/address form — and the
 * backend endpoint still accepts that shape (see `shopCheckoutController`
 * and `attachBuyerIfPresent`). It was deliberately turned OFF here rather
 * than removed end-to-end: a guest can still browse and build a cart freely,
 * but reaching this page now always requires an account, matching the
 * product decision that buying — as opposed to browsing — is a signed-in
 * action. The cart itself is untouched and still guest-friendly right up to
 * this page.
 */
export default function Checkout() {
  const { buyer, isSignedIn, loading: authLoading } = useBuyerAuth();
  const { items, total, clear, loading: cartLoading } = useCart();
  const navigate = useNavigate();

  const [addressId, setAddressId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cod');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const addresses = buyer?.addresses || [];

  useEffect(() => {
    if (isSignedIn && addresses.length && !addressId) setAddressId(addresses[0]._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, buyer]);

  // `cartLoading` matters as much as `authLoading` here: a signed-in buyer's
  // server cart is only fetched AFTER the session check resolves (see
  // CartContext's merge effect), so there is a render in between where
  // `authLoading` is already false but the cart genuinely hasn't answered
  // yet. Without waiting on it too, that render's `items.length === 0`
  // reads as "empty cart" and bounces a buyer with a full cart straight to
  // the product grid — reproduced by Checkout.test.jsx's signed-in-buyer
  // cases, which failed here before this line was added.
  if (authLoading || cartLoading) return <Spinner full />;

  // Not signed in: send them to sign in (or create an account) and back here
  // once they have. The cart survives this round trip either way — a
  // guest's cart is in localStorage, and CartContext merges it into the
  // buyer's server cart the moment they sign in.
  if (!isSignedIn) {
    return <Navigate to="/login" replace state={{ from: '/checkout' }} />;
  }

  // Nothing to check out. Guarded on `submitting` so the redirect does not
  // fire the instant a successful submission clears the cart, ahead of the
  // navigation to the confirmation page that submission already triggered.
  if (items.length === 0 && !submitting) {
    return <Navigate to="/products" replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (!addressId) {
      setError('Add a delivery address before checking out.');
      return;
    }

    setSubmitting(true);

    try {
      const payload = items.map((line) => ({ product: line.product._id, quantity: line.quantity }));
      const order = await shopCheckoutApi.checkout(payload, undefined, addressId, paymentMethod);

      clear();
      navigate(`/order-confirmation/${order._id}`, { state: { order } });
    } catch (err) {
      setError(errorMessage(err, 'Could not place your order'));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="font-display mb-6 text-3xl font-semibold text-ink">Checkout</h1>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card className="p-6">
            <ErrorBanner message={error} />

            <form onSubmit={handleSubmit} noValidate className="space-y-5">
              <SavedAddresses addresses={addresses} addressId={addressId} onChange={setAddressId} />

              <Field
                label="Payment method"
                required
                hint="This is a demo storefront — nothing is actually charged."
              >
                <select
                  className={input}
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                >
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method.value} value={method.value}>
                      {method.label}
                    </option>
                  ))}
                </select>
              </Field>

              <button type="submit" className={`${btnPrimary} w-full`} disabled={submitting}>
                {submitting ? <Spinner /> : `Place order — ${money(total)}`}
              </button>
            </form>
          </Card>
        </div>

        <OrderSummary items={items} total={total} />
      </div>
    </div>
  );
}

/**
 * A signed-in buyer's saved addresses. Checkout REQUIRES one to be selected
 * rather than relying on the backend's "use the first address" default —
 * with zero saved addresses there is nothing for that default to fall back
 * to, so the UI has to be the one that insists.
 */
function SavedAddresses({ addresses, addressId, onChange }) {
  if (addresses.length === 0) {
    return (
      <div className="rounded-lg border border-hairline bg-plane p-4 text-sm text-ink-2">
        You have no saved addresses yet.{' '}
        <Link to="/account/addresses" className="font-medium text-brand hover:underline">
          Add one
        </Link>{' '}
        before checking out.
      </div>
    );
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-semibold text-ink">Deliver to</legend>
      {addresses.map((addr) => (
        <label
          key={addr._id}
          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm transition-colors ${
            addressId === addr._id ? 'border-brand bg-brand-wash/40' : 'border-hairline'
          }`}
        >
          <input
            type="radio"
            name="addressId"
            className="mt-1"
            checked={addressId === addr._id}
            onChange={() => onChange(addr._id)}
          />
          <span>
            <span className="block font-medium text-ink">{addr.label}</span>
            <span className="block text-ink-2">{addr.address}</span>
            {addr.phone && <span className="block text-xs text-muted">{addr.phone}</span>}
          </span>
        </label>
      ))}
      <Link to="/account/addresses" className="inline-block text-sm text-brand hover:underline">
        Manage addresses
      </Link>
    </fieldset>
  );
}

function OrderSummary({ items, total }) {
  return (
    <Card className="h-fit p-6">
      <h2 className="mb-4 text-sm font-semibold text-ink">Order summary</h2>
      <ul className="space-y-3">
        {items.map((line) => (
          <li key={line.product._id} className="flex justify-between gap-3 text-sm">
            <span className="text-ink-2">
              {line.product.name} <span className="text-muted">× {line.quantity}</span>
            </span>
            <span className="shrink-0 font-medium text-ink tabular">
              {money(line.product.price * line.quantity)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-between border-t border-hairline pt-4 text-sm font-semibold text-ink">
        <span>Total</span>
        <span className="tabular">{money(total)}</span>
      </div>
    </Card>
  );
}
