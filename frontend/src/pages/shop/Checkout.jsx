import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useCart, lineKey } from '../../context/CartContext';
import { shopCheckoutApi, shopAuthApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { Card, ErrorBanner, Field, Spinner } from '../../components/common';
import { btnPrimary, btnSecondary, galleryFor, money, variantLabel } from '../../ui';
import ProductImage from '../../components/shop/ProductImage';

/**
 * What to show before `GET /api/shop/config` answers.
 *
 * THE LIST USED TO BE HARD-CODED HERE, and that was a real bug rather than an
 * untidiness. Whether this deployment can take a card is a fact only the server
 * knows — it depends on `STRIPE_SECRET_KEY` — and this page asserted it instead,
 * offering "Pay by card" as the PRE-SELECTED default on a store with no Stripe
 * key at all. The buyer picked an address, pressed Pay, and got a red banner
 * telling them to choose something else. On the one screen where a shop must
 * not look broken.
 *
 * So the real list comes from the server now, and this is only the shape used
 * while that request is in flight. `available: false` on card is the safe way
 * round: if the config call never returns, the page offers the methods that
 * always work rather than the one that might not.
 */
const FALLBACK_PAYMENT_METHODS = [
  {
    value: 'card',
    label: 'Pay by card',
    hint: 'You will be taken to Stripe to pay securely. Your card details never reach this site.',
    available: false,
    unavailableReason: 'Checking availability…',
  },
  {
    value: 'cod',
    label: 'Cash on delivery',
    hint: 'Pay the courier when your order arrives.',
    available: true,
  },
  {
    value: 'bank_transfer',
    label: 'Bank transfer',
    hint: 'We will send you account details once the order is confirmed.',
    available: true,
  },
];

/**
 * Checkout. REQUIRES A SIGNED-IN BUYER — there is no guest path.
 *
 * This reverses the round-1 decision, and the reversal is enforced on the
 * server (the route runs `protectBuyer`, and the middleware that used to admit
 * an anonymous caller has been deleted). What is here is the front half: a
 * visitor who reaches this page without an account is sent to sign in and
 * brought straight back, with their cart intact — a guest cart lives in
 * localStorage and is merged into the buyer's server cart the moment they sign
 * in, so nothing is lost across the round trip.
 *
 * TWO PATHS OUT OF SUBMIT, AND THEY END IN DIFFERENT PLACES
 *
 *   card   the server creates NO order. It returns a Stripe URL and this page
 *          hands the browser over to it. The order is created later, by the
 *          webhook, only if the money actually arrives.
 *   others the order is created immediately and we go to the confirmation page.
 *
 * `mode` on the response is what distinguishes them — deliberately an explicit
 * field rather than something inferred from the shape of `data`.
 */
export default function Checkout() {
  const { buyer, isSignedIn, loading: authLoading, refresh } = useBuyerAuth();
  const { items, total, clear, loading: cartLoading } = useCart();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [addressId, setAddressId] = useState('');
  const [paymentMethods, setPaymentMethods] = useState(FALLBACK_PAYMENT_METHODS);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [configResolved, setConfigResolved] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [addingAddress, setAddingAddress] = useState(false);

  const addresses = buyer?.addresses || [];

  useEffect(() => {
    if (isSignedIn && addresses.length && !addressId) setAddressId(addresses[0]._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, buyer]);

  /*
   * Ask the server what it can actually take.
   *
   * A failure here is deliberately swallowed rather than shown: the fallback
   * list already offers the two methods that need no configuration, so a
   * shopper can still complete an order. Turning a config hiccup into a red
   * banner on the checkout page would block a sale this page is perfectly
   * capable of taking.
   */
  useEffect(() => {
    let cancelled = false;
    shopCheckoutApi
      .config()
      .then((config) => {
        if (cancelled) return;
        if (config?.paymentMethods?.length) setPaymentMethods(config.paymentMethods);
      })
      .catch(() => {})
      /*
       * Resolved either way. A failed config call must still let the page pick
       * a default from the fallback list — otherwise a config hiccup leaves the
       * submit button stuck on "Loading payment options…" forever and blocks a
       * sale this page is perfectly capable of taking.
       */
      .finally(() => {
        if (!cancelled) setConfigResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * The default is the first method that WORKS — and it is chosen only once the
   * REAL list has arrived, which is what `configResolved` gates.
   *
   * Selecting from the fallback list on mount looked equivalent and was not:
   * card is marked unavailable there (deliberately, so a config failure cannot
   * offer a dead option), so the selection landed on cash on delivery, and when
   * the real config then arrived saying card was fine, the "keep the current
   * choice if it is still valid" rule below kept cash — because cash was still
   * valid. A store with Stripe configured quietly stopped defaulting to card,
   * and nothing about that looked like a bug from the outside.
   *
   * The keep-if-valid rule itself stays: once the shopper has picked something,
   * a late-arriving config must not move it under them.
   */
  useEffect(() => {
    if (!configResolved) return;
    const usable = paymentMethods.filter((method) => method.available);
    if (!usable.length) return;
    setPaymentMethod((current) =>
      usable.some((method) => method.value === current) ? current : usable[0].value
    );
  }, [paymentMethods, configResolved]);

  /*
   * Stripe sends a buyer who abandons the card form back here with `?cancelled=1`.
   * Saying so plainly matters: their cart is untouched and nothing was charged,
   * and without a word of explanation a shopper who backed out of a payment
   * page assumes something went wrong.
   */
  const cancelledByStripe = params.get('cancelled') === '1';

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
  // once they have.
  if (!isSignedIn) {
    return <Navigate to="/login" replace state={{ from: '/checkout' }} />;
  }

  // Nothing to check out. Guarded on `submitting` so the redirect does not
  // fire the instant a successful submission clears the cart, ahead of the
  // navigation that submission already triggered.
  if (items.length === 0 && !submitting) {
    return <Navigate to="/products" replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');

    if (!addressId) {
      setError('Choose a delivery address before checking out.');
      return;
    }

    setSubmitting(true);

    try {
      const payload = items.map((line) => ({
        product: line.product._id,
        quantity: line.quantity,
        variantId: line.variant?.variantId || null,
      }));

      const result = await shopCheckoutApi.checkout(payload, addressId, paymentMethod);

      if (result.mode === 'stripe') {
        /*
         * `window.location.assign`, not `navigate`. Stripe's hosted checkout is
         * a different origin, so this is a full page load out of the app —
         * react-router cannot express that, and trying would simply render a
         * 404 route for a URL that is not ours.
         *
         * The cart is deliberately NOT cleared here. No order exists yet; if
         * the buyer closes the tab at the card form, they must come back to a
         * full cart rather than an empty one and a payment that never happened.
         * The webhook clears it, once, when the order is genuinely created.
         */
        window.location.assign(result.data.checkoutUrl);
        return;
      }

      clear();
      navigate(`/order-confirmation/${result.data._id}`, { state: { order: result.data } });
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
            {cancelledByStripe && (
              <div className="mb-4 rounded-lg border border-hairline bg-plane px-4 py-3 text-sm text-ink-2">
                You came back without paying, so nothing has been charged and your cart is
                exactly as you left it.
              </div>
            )}

            <ErrorBanner message={error} />

            <form onSubmit={handleSubmit} noValidate className="space-y-6">
              <SavedAddresses
                addresses={addresses}
                addressId={addressId}
                onChange={setAddressId}
                onAdd={() => setAddingAddress(true)}
              />

              {addingAddress && (
                <NewAddressForm
                  onCancel={() => setAddingAddress(false)}
                  onSaved={async (saved) => {
                    await refresh();
                    setAddressId(saved._id);
                    setAddingAddress(false);
                  }}
                />
              )}

              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink">
                  Payment method
                  <span className="ml-1 text-critical-ink" aria-hidden="true">
                    *
                  </span>
                  <span className="sr-only"> (Required)</span>
                </legend>

                <div className="space-y-2">
                  {paymentMethods.map((method) => {
                    const disabled = !method.available;
                    const selected = paymentMethod === method.value;

                    /*
                     * An unavailable method is shown and disabled rather than
                     * hidden, for the same reason a sold-out size is: "we don't
                     * take cards" and "we take cards, not right now" are
                     * different facts, and removing the row silently asserts
                     * the first. The reason is spelled out in place, so nobody
                     * has to press the button to find out.
                     */
                    return (
                      <label
                        key={method.value}
                        className={`flex items-start gap-3 rounded-xl border p-3.5 text-sm transition-all ${
                          disabled
                            ? 'cursor-not-allowed border-hairline bg-neutral-wash/60 opacity-70'
                            : selected
                              ? 'cursor-pointer border-brand bg-brand-wash/40 ring-1 ring-brand/20'
                              : 'cursor-pointer border-hairline hover:border-rule hover:bg-plane/60'
                        }`}
                      >
                        <input
                          type="radio"
                          name="paymentMethod"
                          className="mt-1 accent-[var(--color-brand)]"
                          checked={selected}
                          disabled={disabled}
                          onChange={() => setPaymentMethod(method.value)}
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-ink">{method.label}</span>
                            {disabled && (
                              <span className="rounded-full border border-hairline bg-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                                Unavailable
                              </span>
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted">
                            {disabled ? method.unavailableReason || method.hint : method.hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {/*
                Disabled until a payment method is actually settled, which is a
                real state now rather than a theoretical one: the method list
                arrives from the server, so for the first tick there is no
                selection. Without this the button rendered "Place order" and
                then flipped to "Pay $20" a moment later — a label changing
                under somebody's cursor on the button that takes their money.
              */}
              <button
                type="submit"
                className={`${btnPrimary} w-full py-2.5`}
                disabled={submitting || !addressId || !paymentMethod}
              >
                {submitting ? (
                  <Spinner />
                ) : !paymentMethod ? (
                  'Loading payment options…'
                ) : paymentMethod === 'card' ? (
                  `Pay ${money(total)}`
                ) : (
                  `Place order — ${money(total)}`
                )}
              </button>

              {paymentMethod === 'card' && (
                <p className="text-center text-xs text-muted">
                  You will be taken to Stripe to complete payment. Your order is created once the
                  payment is confirmed.
                </p>
              )}
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
 * rather than relying on a "use the first address" default — the server used
 * to fall back to `addresses[0]`, and with several saved addresses that is a
 * parcel sent to somebody's previous flat.
 */
function SavedAddresses({ addresses, addressId, onChange, onAdd }) {
  if (addresses.length === 0) {
    return (
      <div className="rounded-lg border border-hairline bg-plane p-4 text-sm text-ink-2">
        You have no saved addresses yet.{' '}
        <button type="button" onClick={onAdd} className="font-medium text-brand hover:underline">
          Add one
        </button>{' '}
        to continue.
      </div>
    );
  }

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-medium text-ink">
        Deliver to
        <span className="ml-1 text-critical-ink" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (Required)</span>
      </legend>

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
            <span className="block text-ink-2">
              {addr.address}
              {addr.city ? `, ${addr.city}` : ''}
            </span>
            {addr.phone && <span className="block text-xs text-muted">{addr.phone}</span>}
          </span>
        </label>
      ))}

      <button type="button" onClick={onAdd} className="text-sm text-brand hover:underline">
        Add another address
      </button>
    </fieldset>
  );
}

/**
 * Adding a delivery address without leaving checkout.
 *
 * Every field is marked and hinted, per the round-3 rule for new forms. The
 * hints are format hints rather than restatements of the label — "Flat, house
 * number and street" tells someone what to type; "Your address" does not.
 */
function NewAddressForm({ onCancel, onSaved }) {
  const [form, setForm] = useState({ label: '', address: '', city: '', phone: '' });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState('');

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  /** Inline validation before submit, so the server round trip is the last resort. */
  function validate() {
    const next = {};
    if (!form.label.trim()) next.label = 'Give this address a name, e.g. Home.';
    if (!form.address.trim()) next.address = 'Enter the street address.';
    if (!form.city.trim()) next.city = 'Enter the city.';
    if (!form.phone.trim()) next.phone = 'A phone number lets the courier reach you.';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSave(event) {
    // Nested inside checkout's own form is not allowed, so this is a click
    // handler on a button rather than a submit — a nested <form> is invalid
    // HTML and the inner one is simply dropped by the parser.
    event.preventDefault();
    setFailed('');
    if (!validate()) return;

    setSaving(true);
    try {
      const updated = await shopAuthApi.addAddress(form);
      onSaved(updated[updated.length - 1]);
    } catch (err) {
      setFailed(errorMessage(err, 'Could not save that address'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-hairline bg-plane p-4">
      <p className="text-sm font-semibold text-ink">New delivery address</p>

      <ErrorBanner message={failed} />

      <Field
        label="Address name"
        name="label"
        required
        hint="What to call it later — Home, Office, Mum's."
        value={form.label}
        error={errors.label}
        onChange={(e) => update('label', e.target.value)}
      />

      <Field
        label="Street address"
        name="address"
        required
        hint="Flat or house number and street, e.g. 12 Canal Road."
        value={form.address}
        error={errors.address}
        onChange={(e) => update('address', e.target.value)}
      />

      <Field
        label="City"
        name="city"
        required
        hint="The town or city the courier delivers to."
        value={form.city}
        error={errors.city}
        onChange={(e) => update('city', e.target.value)}
      />

      <Field
        label="Phone number"
        name="phone"
        required
        hint="The courier calls this number on the day of delivery."
        value={form.phone}
        error={errors.phone}
        onChange={(e) => update('phone', e.target.value)}
      />

      <div className="flex gap-2">
        <button type="button" className={btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? <Spinner /> : 'Save address'}
        </button>
        <button type="button" className={btnSecondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function OrderSummary({ items, total }) {
  return (
    <Card className="h-fit p-6">
      <h2 className="mb-4 text-sm font-semibold text-ink">Order summary</h2>
      <ul className="space-y-3">
        {items.map((line) => {
          const label = variantLabel(line.variant);
          return (
            /*
              The picture belongs here as much as anywhere. This is the last
              screen before somebody pays, and a wall of product NAMES asks them
              to verify their order by reading rather than by recognising —
              which is how the wrong colour gets bought. The cart drawer already
              showed thumbnails; the page that takes the money did not.
            */
            <li
              key={lineKey(line.product._id, line.variant?.variantId)}
              className="flex items-start gap-3 text-sm"
            >
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-hairline bg-neutral-wash">
                <ProductImage
                  product={line.product}
                  src={galleryFor(line.product)[0]}
                  alt=""
                  className="h-full w-full object-cover"
                />
              </div>

              <div className="min-w-0 flex-1">
                <p className="font-medium leading-snug text-ink">{line.product.name}</p>
                {label && (
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                    {line.variant?.colorHex && (
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-inset ring-ink/15"
                        style={{ backgroundColor: line.variant.colorHex }}
                      />
                    )}
                    {label}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted">Qty {line.quantity}</p>
              </div>

              <span className="shrink-0 font-medium text-ink tabular">
                {money(line.product.price * line.quantity)}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex justify-between border-t border-hairline pt-4 text-sm font-semibold text-ink">
        <span>Total</span>
        <span className="tabular">{money(total)}</span>
      </div>
    </Card>
  );
}
