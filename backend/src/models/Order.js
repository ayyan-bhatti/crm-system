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

// Supports the status filter and the date-range filter on the orders screen.
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ customer: 1 });

module.exports = mongoose.model('Order', orderSchema);
