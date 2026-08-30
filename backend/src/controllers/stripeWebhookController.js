const Customer = require('../models/Customer');
const Cart = require('../models/Cart');
const Buyer = require('../models/Buyer');
const Order = require('../models/Order');
const PendingCheckout = require('../models/PendingCheckout');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withTransaction } = require('../utils/transaction');
const { placeOrder } = require('./orderController');
const { matchOrCreateCustomer } = require('../services/storefrontCustomerService');
const stripeService = require('../services/stripeService');
const { componentLogger } = require('../config/logger');
const {
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  PENDING_CHECKOUT_STATUS,
} = require('../config/constants');

const log = componentLogger('stripe-webhook');

/**
 * POST /api/shop/stripe/webhook
 *
 * THE ONLY PLACE A PAID ORDER IS EVER CREATED.
 *
 * Not the checkout endpoint, and emphatically not the success redirect. The
 * reason is the one the brief gives and it is worth restating because it is the
 * single most common way a hand-rolled Stripe integration loses money: the
 * buyer can close the tab the instant the payment succeeds, the redirect can
 * fail, the browser can crash, the network can drop. All of those leave the
 * payment perfectly complete on Stripe's side and the buyer never returning to
 * our success URL. If the redirect were what created the order, that customer
 * has been charged and has no order.
 *
 * The webhook has none of those failure modes. Stripe retries it, with backoff,
 * for up to three days, until it gets a 2xx.
 *
 * WHY THIS ROUTE IS MOUNTED BEFORE `express.json()`
 *
 * Signature verification is computed over the exact bytes Stripe sent. Parsing
 * the body to JSON and re-serialising it changes those bytes — key order,
 * whitespace, unicode escaping — so the signature will not match and every
 * event would be rejected. See the raw-body mount in app.js.
 *
 * WHAT MAKES REPLAY SAFE
 *
 * Stripe genuinely delivers the same event more than once; a timeout on our
 * side is enough to earn a retry for work already done. Three independent
 * things stop a duplicate becoming a second order:
 *
 *   1. The PendingCheckout's status is checked INSIDE the transaction, so two
 *      concurrent deliveries cannot both see `pending`.
 *   2. A unique partial index on `payment.sessionId` means the database itself
 *      refuses a second order for the same session.
 *   3. Anything already handled returns 200 immediately, so Stripe stops.
 */

/** Events this endpoint acts on. Anything else is acknowledged and ignored. */
const HANDLED = {
  COMPLETED: 'checkout.session.completed',
  EXPIRED: 'checkout.session.expired',
  ASYNC_FAILED: 'checkout.session.async_payment_failed',
};

const handleStripeWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    throw ApiError.badRequest('Missing stripe-signature header');
  }

  /*
   * Throws (400) on a bad signature. That is the correct response: it tells a
   * genuine Stripe endpoint with the wrong secret that something is
   * misconfigured, and tells an attacker nothing they can use.
   *
   * IT IS ALSO LOGGED, AND THAT MATTERS MORE THAN IT LOOKS.
   *
   * A rejected webhook used to travel straight through asyncHandler to the
   * error handler, which treats a 400 as a routine client error and says
   * nothing at info level. So the one failure that must never be silent — every
   * event being thrown away while buyers are paying — was the quietest thing
   * the server did. It took a proxy in front of the process to find out why,
   * and what it turned out to be was not the secret at all: the machine's clock
   * was six minutes fast, and Stripe's signature tolerance is five.
   *
   * That reason is called out by name below, because "signature verification
   * failed" sends you to check the secret, which is the wrong place to look
   * and the place you will look for a long time.
   */
  let event;
  try {
    event = stripeService.constructEvent(req.body, signature);
  } catch (err) {
    const skewed = /tolerance|timestamp/i.test(err.message || '');
    log.warn(
      { err: err.message, likelyCause: skewed ? 'clock skew' : 'wrong or stale webhook secret' },
      skewed
        ? 'stripe webhook REJECTED: this server\'s clock is more than 5 minutes off. Every event ' +
            'will be discarded until it is synchronised — orders are not being created.'
        : 'stripe webhook REJECTED: signature did not verify. Check STRIPE_WEBHOOK_SECRET matches ' +
            'the endpoint sending these events.'
    );
    throw err;
  }

  log.info({ type: event.type, eventId: event.id }, 'stripe webhook received');

  switch (event.type) {
    case HANDLED.COMPLETED:
      await onCheckoutCompleted(event.data.object);
      break;

    case HANDLED.EXPIRED:
      await onCheckoutClosed(event.data.object, PENDING_CHECKOUT_STATUS.EXPIRED, 'The payment session expired before it was completed.');
      break;

    case HANDLED.ASYNC_FAILED:
      await onCheckoutClosed(event.data.object, PENDING_CHECKOUT_STATUS.FAILED, 'The payment was declined.');
      break;

    default:
      /*
       * Acknowledged, not errored. A Stripe account emits dozens of event types
       * and an endpoint may be subscribed to more than it handles; returning a
       * failure for those would fill the dashboard with red and train whoever
       * reads it to ignore genuine failures.
       */
      log.debug({ type: event.type }, 'ignoring an unhandled stripe event type');
  }

  res.json({ received: true });
});

/**
 * A payment succeeded: build the real order.
 *
 * @param {object} session Stripe's Checkout Session object
 */
async function onCheckoutCompleted(session) {
  /*
   * `payment_status` is checked rather than assumed. `checkout.session.completed`
   * fires when the buyer finishes the flow, which for a delayed payment method
   * is NOT the same as the money having arrived — it can be `unpaid` here and
   * settle (or fail) minutes later via `async_payment_succeeded`. Creating an
   * order on the strength of the event name alone would ship goods for a
   * payment still in flight.
   */
  if (session.payment_status !== 'paid') {
    log.info(
      { sessionId: session.id, paymentStatus: session.payment_status },
      'checkout completed but not paid — no order created'
    );
    return;
  }

  const pending = await PendingCheckout.findOne({ stripeSessionId: session.id });

  if (!pending) {
    /*
     * We were paid for a checkout we have no record of. Thrown rather than
     * swallowed, so Stripe retries — the realistic cause is our own write
     * losing a race with a very fast payment, and a retry in ten seconds fixes
     * it. The alternative, returning 200, would silently discard a paid order
     * for good.
     *
     * If it is genuinely orphaned the retries stop after three days having
     * logged loudly every time, which is the outcome we want: noisy, visible,
     * and recoverable by hand.
     */
    log.error({ sessionId: session.id }, 'paid session has no pending checkout — asking Stripe to retry');
    throw ApiError.notFound('No pending checkout matches that session');
  }

  if (pending.status !== PENDING_CHECKOUT_STATUS.PENDING) {
    log.info({ sessionId: session.id, status: pending.status }, 'checkout already resolved — ignoring replay');
    return;
  }

  const buyer = await Buyer.findById(pending.buyer);
  if (!buyer) {
    log.error({ pendingId: pending._id }, 'the buyer for a paid checkout no longer exists');
    throw ApiError.notFound('Buyer not found');
  }

  const payment = {
    status: PAYMENT_STATUS.PAID,
    sessionId: session.id,
    /*
     * The PaymentIntent, not the session, is what a refund is issued against.
     * Captured now because a refund may be requested weeks later, and going
     * back to Stripe to re-derive it then is a network call in the middle of an
     * approval flow.
     */
    paymentIntentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id || null,
    amountPaid: session.amount_total,
    currency: session.currency,
    paidAt: new Date(),
  };

  try {
    const order = await withTransaction(async (dbSession) => {
      /*
       * Re-read inside the transaction. The check above is an optimisation that
       * avoids the expensive path for an obvious replay; THIS one is the
       * correctness guarantee, because it and the write below are atomic.
       */
      const fresh = await PendingCheckout.findOne({
        _id: pending._id,
        status: PENDING_CHECKOUT_STATUS.PENDING,
      }).session(dbSession);

      if (!fresh) {
        // Another delivery of the same event won the race and is creating the
        // order right now. Nothing to do, and definitely nothing to fail.
        return null;
      }

      /*
       * THE BUYER IS RE-READ INSIDE THE TRANSACTION, NOT REUSED FROM ABOVE.
       *
       * This looks like a redundant query and is not. `session.withTransaction`
       * retries the whole callback on a transient error — a write conflict
       * between two concurrent checkouts, or the implicit collection creation
       * that happens on the very first order a fresh database ever sees. The
       * retry re-runs this function; it does NOT rewind Mongoose documents
       * captured outside it.
       *
       * So with a document loaded above, attempt 1 sets `linkedCustomerId` in
       * memory and its insert is then rolled back. Attempt 2 sees a buyer that
       * *believes* it is linked to a customer, takes the `findById` branch, and
       * looks up an id that no longer exists anywhere — producing "Customer not
       * found" for a buyer whose record is perfectly fine.
       *
       * That failure is invisible in ordinary use and catastrophic when it
       * happens: the money has been taken, so the handler's catch refunds it
       * and tells the customer their item sold out, which is not remotely what
       * occurred. Re-reading here means every attempt starts from committed
       * state, which is the only state a retry can safely reason about.
       *
       * (The same mistake existed in the cash-on-delivery path and has been
       * fixed there too — see shopCheckoutController.)
       */
      const freshBuyer = await Buyer.findById(pending.buyer).session(dbSession);
      if (!freshBuyer) throw ApiError.notFound('Buyer not found');

      const customer = freshBuyer.linkedCustomerId
        ? await Customer.findById(freshBuyer.linkedCustomerId).session(dbSession)
        : await matchOrCreateCustomer(
            {
              email: freshBuyer.email,
              name: freshBuyer.name,
              phone: fresh.shipping.phone,
              address: fresh.shipping.address,
              city: fresh.shipping.city,
            },
            dbSession
          );

      if (!customer) throw ApiError.notFound('Customer not found');

      if (!freshBuyer.linkedCustomerId) {
        freshBuyer.linkedCustomerId = customer._id;
        await freshBuyer.save({ session: dbSession });
      }

      const created = await placeOrder(
        {
          customerId: customer._id,
          /*
           * PRICED FROM THE SNAPSHOT, NOT FROM THE LIVE CATALOGUE.
           *
           * Stripe charged a specific amount computed when the session opened.
           * Re-pricing from today's catalogue would produce an order whose
           * total disagrees with the money actually taken if a price moved
           * while the buyer was on the card form. See the note in `placeOrder`.
           */
          prebuiltItems: {
            items: fresh.items.map((item) => ({
              product: item.product,
              quantity: item.quantity,
              priceAtOrder: item.priceAtCheckout,
              variant: item.variant?.variantId ? item.variant : null,
            })),
            total: fresh.total,
          },
          rawItems: null,
          status: 'pending',
          assignedTo: null,
          source: 'storefront',
          buyerId: buyer._id,
          paymentMethod: PAYMENT_METHOD.CARD,
          payment,
          /*
           * The money is gone, so the inventory genuinely is too — even though
           * nobody has picked or posted anything and the order is correctly
           * still `pending`. This is exactly why `stockTakenAt` exists as a
           * field separate from `completedAt`.
           */
          takeStock: true,
        },
        dbSession
      );

      fresh.status = PENDING_CHECKOUT_STATUS.COMPLETED;
      fresh.order = created._id;
      await fresh.save({ session: dbSession });

      await Cart.updateOne({ buyer: buyer._id }, { items: [] }, { session: dbSession });

      return created;
    });

    if (order) {
      log.info(
        { orderId: order._id, orderNumber: order.orderNumber, sessionId: session.id },
        'order created from a confirmed payment'
      );
    }
  } catch (err) {
    /*
     * THE ONE CASE WE REFUND OURSELVES.
     *
     * The only realistic way the transaction fails at this point is
     * `decrementStock` refusing because the last unit of a variant sold to
     * somebody else while this buyer was typing their card number. The stock
     * guarantee holds — we did not oversell — but the buyer has paid for
     * something that no longer exists.
     *
     * Leaving it would mean a charge with no order. Creating the order anyway
     * would mean overselling, which is the thing the atomic decrement exists to
     * make impossible. So the money goes back automatically, the checkout is
     * marked failed with a reason the buyer can read on the confirmation page,
     * and the event is acknowledged so Stripe stops retrying something that
     * will never succeed.
     */
    log.error({ err, sessionId: session.id }, 'could not create an order for a paid checkout — refunding');

    await failPendingCheckout(
      pending,
      PENDING_CHECKOUT_STATUS.FAILED,
      'Something you ordered sold out while your payment was being taken, so it has been refunded in full.'
    );

    if (payment.paymentIntentId) {
      try {
        await stripeService.refundPayment(
          payment.paymentIntentId,
          `refund_pending_${pending._id}`
        );
      } catch (refundErr) {
        /*
         * A failed automatic refund is genuinely serious — a customer is out of
         * pocket with nothing to show — so it is logged at error with every id
         * needed to issue it by hand from the Stripe dashboard. It is NOT
         * rethrown: doing so would make Stripe retry the whole event, and the
         * order creation would fail again for the same reason, forever.
         */
        log.error(
          { err: refundErr, paymentIntentId: payment.paymentIntentId, sessionId: session.id },
          'AUTOMATIC REFUND FAILED — this payment must be refunded by hand from the Stripe dashboard'
        );
      }
    }
  }
}

/**
 * A checkout that will never be paid: expired, or declined.
 *
 * NOTHING IS UNDONE HERE, because nothing was ever done. No order exists, no
 * stock was reserved, no customer was created. That is the entire payoff of
 * holding the intent in a PendingCheckout instead of creating a provisional
 * order — abandonment costs one status change on a document that was going to
 * expire anyway.
 */
async function onCheckoutClosed(session, status, note) {
  const pending = await PendingCheckout.findOne({ stripeSessionId: session.id });

  if (!pending) {
    log.debug({ sessionId: session.id }, 'no pending checkout for a closed session — nothing to do');
    return;
  }

  if (pending.status !== PENDING_CHECKOUT_STATUS.PENDING) {
    // Already resolved — including the case where it was actually paid and this
    // is a late `expired` for a session that succeeded. Never downgrade a
    // completed checkout.
    return;
  }

  await failPendingCheckout(pending, status, note);
  log.info({ sessionId: session.id, status }, 'checkout closed without payment');
}

/** Mark a pending checkout as finished-without-an-order, with a readable reason. */
async function failPendingCheckout(pending, status, note) {
  await PendingCheckout.updateOne(
    { _id: pending._id, status: PENDING_CHECKOUT_STATUS.PENDING },
    { $set: { status, note } }
  );
}

/**
 * Reconcile a checkout from the redirect, for the case where the buyer is back
 * and the webhook is not.
 *
 * DELIBERATELY NOT A SECOND WAY TO CREATE AN ORDER. It asks Stripe directly
 * whether the session is paid and, if it is, runs the SAME handler the webhook
 * runs — which is idempotent, so whichever arrives second does nothing. The
 * rule "only a confirmed payment creates an order" is preserved because the
 * confirmation still comes from Stripe rather than from the browser.
 *
 * Exists because the redirect legitimately beats the webhook a fair fraction of
 * the time, and a buyer staring at "confirming your payment" for thirty seconds
 * assumes it failed.
 */
const reconcileSession = asyncHandler(async (req, res) => {
  const pending = await PendingCheckout.findOne({
    stripeSessionId: req.params.sessionId,
    buyer: req.buyer._id,
  });

  if (!pending) throw ApiError.notFound('That checkout could not be found');

  if (pending.status === PENDING_CHECKOUT_STATUS.PENDING) {
    const session = await stripeService.retrieveSession(req.params.sessionId);
    if (session.payment_status === 'paid') {
      await onCheckoutCompleted(session);
    }
  }

  const refreshed = await PendingCheckout.findById(pending._id);
  const order = refreshed.order ? await Order.findById(refreshed.order) : null;

  res.json({
    success: true,
    data: { status: refreshed.status, note: refreshed.note || '', order },
  });
});

module.exports = { handleStripeWebhook, reconcileSession, onCheckoutCompleted };
