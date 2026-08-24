const mongoose = require('mongoose');
const { ORDER_STATUS, ORDER_STATUS_VALUES } = require('../config/constants');

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
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
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
  // Set when the order first transitions to `completed`. Used to guarantee
  // stock is only ever decremented once per order.
  completedAt: {
    type: Date,
    default: null,
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

module.exports = mongoose.model('Order', orderSchema);
