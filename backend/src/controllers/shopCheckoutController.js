const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Buyer = require('../models/Buyer');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const PendingCheckout = require('../models/PendingCheckout');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withTransaction } = require('../utils/transaction');
const { placeOrder, buildOrderItems, ORDER_POPULATE } = require('./orderController');
const { matchOrCreateCustomer } = require('../services/storefrontCustomerService');
const { recordAudit } = require('../services/auditService');
const stripeService = require('../services/stripeService');
const { publicOrigin } = require('../utils/publicUrl');
const { consentFromBody } = require('../models/marketingConsent');
const { setConsentEverywhere } = require('../services/unsubscribeService');
const { componentLogger } = require('../config/logger');

const log = componentLogger('shop-checkout');
const {
  PAYMENT_METHOD_VALUES,
  STRIPE_PAYMENT_METHODS,
  MAX_ORDER_QTY,
  DELIVERY_SPEED,
  DELIVERY_SPEED_VALUES,
} = require('../config/constants');

/**
 * POST /api/shop/checkout
 *
 * THERE IS NO GUEST CHECKOUT. This overrides the round-1 decision, and the
 * change is enforced here rather than only in the UI — the route now runs
 * `protectBuyer`, so an unauthenticated POST is a 401 before this function is
 * reached. Browsing, searching and filling a cart remain completely open; only
 * buying requires an account.
 *
 * The previous version accepted a `{ name, email, address }` body from an
 * anonymous caller and created a Customer from it. That shape is gone: it is
 * not merely unused, it is unreachable, and the middleware is what makes that
 * true rather than a conditional inside the handler.
 *
 * TWO PATHS OUT OF THIS FUNCTION, AND THEY RETURN DIFFERENT THINGS
 *
 *   card (Stripe)  NO ORDER IS CREATED. A PendingCheckout is written, a Stripe
 *                  Checkout Session is opened, and the buyer is handed a URL to
 *                  go and pay at. The order is created later, by the webhook,
 *                  and only if the money actually arrives. Responds 200 with
 *                  `{ mode: 'stripe', checkoutUrl }`.
 *
 *   cod / bank     No processor is involved, so there is nothing to wait for.
 *                  The order is created immediately and unpaid, exactly as it
 *                  was before Stripe existed. Responds 201 with the order.
 *
 * Keeping the second path is a deliberate choice rather than leftover code.
 * Cash on delivery is a real way this shop's customers pay, it was built at the
 * previous round's explicit request, and deleting it because a card processor
 * arrived would remove a working feature to make a diagram tidier. What it does
 * NOT do is pretend to be a payment: such an order carries
 * `payment.status: 'unpaid'`, truthfully, until somebody collects.
 */
const checkout = asyncHandler(async (req, res) => {
  const buyer = req.buyer;
  const rawItems = req.body.items;

  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw ApiError.badRequest('A checkout needs at least one item');
  }

  /*
   * The per-line ceiling again, because THIS is the endpoint that matters.
   *
   * A guest cart lives entirely in the browser and is posted here directly, so
   * a checkout can carry quantities that never passed through the cart API and
   * never met its limit. Enforcing it only there would leave the gate closed on
   * the path that has a lock and open on the one that does not.
   *
   * Deliberately NOT applied to staff-placed orders in orderController: a rep
   * entering a wholesale order for 500 units is doing their job. This bounds
   * what an anonymous visitor can claim, not what the business can sell.
   */
  const overLimit = rawItems.find((item) => Number(item?.quantity) > MAX_ORDER_QTY);
  if (overLimit) {
    throw ApiError.badRequest(
      `You can order up to ${MAX_ORDER_QTY} of one item. For a larger order, please contact us.`
    );
  }

  const { paymentMethod } = req.body;
  if (!PAYMENT_METHOD_VALUES.includes(paymentMethod)) {
    throw ApiError.badRequest(
      `paymentMethod must be one of: ${PAYMENT_METHOD_VALUES.join(', ')}`
    );
  }

  /*
   * How fast they asked for it.
   *
   * Absent means standard rather than an error, because this field arrived
   * after the endpoint did: an older client, and every existing test, posts a
   * checkout with no delivery speed at all, and refusing those would break
   * working callers to enforce a field they have no way to know about. An
   * explicitly WRONG value is still rejected — that is a client bug, not an
   * older client.
   */
  const deliverySpeed = req.body.deliverySpeed ?? DELIVERY_SPEED.STANDARD;
  if (!DELIVERY_SPEED_VALUES.includes(deliverySpeed)) {
    throw ApiError.badRequest(
      `deliverySpeed must be one of: ${DELIVERY_SPEED_VALUES.join(', ')}`
    );
  }

  /*
   * A DELIVERY ADDRESS IS NOW REQUIRED, not defaulted to `addresses[0]`.
   *
   * The old fallback was written when a guest could type one inline and a buyer
   * might have exactly one saved. With accounts mandatory and multiple
   * addresses normal, silently posting to whichever address happens to sort
   * first is a parcel sent to somebody's old flat. The storefront already
   * insists on a selection; this is the server refusing to guess.
   */
  const chosen = req.body.addressId ? buyer.addresses.id(req.body.addressId) : null;

  if (!chosen) {
    throw ApiError.badRequest(
      req.body.addressId
        ? 'That is not one of your saved addresses'
        : 'Choose a delivery address before checking out'
    );
  }

  const shipping = {
    label: chosen.label || '',
    address: chosen.address || '',
    city: chosen.city || '',
    phone: chosen.phone || '',
  };

  /*
   * MARKETING CONSENT AT CHECKOUT.
   *
   * The round asks for opt-in checkboxes on guest checkout. There is no guest
   * checkout — an account is mandatory before buying — so the boxes live on
   * registration AND here, which between them cover both kinds of person
   * reaching this point: somebody buying for the first time, and a returning
   * buyer who registered before these boxes existed and would otherwise never
   * be asked.
   *
   * Written through `setConsentEverywhere` so it lands on the `Buyer` AND on
   * the linked `Customer`, rather than only on the record this request happens
   * to be holding. A consent that exists on one half of a person is a consent
   * the merged contact view has to reconcile, and a checkout is exactly where
   * the two records for one human are most likely to both exist.
   *
   * Deliberately NOT awaited into the checkout's failure path: a consent that
   * cannot be recorded must not stop somebody buying something. It is logged
   * and the purchase proceeds, which is the same trade the mailer makes.
   */
  const consentChanges = consentFromBody(req.body);
  if (Object.keys(consentChanges).length) {
    try {
      await setConsentEverywhere(buyer.email, consentChanges);
    } catch (err) {
      log.warn({ err, buyerId: buyer._id }, 'could not record checkout marketing consent');
    }
  }

  if (STRIPE_PAYMENT_METHODS.includes(paymentMethod)) {
    return startStripeCheckout(req, res, { buyer, rawItems, shipping, deliverySpeed });
  }

  return placeUnpaidOrder(req, res, { buyer, rawItems, shipping, paymentMethod, deliverySpeed });
});

/**
 * The card path: price the cart, open a Stripe session, and stop.
 *
 * NOTHING PERSISTENT ABOUT THE ORDER HAPPENS HERE. No Order document, no stock
 * movement, no Customer created. The only write is the PendingCheckout, which
 * is disposable by design (it carries a TTL) and reserves nothing.
 */
async function startStripeCheckout(req, res, { buyer, rawItems, shipping, deliverySpeed }) {
  if (!stripeService.isEnabled()) {
    throw ApiError.badRequest(
      'Card payment is not available at the moment. Choose cash on delivery instead.'
    );
  }

  /*
   * Priced through the SAME function every other order path uses.
   *
   * That is what makes a card order obey identical rules to a staff-placed one:
   * variant required where variants exist, variant rejected where they do not,
   * per-variant price overrides applied, duplicate lines merged on product AND
   * variant, and an advisory stock check that produces a readable error. Writing
   * a second, simpler pricing routine here is how the two would drift.
   */
  const { items, total } = await buildOrderItems(rawItems);

  if (total <= 0) {
    /*
     * Stripe refuses a zero-amount session, and it would be an odd thing to
     * want. Caught here so the buyer gets a sentence rather than a raw SDK
     * error surfacing through the error handler.
     */
    throw ApiError.badRequest('This cart has no payable total.');
  }

  // Names for Stripe's line items — the buyer sees these on the hosted page,
  // so they have to say what was actually bought, variant included.
  const products = await Product.find({ _id: { $in: items.map((i) => i.product) } }).select('name');
  const nameById = new Map(products.map((p) => [String(p._id), p.name]));

  const lines = items.map((item) => ({
    productName: nameById.get(String(item.product)) || 'Item',
    quantity: item.quantity,
    priceAtCheckout: item.priceAtOrder,
    variant: item.variant,
  }));

  /*
   * The id is generated BEFORE the Stripe call so it can travel in the
   * session's metadata, and the document is written after so it can carry the
   * session id back. Both directions are needed: the webhook arrives holding a
   * session and must find the intent, and the confirmation page arrives holding
   * a session and must find the order.
   *
   * The alternative — write the document first with a placeholder session id —
   * would need `stripeSessionId` to be nullable, which would cost the unique
   * index that makes webhook replay safe.
   */
  const pendingId = new mongoose.Types.ObjectId();

  const session = await stripeService.createCheckoutSession({
    pendingId,
    lines,
    buyerEmail: buyer.email,
    /*
     * `publicOrigin`, not `requestOrigin`. This URL is where a browser is sent
     * after paying, so it has to be the FRONTEND's origin — which on a laptop
     * is a different port from the API the request arrived on, and on a
     * deployment is whatever APP_URL says. `requestOrigin` would send the buyer
     * to the API port, where the confirmation page is not served.
     */
    origin: publicOrigin(req),
  });

  await PendingCheckout.create({
    _id: pendingId,
    buyer: buyer._id,
    stripeSessionId: session.id,
    items: lines.map((line, index) => ({
      product: items[index].product,
      quantity: line.quantity,
      priceAtCheckout: line.priceAtCheckout,
      variant: line.variant || undefined,
    })),
    total,
    shipping,
    deliverySpeed,
  });

  /*
   * 200, not 201. Nothing has been created that the buyer owns — this is a
   * redirect instruction, and reporting "created" for an order that does not
   * exist is exactly the confusion this whole flow is built to avoid.
   */
  res.json({
    success: true,
    mode: 'stripe',
    data: { checkoutUrl: session.url, sessionId: session.id },
  });
}

/**
 * The cash-on-delivery / bank-transfer path: an order now, money later.
 *
 * Unchanged in substance from the pre-Stripe implementation — same
 * pricing-at-time-of-order, atomic numbering and "storefront orders always
 * start pending" rules. `payment.status` is left at its `unpaid` default, which
 * is the literal truth about an order nobody has paid for yet.
 */
async function placeUnpaidOrder(req, res, { buyer, rawItems, shipping, paymentMethod, deliverySpeed }) {
  const order = await withTransaction(async (session) => {
    /*
     * RE-READ THE BUYER INSIDE THE TRANSACTION RATHER THAN USING `req.buyer`.
     *
     * A latent bug fixed here rather than carried forward. `session.withTransaction`
     * retries its callback on a transient error — a write conflict between two
     * concurrent checkouts, or the implicit collection creation MongoDB performs
     * on the first order a fresh database ever sees. The retry re-runs this
     * function but does NOT rewind a Mongoose document captured outside it.
     *
     * `req.buyer` is exactly such a document. On attempt 1 the line below sets
     * `linkedCustomerId` on it and the matching insert is then rolled back; on
     * attempt 2 the buyer still believes it is linked, takes the `findById`
     * branch, and resolves an id that no longer exists — so a perfectly valid
     * checkout fails with "Customer not found".
     *
     * It went unnoticed because the retry only fires under contention, which a
     * single-threaded test never produces. It surfaced while building the Stripe
     * webhook, where the first order on an empty database reliably triggers the
     * collection-creation retry, and the identical shape was sitting here.
     */
    const freshBuyer = await Buyer.findById(buyer._id).session(session);
    if (!freshBuyer) throw ApiError.notFound('Buyer not found');

    const customer = freshBuyer.linkedCustomerId
      ? await Customer.findById(freshBuyer.linkedCustomerId).session(session)
      : await matchOrCreateCustomer(
          {
            email: freshBuyer.email,
            name: freshBuyer.name,
            phone: shipping.phone,
            address: shipping.address,
            city: shipping.city,
          },
          session
        );

    if (!customer) throw ApiError.notFound('Customer not found');

    if (!freshBuyer.linkedCustomerId) {
      freshBuyer.linkedCustomerId = customer._id;
      await freshBuyer.save({ session });
    }

    const placed = await placeOrder(
      {
        customerId: customer._id,
        rawItems,
        status: 'pending',
        assignedTo: null,
        source: 'storefront',
        buyerId: buyer._id,
        paymentMethod,
        deliverySpeed,
      },
      session
    );

    // The cart is spent the moment the order is placed — inside the same
    // transaction, so a rollback leaves it untouched rather than emptying it
    // for nothing.
    await Cart.updateOne({ buyer: buyer._id }, { items: [] }, { session });

    return placed;
  });

  /*
   * `recordAudit` reads `req.user` for its actor snapshot, which does not exist
   * on a buyer request — it degrades to an empty actor rather than erroring,
   * but an entry with no actor at all is not useful. The buyer's identity goes
   * in the note instead.
   */
  await recordAudit(req, {
    action: 'create',
    entity: 'order',
    entityId: order._id,
    label: `Order ${order.orderNumber || order._id}`,
    after: order,
    note: `Storefront checkout by buyer ${buyer.email} (${paymentMethod})`,
  });

  await order.populate(ORDER_POPULATE);

  res.status(201).json({ success: true, mode: 'direct', data: order });
}

/**
 * GET /api/shop/checkout/session/:sessionId
 *
 * What the confirmation page asks after Stripe redirects the buyer back.
 *
 * THE REDIRECT IS NOT PROOF OF PAYMENT and this endpoint does not treat it as
 * such. It reports what the database currently knows, which is one of three
 * honest answers: the order exists (the webhook has been and gone), the
 * checkout failed or expired, or it is still pending — in which case the page
 * says "confirming your payment" and polls, rather than inventing an outcome.
 *
 * A buyer can and does arrive here before the webhook does; on a fast
 * connection the redirect wins the race perhaps a third of the time. Treating
 * that as failure would show a payment error to somebody who has just paid
 * successfully, which is the worst available lie.
 */
const getCheckoutSession = asyncHandler(async (req, res) => {
  const pending = await PendingCheckout.findOne({
    stripeSessionId: req.params.sessionId,
    // Scoped to the caller. A session id is not secret enough to be an
    // authorisation token, and it names an order with an address on it.
    buyer: req.buyer._id,
  }).populate({ path: 'order', populate: ORDER_POPULATE });

  if (!pending) throw ApiError.notFound('That checkout could not be found');

  res.json({
    success: true,
    data: {
      status: pending.status,
      note: pending.note || '',
      total: pending.total,
      order: pending.order || null,
    },
  });
});

module.exports = { checkout, getCheckoutSession };
