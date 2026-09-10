import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useBuyerAuth } from '../../context/BuyerAuthContext';
import { useCart, lineKey } from '../../context/CartContext';
import { shopCheckoutApi, shopAuthApi } from '../../api/shopResources';
import { errorMessage } from '../../api/client';
import { Button, Card, ErrorBanner, Field, Spinner } from '../../components/common';
import ConsentCheckboxes from '../../components/ConsentCheckboxes';
import { formatDate, galleryFor, money, variantLabel } from '../../ui';
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
 *
 * THE LAYOUT IS THE ARGUMENT. Three numbered sections down the left — where it
 * goes, how fast, how it is paid for — and the summary pinned beside them on a
 * wide screen so the total never scrolls out of sight while somebody is making
 * up their mind. On a phone the summary sits first, collapsed to a total, so
 * the first thing on screen is the number being agreed to rather than a list
 * to scroll past.
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
  const [deliveryOptions, setDeliveryOptions] = useState([]);
  const [deliverySpeed, setDeliverySpeed] = useState('standard');
  const [marketingChannels, setMarketingChannels] = useState([]);
  const [consent, setConsent] = useState({});
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
        if (config?.deliveryOptions?.length) setDeliveryOptions(config.deliveryOptions);
        if (config?.marketingChannels?.length) setMarketingChannels(config.marketingChannels);
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

      const result = await shopCheckoutApi.checkout(
        payload,
        addressId,
        paymentMethod,
        deliverySpeed,
        consent
      );

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

  const payingByCard = paymentMethod === 'card';

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <p className="label-mono">Secure checkout</p>
      <h1 className="font-display mt-2 text-[32px] leading-tight text-ink sm:text-[36px]">
        Checkout
      </h1>

      <div className="mt-8 grid gap-8 lg:mt-12 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-12">
        {/*
          The summary comes FIRST in source order and is moved to the right
          column from `lg` up. On a phone that puts the total — the thing being
          agreed to — above the form rather than at the bottom of it, and it
          means the DOM order matches the reading order on the narrow layout,
          which is the one that matters for a screen reader.
        */}
        <OrderSummary items={items} total={total} className="lg:order-2 lg:sticky lg:top-24" />

        <div className="lg:order-1">
          {cancelledByStripe && (
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-hairline bg-sunken px-4 py-3.5 text-sm text-ink-2">
              <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 fill-muted" aria-hidden="true">
                <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm1 4v5H9V6zm0 7v2H9v-2z" />
              </svg>
              <span>
                You came back without paying, so nothing has been charged and your cart is exactly
                as you left it.
              </span>
            </div>
          )}

          <ErrorBanner message={error} onDismiss={() => setError('')} />

          <form onSubmit={handleSubmit} noValidate className="space-y-10">
            <Section step={1} title="Where it goes">
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
            </Section>

            {/*
              How fast, asked BEFORE how they are paying.
              The order matters: the delivery date is part of what a shopper
              is deciding to buy, and burying it after the payment method
              makes it read as an afterthought to a decision already made.
            */}
            {deliveryOptions.length > 1 && (
              <Section step={2} title="How fast">
                <fieldset>
                  <legend className="sr-only">Delivery speed (required)</legend>

                  <div className="space-y-2.5">
                    {deliveryOptions.map((option) => {
                      const selected = deliverySpeed === option.value;
                      return (
                        <label
                          key={option.value}
                          className={`flex cursor-pointer items-start gap-3.5 rounded-xl border p-4 text-sm transition-colors ${
                            selected
                              ? 'border-brand bg-brand-wash/50'
                              : 'border-hairline bg-surface hover:border-rule hover:bg-plane'
                          }`}
                        >
                          <input
                            type="radio"
                            name="deliverySpeed"
                            className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
                            checked={selected}
                            onChange={() => setDeliverySpeed(option.value)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-baseline justify-between gap-2">
                              <span className="font-semibold text-ink">{option.label}</span>
                              {/*
                                The DATE, not the day count. "Arrives in 3–5
                                working days" asks the shopper to do arithmetic
                                against a calendar they cannot see; a date is
                                the thing they are actually choosing between.
                              */}
                              {option.estimatedDate && (
                                <span className="text-xs font-medium text-ink-2 tabular">
                                  {formatDate(option.estimatedDate)}
                                </span>
                              )}
                            </span>
                            <span className="mt-1 block text-xs leading-relaxed text-muted">
                              {option.hint}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </Section>
            )}

            <Section step={deliveryOptions.length > 1 ? 3 : 2} title="How you pay">
              <fieldset>
                <legend className="sr-only">Payment method (required)</legend>

                <div className="space-y-2.5">
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
                        className={`flex items-start gap-3.5 rounded-xl border p-4 text-sm transition-colors ${
                          disabled
                            ? 'cursor-not-allowed border-dashed border-rule bg-sunken/70'
                            : selected
                              ? 'cursor-pointer border-brand bg-brand-wash/50'
                              : 'cursor-pointer border-hairline bg-surface hover:border-rule hover:bg-plane'
                        }`}
                      >
                        <input
                          type="radio"
                          name="paymentMethod"
                          className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
                          checked={selected}
                          disabled={disabled}
                          onChange={() => setPaymentMethod(method.value)}
                        />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2">
                            <span
                              className={`font-semibold ${disabled ? 'text-muted' : 'text-ink'}`}
                            >
                              {method.label}
                            </span>
                            {disabled && (
                              <span className="rounded-full border border-rule px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                Unavailable
                              </span>
                            )}
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-muted">
                            {disabled ? method.unavailableReason || method.hint : method.hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            </Section>

            {/*
              MARKETING CONSENT AT CHECKOUT.

              Below the payment method and above the button, deliberately —
              it is the least important thing on this page and must not sit
              between a shopper and paying. Every box starts unchecked and
              nothing here can block the order.

              Shown only once the server has told us which channels exist,
              rather than from a hard-coded list, for the same reason the
              payment methods are: a capability the server owns has to be
              published by the server.
            */}
            {marketingChannels.length > 0 && (
              <ConsentCheckboxes
                legend="Keep in touch (optional)"
                hint="Nothing to do with this order — you will get your confirmation and delivery updates either way."
                channels={marketingChannels}
                value={consent}
                onChange={setConsent}
                disabled={submitting}
              />
            )}

            <div className="space-y-3 border-t border-hairline pt-8">
              {/*
                Disabled until a payment method is actually settled, which is a
                real state now rather than a theoretical one: the method list
                arrives from the server, so for the first tick there is no
                selection. Without this the button rendered "Place order" and
                then flipped to "Pay $20" a moment later — a label changing
                under somebody's cursor on the button that takes their money.
              */}
              <Button
                type="submit"
                size="lg"
                className="w-full"
                loading={submitting}
                loadingLabel={payingByCard ? 'Taking you to Stripe…' : 'Placing order…'}
                disabled={!addressId || !paymentMethod}
              >
                {!paymentMethod
                  ? 'Loading payment options…'
                  : payingByCard
                    ? `Pay ${money(total)}`
                    : `Place order — ${money(total)}`}
              </Button>

              <p className="text-center text-xs leading-relaxed text-muted">
                {payingByCard
                  ? 'You will be taken to Stripe to complete payment. Your order is created once the payment is confirmed.'
                  : 'You can ask to change or cancel your order while it is still being prepared.'}
              </p>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * One numbered step of the form.
 *
 * The number is decorative and marked `aria-hidden` — the heading already
 * carries the section's name, and "1 Where it goes" read aloud is a worse
 * sentence than "Where it goes". What the numbers do for a sighted reader is
 * turn three stacked cards into a sequence with an end, which is the single
 * cheapest thing a checkout can do about the feeling that it will never finish.
 */
function Section({ step, title, children }) {
  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-rule text-xs font-semibold text-ink-2"
        >
          {step}
        </span>
        <h2 className="font-display text-[22px] leading-none text-ink">{title}</h2>
      </div>
      {children}
    </section>
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
      <div className="rounded-xl border border-dashed border-rule bg-sunken/60 px-4 py-5 text-sm text-ink-2">
        <p className="font-semibold text-ink">You have no saved addresses yet.</p>
        <p className="mt-1">We need somewhere to send this before you can check out.</p>
        <button
          type="button"
          onClick={onAdd}
          className="mt-3 font-semibold text-brand-ink underline underline-offset-[3px] hover:text-ink"
        >
          Add a delivery address
        </button>
      </div>
    );
  }

  return (
    <fieldset>
      <legend className="sr-only">Deliver to (required)</legend>

      <div className="space-y-2.5">
        {addresses.map((addr) => {
          const selected = addressId === addr._id;
          return (
            <label
              key={addr._id}
              className={`flex cursor-pointer items-start gap-3.5 rounded-xl border p-4 text-sm transition-colors ${
                selected
                  ? 'border-brand bg-brand-wash/50'
                  : 'border-hairline bg-surface hover:border-rule hover:bg-plane'
              }`}
            >
              <input
                type="radio"
                name="addressId"
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
                checked={selected}
                onChange={() => onChange(addr._id)}
              />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">{addr.label}</span>
                <span className="mt-0.5 block text-ink-2">{addr.address}</span>
                {addr.city && <span className="block text-ink-2">{addr.city}</span>}
                {addr.phone && <span className="mt-0.5 block text-xs text-muted">{addr.phone}</span>}
              </span>
            </label>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="mt-3.5 text-sm font-semibold text-brand-ink underline underline-offset-[3px] hover:text-ink"
      >
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
    <div className="mt-4 space-y-5 rounded-xl border border-hairline bg-plane p-5">
      <h3 className="text-sm font-semibold text-ink">New delivery address</h3>

      <ErrorBanner message={failed} />

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Address name"
          name="label"
          required
          placeholder="Home"
          hint="What to call it later — Home, Office, Mum's."
          value={form.label}
          error={errors.label}
          onChange={(e) => update('label', e.target.value)}
        />

        <Field
          label="Phone number"
          name="phone"
          type="tel"
          autoComplete="tel"
          required
          placeholder="0300 1234567"
          hint="The courier calls this number on the day of delivery."
          value={form.phone}
          error={errors.phone}
          onChange={(e) => update('phone', e.target.value)}
        />

        <div className="sm:col-span-2">
          <Field
            label="Street address"
            name="address"
            autoComplete="street-address"
            required
            placeholder="12 Canal Road"
            hint="Flat or house number and street."
            value={form.address}
            error={errors.address}
            onChange={(e) => update('address', e.target.value)}
          />
        </div>

        <Field
          label="City"
          name="city"
          autoComplete="address-level2"
          required
          placeholder="Lahore"
          hint="The town or city the courier delivers to."
          value={form.city}
          error={errors.city}
          onChange={(e) => update('city', e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2.5">
        <Button type="button" onClick={handleSave} loading={saving} loadingLabel="Saving…">
          Save address
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * What is being bought, and for how much.
 *
 * ONE COPY IN THE DOM, TWO BEHAVIOURS. From `lg` the item list is always open
 * beside the form; below it the list collapses behind a toggle so the total
 * stays at the top of a phone screen without a scroll. Rendering a separate
 * mobile summary would have been simpler and is wrong twice over: a screen
 * reader would meet every line item twice, and the two copies would drift.
 */
function OrderSummary({ items, total, className = '' }) {
  const [openOnMobile, setOpenOnMobile] = useState(false);
  const count = items.reduce((sum, line) => sum + line.quantity, 0);

  return (
    <Card className={`h-fit ${className}`}>
      <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
        <h2 className="font-display text-[22px] leading-none text-ink">Order summary</h2>
        <span className="text-xs text-muted">
          {count} {count === 1 ? 'item' : 'items'}
        </span>
      </div>

      <button
        type="button"
        onClick={() => setOpenOnMobile((open) => !open)}
        aria-expanded={openOnMobile}
        aria-controls="checkout-summary-items"
        className="mt-3 flex w-full items-center justify-between gap-2 border-t border-hairline px-5 py-3 text-sm font-medium text-ink-2 transition-colors hover:bg-plane focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:hidden"
      >
        {openOnMobile ? 'Hide items' : 'Show items'}
        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 fill-muted transition-transform ${openOnMobile ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="M5.6 7.5L10 11.9l4.4-4.4 1.4 1.4-5.8 5.8-5.8-5.8z" />
        </svg>
      </button>

      <ul
        id="checkout-summary-items"
        className={`space-y-4 border-t border-hairline px-5 py-5 lg:block ${
          openOnMobile ? 'block' : 'hidden'
        }`}
      >
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
              className="flex items-start gap-3.5 text-sm"
            >
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-hairline bg-neutral-wash">
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
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
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
                <p className="mt-1 text-xs text-muted">Qty {line.quantity}</p>
              </div>

              <span className="shrink-0 font-medium text-ink tabular">
                {money(line.product.price * line.quantity)}
              </span>
            </li>
          );
        })}
      </ul>

      <dl className="space-y-2 border-t border-hairline px-5 py-5 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-2">Subtotal</dt>
          <dd className="font-medium text-ink tabular">{money(total)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-2">Delivery</dt>
          <dd className="text-ink-2">Calculated at dispatch</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-hairline pt-3">
          <dt className="font-semibold text-ink">Total</dt>
          <dd className="font-display text-[22px] leading-none text-ink tabular">{money(total)}</dd>
        </div>
      </dl>
    </Card>
  );
}
