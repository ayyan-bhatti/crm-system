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

module.exports = mongoose.model('Order', orderSchema);
