const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { componentLogger } = require('../config/logger');

const log = componentLogger('stripe');

/**
 * The one place this app talks to Stripe.
 *
 * SAME SHAPE AS `services/aiClient.js`, ON PURPOSE. That file is the only
 * module that knows Gemini exists; this is the only module that knows Stripe
 * does. Everything above it deals in "create a checkout session", "verify this
 * event", "refund this order" and has no idea which processor is behind them.
 * The payoff is not hypothetical portability — it is that the Stripe SDK can be
 * replaced by a stub in tests at exactly one seam, so no test ever needs a
 * network, an API key, or Stripe's own test servers.
 *
 * WHY THE CLIENT IS BUILT LAZILY
 *
 * `require('stripe')(key)` throws on an empty key. Building it at module load
 * would mean this file cannot be imported at all without Stripe configured —
 * and it is imported, transitively, by the checkout controller, which is
 * mounted on every boot. A deployment with no Stripe key would therefore fail
 * to start rather than simply not offering card payment, which is precisely the
 * "one unconfigured feature takes down the app" failure mode the Gemini seam
 * was written to avoid.
 */

/** Built on first use and reused; see above for why not at module load. */
let client = null;

/**
 * The Stripe SDK instance, or a thrown ApiError if payments are unconfigured.
 *
 * Callers that might legitimately run without Stripe should check
 * `isEnabled()` first rather than catching this.
 */
function getStripe() {
  if (!env.stripeSecretKey) {
    throw ApiError.badRequest(
      'Card payment is not available — this deployment has no Stripe key configured.'
    );
  }

  if (!client) {
    // Required here rather than at the top of the file so that a deployment
    // without the dependency installed still boots. See the note above.
    const Stripe = require('stripe');
    client = new Stripe(env.stripeSecretKey, {
      /*
       * Pinned rather than floating. An unpinned integration silently starts
       * receiving a different response shape the day Stripe ships a new API
       * version, which is a change to this app's behaviour made by somebody
       * else's release notes.
       */
      apiVersion: '2025-10-29.clover',
      /*
       * A payment is not a page load. Three retries on a network wobble is
       * cheap; failing a checkout the buyer is watching is not.
       */
      maxNetworkRetries: 3,
      timeout: 20_000,
    });
  }

  return client;
}

/** Whether card payment can be offered at all. */
function isEnabled() {
  return Boolean(env.stripeSecretKey);
}

/**
 * Replace the SDK instance. TESTS ONLY.
 *
 * Exported rather than reached for with `jest.mock` because the swap needs to
 * happen after the module graph is already built — the checkout controller
 * holds a reference to this module, not to `stripe`. A named, documented seam
 * is also honest about the fact that it exists, where a mocked `require` is a
 * piece of hidden machinery a reader has to go and find.
 */
function __setStripeClient(stub) {
  client = stub;
}

/**
 * Turn an order's lines into Stripe's `line_items`.
 *
 * PRICES ARE SENT IN MINOR UNITS (cents), AS INTEGERS. This is the single most
 * common way a Stripe integration overcharges by a factor of a hundred, so the
 * conversion happens here, once, and `Math.round` guards the floating-point
 * multiplication that `19.99 * 100 === 1998.9999999999998` otherwise produces.
 */
function toLineItems(items) {
  return items.map((line) => {
    const variantSuffix = line.variant?.colorName
      ? ` — ${[line.variant.colorName, line.variant.size].filter(Boolean).join(' / ')}`
      : '';

    return {
      quantity: line.quantity,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(line.priceAtCheckout * 100),
        product_data: {
          name: `${line.productName}${variantSuffix}`,
        },
      },
    };
  });
}

/**
 * Open a Stripe Checkout Session for one pending checkout.
 *
 * HOSTED CHECKOUT RATHER THAN A CARD FORM, and this is a security decision
 * rather than a convenience one: with Stripe's hosted page, no card number ever
 * reaches this server, so this codebase is not in scope for the parts of PCI
 * DSS that apply to handling card data. A custom form would put a PAN in an
 * Express request body, and everything that touches it — logs, error reports,
 * request dumps — becomes a liability.
 *
 * @param {object}   pending      the PendingCheckout document
 * @param {object[]} lines        `{ productName, quantity, priceAtCheckout, variant }`
 * @param {string}   buyerEmail   prefilled on Stripe's form
 * @param {string}   origin       where to send the buyer back to
 */
async function createCheckoutSession({ pendingId, lines, buyerEmail, origin }) {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: toLineItems(lines),
    customer_email: buyerEmail,

    /*
     * `{CHECKOUT_SESSION_ID}` is substituted by Stripe on redirect. The
     * confirmation page uses it to look the order up.
     *
     * IT IS NOT PROOF OF PAYMENT. The redirect is a convenience for the human;
     * the webhook is the fact. A buyer who edits this URL, or who is redirected
     * after a payment that later fails, reaches a page that reports what the
     * database actually knows — which may legitimately be "still confirming".
     */
    success_url: `${origin}${env.stripeSuccessPath}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${env.stripeCancelPath}?cancelled=1`,

    /*
     * Our own id, carried through Stripe and handed back on the webhook event.
     * This is how the event finds the intent it belongs to without us having to
     * trust anything in the event body about what was bought.
     */
    metadata: { pendingCheckoutId: String(pendingId) },

    /*
     * Stripe expires an unpaid session after 24h by default; 30 minutes is a
     * better fit for a cart. It bounds how long a buyer can sit on a card form
     * holding a price we quoted, and it makes the `expired` webhook arrive
     * while anyone still remembers placing the order.
     */
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
  });

  log.info({ sessionId: session.id, pendingId }, 'stripe checkout session created');

  return session;
}

/**
 * Verify and parse an incoming webhook.
 *
 * THE SIGNATURE CHECK IS THE ENTIRE SECURITY OF THE PAYMENT FLOW, so it is
 * worth stating what it stops: the webhook endpoint is a public URL that
 * creates paid orders. Without verification, anyone who finds it can POST a
 * handcrafted `checkout.session.completed` and receive goods for free. The
 * signature proves the event was produced by Stripe using the shared secret,
 * and the timestamp inside it stops an old genuine event being replayed later.
 *
 * `rawBody` must be the UNPARSED bytes. Signatures are computed over the exact
 * payload Stripe sent, so a body that has been through `JSON.parse` and back
 * will not match — see the raw-body mount in app.js.
 */
function constructEvent(rawBody, signature) {
  if (!env.stripeWebhookSecret) {
    throw ApiError.badRequest('Stripe webhooks are not configured on this deployment');
  }

  const stripe = getStripe();

  try {
    return stripe.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);
  } catch (err) {
    /*
     * Logged at warn, not error. An invalid signature is an expected event on a
     * public endpoint — it is what a scanner or a misconfigured second
     * environment looks like — and paging somebody for it would train them to
     * ignore the log.
     */
    log.warn({ err: err.message }, 'rejected a webhook with an invalid signature');
    throw ApiError.badRequest(`Webhook signature verification failed: ${err.message}`);
  }
}

/**
 * Refund a payment in full.
 *
 * THE IDEMPOTENCY KEY IS NOT OPTIONAL HERE. A refund is money leaving the
 * business, and this call can genuinely be made twice: `maxNetworkRetries`
 * above retries a request whose response was lost, and an admin can double
 * click an approve button. Keying the request on the order id means Stripe
 * recognises the second attempt as the same one and returns the original refund
 * rather than issuing another. Without it, the safe-looking retry logic
 * directly above becomes a way to refund twice.
 *
 * @param {string} paymentIntentId what to refund
 * @param {string} idempotencyKey  stable per order — see above
 */
async function refundPayment(paymentIntentId, idempotencyKey) {
  const stripe = getStripe();

  const refund = await stripe.refunds.create(
    { payment_intent: paymentIntentId },
    { idempotencyKey }
  );

  log.info({ paymentIntentId, refundId: refund.id, status: refund.status }, 'refund issued');

  return refund;
}

/** Read a session back, for the confirmation page's reconciliation path. */
async function retrieveSession(sessionId) {
  const stripe = getStripe();
  return stripe.checkout.sessions.retrieve(sessionId);
}

module.exports = {
  isEnabled,
  getStripe,
  createCheckoutSession,
  constructEvent,
  refundPayment,
  retrieveSession,
  toLineItems,
  __setStripeClient,
};
