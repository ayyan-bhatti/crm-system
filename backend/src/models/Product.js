const mongoose = require('mongoose');
const { DEFAULT_LOW_STOCK_THRESHOLD } = require('../config/constants');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: [120, 'Name cannot exceed 120 characters'],
  },
  sku: {
    type: String,
    required: [true, 'SKU is required'],
    unique: true,
    trim: true,
    uppercase: true,
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative'],
  },
  stockQty: {
    type: Number,
    required: [true, 'Stock quantity is required'],
    min: [0, 'Stock quantity cannot be negative'],
    default: 0,
  },
  category: {
    type: String,
    trim: true,
    default: 'Uncategorised',
  },
  // Per-product threshold so a slow-moving item and a fast-moving one can raise
  // the "low stock" flag at different levels.
  lowStockThreshold: {
    type: Number,
    min: [0, 'Threshold cannot be negative'],
    default: DEFAULT_LOW_STOCK_THRESHOLD,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Convenience flag for the UI. Virtuals are not stored in MongoDB, so filtering
 * by low stock in a query uses the $expr form in the product controller rather
 * than this property.
 */
productSchema.virtual('isLowStock').get(function isLowStock() {
  return this.stockQty <= this.lowStockThreshold;
});

// Include virtuals when a product is serialised to JSON for the API response.
productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

/* ---------------------------------------------------------------------------
 * INDEXES
 * -------------------------------------------------------------------------*/

/*
 * REMOVED: a text index on name/sku/category — unused, for the same reason as
 * the one on Customer. Nothing issues a `$text` query; the product list and the
 * picker both use `containsRegex`.
 */

/*
 * `sku` already has a unique index, created automatically by `unique: true`
 * above. That single index does double duty: it enforces uniqueness AND serves
 * the SKU lookups, so there is deliberately no second index on it here.
 */

/* The category filter on the list screen, with the default ordering included. */
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

productSchema.index({ category: 1, name: 1, _id: 1 });

/*
 * Sorting by name: the picker's order, and the products list's most-used sort.
 */
productSchema.index({ name: 1, _id: 1 });

/*
 * Sorting by stock, which is how someone finds what is running out. Ascending
 * because that sort is only ever asked in the "lowest first" direction.
 *
 * Note this does NOT serve `?lowStock=true`, which compares stockQty against
 * each product's own lowStockThreshold. A field-to-field comparison needs
 * `$expr`, and `$expr` cannot use an index at all — the filter is evaluated per
 * document. It is a small collection and a rarely-hit filter, so that is
 * acceptable; the alternative is storing a denormalised boolean and keeping it
 * in step on every write, which is more machinery than the problem deserves.
 */
productSchema.index({ stockQty: 1, _id: 1 });

module.exports = mongoose.model('Product', productSchema);
