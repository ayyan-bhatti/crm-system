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

productSchema.index({ name: 'text', sku: 'text', category: 'text' });
productSchema.index({ category: 1 });

module.exports = mongoose.model('Product', productSchema);
