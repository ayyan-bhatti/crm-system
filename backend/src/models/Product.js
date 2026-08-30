const mongoose = require('mongoose');
const { DEFAULT_LOW_STOCK_THRESHOLD } = require('../config/constants');

/**
 * One buyable combination of a product: a colour, optionally a size, and the
 * stock that specific combination has.
 *
 * `_id` IS DELIBERATELY LEFT ON (most embedded schemas in this app turn it
 * off). It is the address by which a single variant's stock is decremented
 * atomically:
 *
 *   { _id: productId, variants: { $elemMatch: { _id: v, stockQty: { $gte: q } } } }
 *   { $inc: { 'variants.$.stockQty': -q } }
 *
 * Without a stable id per variant there is nothing to match on but the colour
 * name, which is user-supplied, editable, and duplicable — so the atomic
 * guarantee would rest on a string somebody can change from a form. It is also
 * what an order line snapshots, so a rep reading a two-year-old order can still
 * tell which variant went out even after the product has been re-coloured.
 *
 * `priceOverride` is null for the overwhelmingly common case where every colour
 * of a thing costs the same. Null rather than a copy of the product price
 * because a copy would silently stop tracking the parent the moment the parent
 * changed — the same bug `priceAtOrder` on an order line exists to CREATE
 * deliberately, and which here would be entirely accidental.
 */
const variantSchema = new mongoose.Schema({
  color: {
    name: {
      type: String,
      required: [true, 'A variant needs a colour name'],
      trim: true,
      maxlength: [40, 'Colour name cannot exceed 40 characters'],
    },
    /*
     * The swatch. Validated for shape rather than trusted, because it is
     * interpolated straight into a `style` attribute on the storefront — an
     * unvalidated string there is a small but real injection surface, and
     * "#f00" vs "red" vs "javascript:..." is exactly the kind of difference a
     * regex should be deciding rather than a designer's memory.
     */
    hex: {
      type: String,
      required: [true, 'A variant needs a colour swatch'],
      trim: true,
      match: [/^#[0-9a-fA-F]{6}$/, 'Colour must be a six-digit hex code like #1a2b3c'],
    },
  },
  /**
   * Optional second dimension. Empty string, not null, so that a product whose
   * variants are colour-only compares cleanly against one whose variants have
   * sizes — `''` is a value the UI can render as "one size" without a
   * null-check at every use.
   */
  size: {
    type: String,
    trim: true,
    default: '',
    maxlength: [24, 'Size cannot exceed 24 characters'],
  },
  stockQty: {
    type: Number,
    required: [true, 'A variant needs its own stock quantity'],
    min: [0, 'Stock quantity cannot be negative'],
    default: 0,
  },
  priceOverride: {
    type: Number,
    min: [0, 'Price cannot be negative'],
    default: null,
  },
});

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
  /**
   * A picture for the storefront catalogue. Optional and untrusted content:
   * this is a URL, not an upload, so nothing here is validated beyond shape —
   * the storefront falls back to a placeholder image for any product that
   * has none, which every product created before this field existed will.
   */
  imageUrl: {
    type: String,
    trim: true,
    default: '',
  },
  /**
   * Storefront copy — a sentence or two a shopper reads, not an internal
   * note. Optional and empty by default, same reasoning as `imageUrl`: every
   * product that existed before the storefront did still displays correctly,
   * just with no description shown rather than a validation failure.
   */
  description: {
    type: String,
    trim: true,
    default: '',
    maxlength: [2000, 'Description cannot exceed 2000 characters'],
  },

  /**
   * Additional photographs, beyond `imageUrl`.
   *
   * `imageUrl` REMAINS THE PRIMARY IMAGE rather than becoming `images[0]`, and
   * this is the deliberate part. Every product in the database already has
   * `imageUrl` populated, every card and cart line already reads it, and the
   * card's hover-swap wants "the second image, if there is one" — which is
   * exactly what this array is. Collapsing both into one array would have meant
   * a migration, a rewrite of six read sites, and a window in which a product
   * with no images renders nothing; keeping them separate costs one helper
   * (`galleryFor`) and breaks nothing.
   */
  images: {
    type: [String],
    default: [],
    validate: {
      validator: (list) => list.length <= 8,
      message: 'A product can have at most 8 additional images',
    },
  },

  /**
   * Colour (and optionally size) combinations, each with its own stock.
   *
   * EMPTY IS A FIRST-CLASS STATE, NOT A MISSING ONE. A product with no variants
   * is sold as a single undifferentiated thing whose stock is `stockQty`, which
   * is precisely what every product in this database was before this field
   * existed. Nothing about the storefront, the order form, the stock decrement
   * or the AI reorder suggestions changes for those products. See
   * `orderController.buildOrderItems` for the one branch that tells them apart.
   */
  variants: {
    type: [variantSchema],
    default: [],
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * Keep the product's headline `stockQty` equal to the sum of its variants.
 *
 * WHY DENORMALISE AT ALL, GIVEN IT CAN DRIFT
 *
 * Because a dozen things read `stockQty` and none of them care about colour:
 * the low-stock filter, the reorder-suggestion AI, the dashboard tiles, the
 * order form's live warning, the storefront's `inStock` boolean. Rewriting all
 * of them to sum an array — and to sum it inside a MongoDB query, which means
 * `$expr` and no index — would be a large change to make a small number of
 * screens marginally more correct.
 *
 * Drift is prevented rather than tolerated: this hook owns the value on every
 * save, and `decrementStock` adjusts both the variant and the parent in ONE
 * atomic update so the two cannot separate even under concurrency. The sum is
 * never computed from a read-then-write.
 */
productSchema.pre('save', function syncStockFromVariants(next) {
  if (this.variants && this.variants.length > 0) {
    this.stockQty = this.variants.reduce((sum, v) => sum + (v.stockQty || 0), 0);
  }
  next();
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
