import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useCart } from '../../context/CartContext';
import { shopCheckoutApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../../components/common';
import { btnPrimary, money } from '../../ui';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** Client-side hints only — the server is still the real authority on both. */
function validateGuest(guest) {
  const errors = {};
  if (!guest.name.trim()) errors.name = 'Enter your name.';
  if (!EMAIL_RE.test(guest.email)) errors.email = 'Enter a valid email address.';
  if (!guest.address.trim()) errors.address = 'Enter a delivery address.';
  return errors;
}

export default function Checkout() {
  const { buyer, isSignedIn, loading: authLoading } = useBuyerAuth();
  const { items, total, clear, loading: cartLoading } = useCart();
  const navigate = useNavigate();

  const [guest, setGuest] = useState({ name: '', email: '', phone: '', address: '', city: '' });
  const [touched, setTouched] = useState({});
  const [addressId, setAddressId] = useState('');
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

  // Nothing to check out. Guarded on `submitting` so the redirect does not
  // fire the instant a successful submission clears the cart, ahead of the
  // navigation to the confirmation page that submission already triggered.
  if (items.length === 0 && !submitting) {
    return <Navigate to="/shop/products" replace />;
  }

  const guestErrors = validateGuest(guest);

  function blur(field) {
    setTouched((t) => ({ ...t, [field]: true }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (!isSignedIn) {
      setTouched({ name: true, email: true, address: true });
      if (Object.keys(guestErrors).length) return;
    } else if (!addressId) {
      setError('Add a delivery address before checking out.');
      return;
    }

    setSubmitting(true);

    try {
      const payload = items.map((line) => ({ product: line.product._id, quantity: line.quantity }));
      const order = isSignedIn
        ? await shopCheckoutApi.checkout(payload, undefined, addressId)
        : await shopCheckoutApi.checkout(payload, guest);

      clear();
      navigate(`/shop/order-confirmation/${order._id}`, { state: { order } });
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
              {isSignedIn ? (
                <SavedAddresses
                  addresses={addresses}
                  addressId={addressId}
                  onChange={setAddressId}
                />
              ) : (
                <div className="space-y-4">
                  <h2 className="text-sm font-semibold text-ink">Delivery details</h2>
                  <Field
                    label="Name"
                    autoComplete="name"
                    required
                    value={guest.name}
                    onBlur={() => blur('name')}
                    onChange={(e) => setGuest({ ...guest, name: e.target.value })}
                    error={touched.name ? guestErrors.name : undefined}
                  />
                  <Field
                    label="Email"
                    type="email"
                    autoComplete="email"
                    required
                    hint="Used to send your order confirmation."
                    value={guest.email}
                    onBlur={() => blur('email')}
                    onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                    error={touched.email ? guestErrors.email : undefined}
                  />
                  <Field
                    label="Phone"
                    type="tel"
                    autoComplete="tel"
                    value={guest.phone}
                    onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
                  />
                  <Field
                    label="Address"
                    autoComplete="street-address"
                    required
                    value={guest.address}
                    onBlur={() => blur('address')}
                    onChange={(e) => setGuest({ ...guest, address: e.target.value })}
                    error={touched.address ? guestErrors.address : undefined}
                  />
                  <Field
                    label="City"
                    autoComplete="address-level2"
                    value={guest.city}
                    onChange={(e) => setGuest({ ...guest, city: e.target.value })}
                  />
                </div>
              )}

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
        <Link to="/shop/account/addresses" className="font-medium text-brand hover:underline">
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
      <Link to="/shop/account/addresses" className="inline-block text-sm text-brand hover:underline">
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
