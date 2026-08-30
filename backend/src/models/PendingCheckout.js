const mongoose = require('mongoose');
const { PENDING_CHECKOUT_STATUS, PENDING_CHECKOUT_STATUS_VALUES } = require('../config/constants');

/**
 * A checkout that has been STARTED but not yet paid for.
 *
 * WHY THIS COLLECTION EXISTS AT ALL
 *
 * The rule from the brief, restated because everything here follows from it:
 * no order is created, and no stock is touched, until Stripe's webhook confirms
 * the payment actually succeeded. Between the buyer clicking "Pay" and that
 * webhook arriving there is a real interval — seconds if all goes well, forever
 * if they close the tab at the card form — and something has to remember what
 * they were buying without committing to it.
 *
 * The obvious alternative is to create the order immediately as `pending` and
 * cancel it if payment never lands. That is worse in a specific way: an order
 * that exists is an order staff can see, assign, complete and ship. A queue
 * full of orders for carts nobody paid for is not a queue anybody can work, and
 * the failure mode is somebody posting a parcel for a payment that never
 * happened.
 *
 * WHY IT SNAPSHOTS PRICES
 *
 * `priceAtCheckout` is captured when the Stripe session is created, because
 * that is the number Stripe was told to charge. If the price changes while the
 * buyer is on the card form, the webhook must still build the order at the
 * price the buyer actually paid — anything else means the order total and the
 * money taken disagree, which is the one discrepancy in a shop that is never
 * acceptable. This is the same reasoning as `priceAtOrder`, one step earlier in
 * the sequence.
 *
 * WHY IT IS NOT JUST THE CART
 *
 * A cart is mutable and shared across devices; this is a frozen intent tied to
 * one Stripe session. A buyer can legitimately open two checkouts and pay for
 * one, and the cart cannot represent that.
 */

const pendingItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1'],
    },
    priceAtCheckout: {
      type: Number,
      required: true,
      min: [0, 'Price cannot be negative'],
    },
    /** Mirrors the order line's variant snapshot; null for an unvaried product. */
    variant: {
      variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
      colorName: { type: String, default: '' },
      colorHex: { type: String, default: '' },
      size: { type: String, default: '' },
    },
  },
  { _id: false }
);

const pendingCheckoutSchema = new mongoose.Schema({
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    required: [true, 'A checkout belongs to a signed-in buyer'],
  },

  /**
   * The Stripe Checkout Session this intent is waiting on.
   *
   * Unique, and that uniqueness is load-bearing rather than tidy: it is what
   * makes a replayed webhook idempotent. Stripe retries until it receives a
   * 2xx, so the same `checkout.session.completed` event genuinely does arrive
   * more than once in normal operation.
   */
  stripeSessionId: {
    type: String,
    required: true,
    unique: true,
  },

  items: {
    type: [pendingItemSchema],
    validate: {
      validator: (items) => Array.isArray(items) && items.length > 0,
      message: 'A checkout must contain at least one item',
    },
  },

  /** Recomputed server-side from the snapshotted lines — never sent by the client. */
  total: {
    type: Number,
    required: true,
    min: [0, 'Total cannot be negative'],
  },

  /**
   * The delivery address, COPIED rather than referenced.
   *
   * A buyer can edit or delete an address while a checkout is in flight, and
   * the parcel has to go where they said at the time they paid — not wherever
   * that address slot points a week later.
   */
  shipping: {
    label: { type: String, default: '' },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    phone: { type: String, default: '' },
  },

  status: {
    type: String,
    enum: {
      values: PENDING_CHECKOUT_STATUS_VALUES,
      message: `Status must be one of: ${PENDING_CHECKOUT_STATUS_VALUES.join(', ')}`,
    },
    default: PENDING_CHECKOUT_STATUS.PENDING,
  },

  /** Set once the webhook has built the real order, so the link is traceable. */
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },

  /** Why it failed or expired, for the buyer's benefit and for support. */
  note: {
    type: String,
    default: '',
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },

  /**
   * Stripe sessions expire after 24 hours. Kept a little longer than that so a
   * buyer landing on the confirmation page after a long delay still finds an
   * explanation rather than a blank 404, then removed by MongoDB's TTL monitor.
   *
   * A TTL index rather than a cron: this is genuinely disposable state, and the
   * one thing worse than losing it on a schedule is keeping every abandoned
   * cart forever in a collection nobody prunes.
   */
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 48 * 60 * 60 * 1000),
  },
});

/* Reconciling a webhook or a redirect to the intent it belongs to. */
pendingCheckoutSchema.index({ buyer: 1, createdAt: -1, _id: -1 });

/* See `expiresAt` above — MongoDB removes the document once the date passes. */
pendingCheckoutSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingCheckout', pendingCheckoutSchema);
