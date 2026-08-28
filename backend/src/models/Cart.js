const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: [true, 'A cart line must reference a product'],
    },
    quantity: {
      type: Number,
      required: [true, 'Quantity is required'],
      min: [1, 'Quantity must be at least 1'],
    },
  },
  { _id: false }
);

/**
 * A signed-in buyer's cart, kept server-side so it survives across devices.
 *
 * A GUEST'S CART NEVER REACHES THIS COLLECTION.
 *
 * The storefront cart is client-side state (localStorage) until someone is
 * signed in — see the checkout build-log entry. This model exists only for
 * the moment a cart needs to survive a browser: a buyer who adds items on
 * their phone and finishes checkout on a laptop. No cost/margin data lives
 * here, only a product reference and a quantity; price is resolved fresh at
 * checkout time from the product's current price, same as every other order
 * path in this app — a cart is not a quote and does not lock in a price.
 *
 * One cart per buyer, enforced by the unique index below rather than by a
 * lookup-then-create in the controller — the unique index is what actually
 * prevents two concurrent "first add to cart" requests from creating two cart
 * documents for the same buyer.
 */
const cartSchema = new mongoose.Schema({
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    required: true,
    unique: true,
  },
  items: {
    type: [cartItemSchema],
    default: [],
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

cartSchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Cart', cartSchema);
