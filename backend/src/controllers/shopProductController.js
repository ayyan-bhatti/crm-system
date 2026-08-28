const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { containsRegex, getPagination } = require('../utils/queryHelpers');

/**
 * The public storefront catalogue: `/api/shop/products*`.
 *
 * Public, unauthenticated — anyone, including a search engine, reaches these.
 * That is what makes the projection below load-bearing rather than cosmetic:
 * `productController.getProduct` hands back the FULL document to any
 * authenticated staff member, `lowStockThreshold` included, and that is fine
 * for an internal audience. Nothing here may repeat that for the public —
 * see the narrowing already applied to `/users/assignable` for the same
 * reasoning applied to a different leak.
 */

/**
 * Exactly what a storefront visitor is shown, and nothing else. No cost
 * fields exist on `Product` today, but the list is explicit rather than "the
 * schema minus a blocklist" so that a future internal-only field (margin,
 * a supplier note, `lowStockThreshold`) is excluded by default instead of
 * shipping to the public the day someone adds it and forgets this file.
 */
const PUBLIC_PRODUCT_FIELDS = 'name price description imageUrl category stockQty';

/** `in stock` as a boolean is the public fact; the exact count is not. */
function toPublicShape(product) {
  return {
    _id: product._id,
    name: product.name,
    price: product.price,
    description: product.description || '',
    imageUrl: product.imageUrl || '',
    category: product.category,
    inStock: product.stockQty > 0,
  };
}

/**
 * GET /api/shop/products
 * Filters: ?category= ?search=
 * Paging:  ?page= ?limit=
 */
const listPublicProducts = asyncHandler(async (req, res) => {
  const { category, search } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const filter = {};
  if (category) filter.category = category;
  if (search) filter.name = containsRegex(search);

  const [data, total] = await Promise.all([
    Product.find(filter)
      .select(PUBLIC_PRODUCT_FIELDS)
      .sort({ name: 1, _id: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Product.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: data.map(toPublicShape),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

/** GET /api/shop/products/:id */
const getPublicProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id).select(PUBLIC_PRODUCT_FIELDS).lean();

  if (!product) throw ApiError.notFound('Product not found');

  res.json({ success: true, data: toPublicShape(product) });
});

/**
 * GET /api/shop/products/search?q=something for a rainy weekend under $50
 *
 * See services/shopSearchService.js for how this reuses the internal AI
 * search's filter-translation step against the public projection.
 */
const searchProducts = asyncHandler(async (req, res) => {
  const query = req.query.q;
  if (typeof query !== 'string' || !query.trim()) {
    throw ApiError.badRequest('A non-empty "q" query parameter is required');
  }

  // Lazy required: shopSearchService itself requires this file, for the
  // public shape helpers — requiring it back here at module load time would
  // be a circular import.
  const { search } = require('../services/shopSearchService');
  const result = await search(query.trim());

  res.json({ success: true, mode: result.mode, ...(result.reason && { reason: result.reason }), data: result.data });
});

/** GET /api/shop/products/:id/recommendations — "you might also like". */
const getRecommendations = asyncHandler(async (req, res) => {
  const { getRecommendations: run } = require('../services/recommendationService');
  const result = await run(req.params.id);

  res.json({ success: true, mode: result.mode, reason: result.reason, data: result.data });
});

module.exports = {
  listPublicProducts,
  getPublicProduct,
  searchProducts,
  getRecommendations,
  PUBLIC_PRODUCT_FIELDS,
  toPublicShape,
};
