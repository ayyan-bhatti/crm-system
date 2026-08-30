const mongoose = require('mongoose');
const {
  ORDER_STATUS,
  ORDER_STATUS_VALUES,
  PAYMENT_METHOD_VALUES,
  FULFILMENT_STATUS,
  FULFILMENT_STATUS_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
} = require('../config/constants');

/**
 * WHICH variant of the product went out on this line.
 *
 * A SNAPSHOT, exactly like `priceAtOrder` beside it, and for exactly the same
 * reason: the colour is copied here rather than looked up through `variantId`
 * so that renaming "Midnight" to "Navy" — or deleting the variant outright when
 * the line is discontinued — cannot rewrite what a customer was sent last
 * March. `variantId` is kept alongside so live stock can still be addressed
 * while the variant does exist; the copy is what survives it.
 *
 * Absent entirely on a line for a product with no variants, which is every
 * order placed before this existed.
 */
const orderItemVariantSchema = new mongoose.Schema(
  {
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    colorName: { type: String, default: '' },
    colorHex: { type: String, default: '' },
    size: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * A single line on an order.
 *
 * `priceAtOrder` is a deliberate copy of the product's price at the moment the
 * order was placed. Without it, changing a product's price would silently
 * rewrite the value of every historical order that references it.
 */
const orderItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'Order item must reference a product'],
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
    },
    priceAtOrder: {
      type: Number,
      required: true,
      min: [0, 'Price cannot be negative'],
    },
    variant: {
      type: orderItemVariantSchema,
      default: null,
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema({
  /**
   * The human-readable identifier, e.g. `ORD-000142`.
   *
   * NOT the primary key. `_id` remains that, and remains what URLs and every
   * relation use — this is a display and lookup field. Replacing the key with
   * a sequential number would leak the order volume of the business to anyone
   * who can see one, and make every existing reference invalid.
   *
   * Allocated atomically from a counter document; see models/Counter.js for why
   * `count() + 1` is a race rather than a shortcut.
   *
   * `required` is deliberately NOT set. Orders created before this field
   * existed do not have one and are still perfectly valid orders — making it
   * required would mean every read of a historical order failing validation on
   * save. The UI falls back to a short `_id` for those.
   */
  orderNumber: {
    type: String,
    /*
     * No `default: null`, and no `unique` here — both were wrong, and the
     * reason is worth recording because it is a genuinely easy trap.
     *
     * A `sparse` unique index only skips documents where the field is ABSENT.
     * A field explicitly set to null is present, so `default: null` plus a
     * sparse unique index rejects the second unnumbered order with a duplicate
     * key error on null. The uniqueness is declared below as a PARTIAL index
     * instead, which ignores nulls and absent fields alike.
     */
  },

  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: [true, 'Order must belong to a customer'],
  },
  items: {
    type: [orderItemSchema],
    validate: {
      validator: (items) => Array.isArray(items) && items.length > 0,
      message: 'An order must contain at least one item',
    },
  },
  total: {
    type: Number,
    required: true,
    min: [0, 'Total cannot be negative'],
  },
  status: {
    type: String,
    enum: {
      values: ORDER_STATUS_VALUES,
      message: `Status must be one of: ${ORDER_STATUS_VALUES.join(', ')}`,
    },
    default: ORDER_STATUS.PENDING,
  },
  /**
   * The staff member who created this order — required for every order
   * except a storefront one, which has no staff actor at all. A conditional
   * required rather than a plain `default: null` so a bug that leaves this
   * unset on an internal order is still caught by validation, exactly as it
   * was before the storefront existed.
   */
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [
      function isStaffOrder() {
        return this.source !== 'storefront';
      },
      'Order must record who created it',
    ],
    default: null,
  },

  /**
   * The rep responsible for this order. Null means nobody yet.
   *
   * THIS IS THE WHOLE OF A REP'S ACCESS, AND IT USED NOT TO BE.
   *
   * Assignment began as an OVERRIDE of an inherited rule: a rep saw orders they
   * created, orders belonging to a customer they owned, and orders assigned to
   * them. Both of the first two are now impossible — a rep cannot place an
   * order and has no customers — so this field is the only route, and null
   * means the order is in nobody's list rather than "follows the customer".
   *
   * That is a real change in meaning and worth stating plainly, because the
   * comment that used to be here said the opposite and three tests were
   * asserting it.
   *
   * WHY IT IS STILL PER-ORDER RATHER THAN DERIVED FROM THE CUSTOMER.
   *
   *   - One deal on an account handled by somebody else — a specialist brought
   *     in for a large order, cover during leave — without handing over the
   *     whole relationship.
   *   - History. Moving a customer to a new rep would otherwise rewrite who
   *     handled every order that customer ever placed, including ones closed
   *     years ago by someone who has since left. Commission is attached to
   *     those.
   *
   * Left null on creation on purpose: an order arrives before anyone has
   * decided who works it, and defaulting to the creator would freeze an answer
   * nobody gave.
   */
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Set when the order first transitions to `completed`.
  completedAt: {
    type: Date,
    default: null,
  },

  /**
   * When this order's stock was actually taken out of inventory.
   *
   * THIS, NOT `completedAt`, IS NOW THE STOCK GUARD — and the split is the
   * single most consequential change Stripe forced, so it is worth being exact
   * about why.
   *
   * The rule used to be "stock moves when an order is completed", with
   * `completedAt` doubling as both the timestamp and the once-only guard. That
   * held while every order was placed by staff and fulfilled later. A card
   * payment breaks it: the money is taken at checkout, so the inventory is
   * genuinely gone at checkout, but the order is emphatically NOT completed —
   * nobody has picked or posted anything. Decrementing while leaving
   * `completedAt` null would have meant the eventual completion decremented a
   * second time, quietly, for the same units.
   *
   * So the two facts are now stored separately: `completedAt` means "this sale
   * is closed", `stockTakenAt` means "these units have left".
   *
   * NO BACKFILL, DELIBERATELY. Every order written before this field existed
   * has `stockTakenAt: null` while genuinely having had its stock taken if it
   * was completed — so every read of the guard goes through
   * `orderController.stockIsTaken()`, which treats a set `completedAt` as proof
   * of the same thing. A migration would have been the other option, and it
   * would have had to be right first time against live data to avoid inventing
   * or destroying inventory. A two-line helper that is correct for both shapes
   * is the cheaper and safer answer.
   */
  stockTakenAt: {
    type: Date,
    default: null,
  },

  /**
   * Where this order came from. Defaults to `internal` so every order placed
   * before the storefront existed reads correctly with no backfill: it really
   * was placed by staff, through this app, and the default states that
   * truthfully rather than leaving it to be inferred from the absence of a
   * `buyerId`.
   */
  source: {
    type: String,
    enum: {
      values: ['internal', 'storefront'],
      message: 'Source must be internal or storefront',
    },
    default: 'internal',
  },

  /**
   * The buyer account that placed this order, if any.
   *
   * Deliberately separate from `customer`. Every order has a `Customer` — that
   * is the CRM record a sales rep follows up with — but only a storefront
   * order placed by a signed-in buyer also has a `Buyer`: a guest checkout
   * creates or matches a `Customer` and leaves this null, exactly like an
   * order placed by staff does.
   */
  buyerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    default: null,
  },

  /**
   * How a storefront order says it will be paid. Optional and null on every
   * internal order — staff placing an order over the phone are recording a
   * sale, not collecting a payment method — and on any storefront order
   * placed before this field existed. Required at the point of checkout
   * itself; see `shopCheckoutController`, not this schema, for that rule, for
   * the same "don't reach back and invalidate old documents" reason
   * `imageUrl` on Product is optional at the schema level too.
   */
  paymentMethod: {
    type: String,
    enum: {
      values: PAYMENT_METHOD_VALUES,
      message: `Payment method must be one of: ${PAYMENT_METHOD_VALUES.join(', ')}`,
    },
    default: null,
  },

  /**
   * WHERE THE PARCEL IS — the buyer-facing axis, orthogonal to `status`.
   *
   * See the long note beside FULFILMENT_STATUS in config/constants.js for why
   * this is a second field rather than a longer version of the first. In short:
   * `status` decides whether stock moves, delivery does not, and merging them
   * would put the stock decrement on the wrong event.
   *
   * Defaults to `processing`, which is truthful for every order ever placed
   * including the ones that predate this field — none of them has been said to
   * have shipped.
   */
  fulfilment: {
    type: String,
    enum: {
      values: FULFILMENT_STATUS_VALUES,
      message: `Fulfilment must be one of: ${FULFILMENT_STATUS_VALUES.join(', ')}`,
    },
    default: FULFILMENT_STATUS.PROCESSING,
  },

  /** When staff marked it shipped. Null until they do. */
  shippedAt: {
    type: Date,
    default: null,
  },

  /**
   * The date the customer is told to expect it.
   *
   * A DATE, NOT A DAY-COUNT. The brief offered either; a stored date is the
   * right one because a count has to be resolved against a shipment date that
   * may not exist yet, and "3–5 business days" rendered against an order that
   * has not shipped means nothing. Staff set this when they mark the order
   * shipped, and the form offers a sensible default computed from that day.
   */
  estimatedDeliveryAt: {
    type: Date,
    default: null,
  },

  /** When it actually arrived, if anyone said so. */
  deliveredAt: {
    type: Date,
    default: null,
  },

  /**
   * What Stripe knows about this order, mirrored locally.
   *
   * Mirrored rather than fetched on demand: the order list shows payment state
   * for every row, and a live API call per row is out of the question. Stripe
   * remains the source of truth — this is a cache the webhook keeps current,
   * and the ids are here so anything can be reconciled against the dashboard.
   *
   * `status: 'unpaid'` is correct and meaningful for a cash-on-delivery order
   * and for every order placed before payments existed: this app has not seen
   * money for it. That is a fact, not a gap.
   */
  payment: {
    status: {
      type: String,
      enum: {
        values: PAYMENT_STATUS_VALUES,
        message: `Payment status must be one of: ${PAYMENT_STATUS_VALUES.join(', ')}`,
      },
      default: PAYMENT_STATUS.UNPAID,
    },
    /** Stripe's Checkout Session id (`cs_test_...`). */
    sessionId: { type: String, default: null },
    /** Stripe's PaymentIntent id (`pi_...`) — what a refund is issued against. */
    paymentIntentId: { type: String, default: null },
    /** In minor units (cents), as Stripe reports it — never a float. */
    amountPaid: { type: Number, default: null },
    currency: { type: String, default: null },
    paidAt: { type: Date, default: null },
    refundId: { type: String, default: null },
    refundedAt: { type: Date, default: null },
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/* ---------------------------------------------------------------------------
 * INDEXES
 * -------------------------------------------------------------------------*/

/* The status filter plus the default newest-first ordering, in one index. */
/*
 * WHY EVERY SORTING INDEX ENDS WITH `_id`
 *
 * `getSort` appends `_id` to every sort so the ordering is total (see the long
 * note in utils/queryHelpers.js — without it, tied documents can appear on two
 * pages at once). That fix has a consequence that is easy to miss and was
 * caught here by an explain() test rather than by reading the code:
 *
 *   an index on { createdAt: -1 } does NOT satisfy a sort of
 *   { createdAt: -1, _id: -1 }
 *
 * MongoDB falls back to fetching every matching document and sorting them in
 * memory. The index still exists, the query still returns the right answer, and
 * the only symptom is that it got slower — which is precisely the kind of
 * regression that goes unnoticed until the collection is large.
 *
 * So each index below carries `_id` in the same direction as its sort field.
 */

orderSchema.index({ status: 1, createdAt: -1, _id: -1 });

/*
 * Orders for one customer — the customer detail screen, and the `?customer=`
 * filter. `createdAt` is included so that screen's ordering comes free.
 */
orderSchema.index({ customer: 1, createdAt: -1, _id: -1 });

/*
 * The other half of the sales-rep scope: { $or: [{ createdBy }, { customer: { $in: [...] } }] }.
 *
 * As on Customer, an $or evaluates each branch separately, so each branch needs
 * its own index. This one was missing entirely, which meant every order list
 * request from a sales rep scanned the collection.
 */
orderSchema.index({ createdBy: 1, createdAt: -1, _id: -1 });

/*
 * The default ordering for admins and managers, whose scope filter is `{}` so
 * nothing narrows the query before the sort. It also serves the ?from/?to date
 * range, which is a range scan on the same field.
 */
orderSchema.index({ createdAt: -1, _id: -1 });

/* Sorting by value — "the biggest orders", on the dashboard and the list. */
orderSchema.index({ total: -1, _id: -1 });

/*
 * The third branch of the sales-rep scope, now that an order can be assigned
 * independently of its customer. Same reasoning as the two above: an $or
 * evaluates each branch separately, so a branch without an index is a
 * collection scan no matter how well the others are served.
 */
orderSchema.index({ assignedTo: 1, createdAt: -1, _id: -1 });

/*
 * Looking an order up by the number a human quoted — the entire point of having
 * one — and enforcing that no two orders share a number.
 *
 * PARTIAL rather than sparse, and the distinction is the whole reason this
 * comment exists. A sparse unique index skips only documents where the field is
 * ABSENT; one explicitly set to null is present, so every unnumbered order past
 * the first would be rejected with a duplicate key error on null. A partial
 * index conditioned on the value being a string ignores nulls and absences
 * alike, so historical orders coexist happily and real numbers stay unique.
 */
orderSchema.index(
  { orderNumber: 1 },
  { unique: true, partialFilterExpression: { orderNumber: { $type: 'string' } } }
);

/*
 * The delivery queue: "what is waiting to be shipped", which is the filter
 * staff actually work from. Carries `createdAt` and `_id` for the same
 * total-ordering reason as every other sorting index in this file.
 */
orderSchema.index({ fulfilment: 1, createdAt: -1, _id: -1 });

/*
 * Finding the order a Stripe webhook is talking about.
 *
 * The webhook arrives knowing only a session id, and it can arrive TWICE —
 * Stripe retries until it gets a 2xx, and a network blip on our side is enough
 * to earn a retry for an event already handled. The unique constraint is what
 * makes the second delivery a no-op rather than a second order: two documents
 * can never share a session id, so a duplicate insert is refused by the
 * database rather than by a check that could be raced.
 *
 * PARTIAL rather than sparse, for the same reason `orderNumber` above is:
 * `sessionId` defaults to null and a sparse unique index only skips ABSENT
 * fields, so every cash-on-delivery order past the first would collide on null.
 */
orderSchema.index(
  { 'payment.sessionId': 1 },
  { unique: true, partialFilterExpression: { 'payment.sessionId': { $type: 'string' } } }
);

module.exports = mongoose.model('Order', orderSchema);
