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
const PUBLIC_PRODUCT_FIELDS =
  'name price description imageUrl images category stockQty lowStockThreshold variants createdAt';

/**
 * `in stock` as a boolean is the public fact; the exact count is not.
 *
 * THE SAME RULE NOW APPLIES PER VARIANT, and it is the reason each variant is
 * reshaped here rather than passed through. A variant subdocument carries
 * `stockQty` — "4 left in Midnight" — and handing that to an anonymous
 * catalogue request would leak inventory levels far more precisely than the
 * product-level count this projection has always been careful to withhold.
 * What a shopper needs is whether they can buy it, which is a boolean.
 *
 * `lowStock` IS exposed, deliberately, and it is a different kind of fact: a
 * boolean the shop chooses to advertise ("Low stock" on the card) rather than a
 * number an observer could use to infer sales volume. It is derived from each
 * product's own threshold, the same one the internal low-stock filter uses.
 *
 * `lowStockThreshold` and the raw counts are read from the database because the
 * booleans are computed from them, and are then dropped. Selecting a field and
 * not returning it is intentional here, not an oversight — the previous version
 * did exactly the same with `stockQty`.
 */
function toPublicShape(product) {
  const variants = (product.variants || []).map((variant) => ({
    _id: variant._id,
    color: { name: variant.color.name, hex: variant.color.hex },
    size: variant.size || '',
    // The variant's own price when it overrides, else the product's.
    price: variant.priceOverride ?? product.price,
    inStock: variant.stockQty > 0,
  }));

  const threshold = product.lowStockThreshold ?? 10;

  return {
    _id: product._id,
    name: product.name,
    price: product.price,
    description: product.description || '',
    imageUrl: product.imageUrl || '',
    images: product.images || [],
    category: product.category,
    inStock: product.stockQty > 0,
    lowStock: product.stockQty > 0 && product.stockQty <= threshold,
    /*
     * The cheapest variant price, so a card can show "from $19" for a product
     * whose colours are priced differently. Null when nothing overrides, which
     * is the overwhelmingly common case and lets the UI skip the "from".
     */
    priceFrom: variants.length
      ? Math.min(...variants.map((v) => v.price))
      : null,
    variants,
    createdAt: product.createdAt,
  };
}

/**
 * GET /api/shop/products
 * Filters: ?category= ?search=
 * Paging:  ?page= ?limit=
 */
/**
 * How the storefront may order results. A fixed map rather than passing the
 * parameter to Mongo, for the usual reason: `?sort=` straight from a query
 * string is an injection surface and lets anyone sort by a field the projection
 * deliberately withholds — sorting by `stockQty` would let an observer read
 * inventory levels off the ORDER of a public list without ever seeing a number.
 *
 * `_id` is appended to each so the ordering is total; see the long note in
 * utils/queryHelpers.js for why a non-total sort can show one document on two
 * pages.
 */
const PUBLIC_SORTS = {
  newest: { createdAt: -1, _id: -1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: -1 },
  name: { name: 1, _id: 1 },
};

/**
 * GET /api/shop/products
 * Filters: ?category= ?search= ?minPrice= ?maxPrice= ?color= ?inStock=true
 * Sorting: ?sort=newest|price_asc|price_desc|name
 * Paging:  ?page= ?limit=
 */
const listPublicProducts = asyncHandler(async (req, res) => {
  const { category, search, minPrice, maxPrice, color, inStock, sort } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const filter = {};
  if (category) filter.category = category;
  if (search) filter.name = containsRegex(search);

  /*
   * Price range. Each bound is applied only if it parses as a number, so a
   * malformed `?maxPrice=cheap` is ignored rather than silently matching
   * nothing — an empty grid is a much worse answer to a typo than an unfiltered
   * one, because it reads as "we sell nothing".
   */
  const min = Number(minPrice);
  const max = Number(maxPrice);
  if (Number.isFinite(min) || Number.isFinite(max)) {
    filter.price = {
      ...(Number.isFinite(min) ? { $gte: min } : {}),
      ...(Number.isFinite(max) ? { $lte: max } : {}),
    };
  }

  /*
   * Colour filter. Matches the variant's colour NAME rather than its hex,
   * because that is what the shopper picked from a list of names — and two
   * products can reasonably render "Navy" as slightly different hexes without a
   * shopper considering them different colours.
   */
  if (color) {
    filter['variants.color.name'] = containsRegex(String(color));
  }

  /*
   * "In stock only". `stockQty` is the right field even for a product with
   * variants, because the model keeps it equal to the sum of them — so a
   * product whose every colour is sold out has a zero here too.
   */
  if (inStock === 'true') filter.stockQty = { $gt: 0 };

  const order = PUBLIC_SORTS[sort] || PUBLIC_SORTS.name;

  const [data, total] = await Promise.all([
    Product.find(filter).select(PUBLIC_PRODUCT_FIELDS).sort(order).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data: data.map(toPublicShape),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

/**
 * GET /api/shop/products/categories — public.
 *
 * A PUBLIC ENDPOINT WAS GENUINELY MISSING, and its absence was invisible.
 *
 * The storefront's category filter was calling `/api/products/categories`, the
 * INTERNAL one, which sits behind `protect`. For an anonymous shopper — that is,
 * for essentially every visitor — it returned 401, and the caller swallowed the
 * failure with `.catch(() => {})`. The result was a category filter that simply
 * rendered nothing, for everyone except a staff member who happened to have a
 * CRM session open in the same browser. It looked like a design decision.
 *
 * The mega-menu makes the same call, so it needed fixing anyway; this is the
 * public counterpart, returning distinct category names and nothing else.
 */
const listPublicCategories = asyncHandler(async (req, res) => {
  const categories = await Product.distinct('category');
  res.json({ success: true, data: categories.filter(Boolean).sort() });
});

/**
 * GET /api/shop/products/colours — public.
 *
 * Every distinct colour across the catalogue, for the filter's swatch row.
 * Names are deduplicated case-insensitively and the first hex seen for a name
 * wins, so "Navy" appears once even where two products spell its hex slightly
 * differently.
 */
const listPublicColours = asyncHandler(async (req, res) => {
  const products = await Product.find({ 'variants.0': { $exists: true } })
    .select('variants.color')
    .lean();

  const byName = new Map();

  for (const product of products) {
    for (const variant of product.variants || []) {
      const key = variant.color?.name?.toLowerCase();
      if (key && !byName.has(key)) {
        byName.set(key, { name: variant.color.name, hex: variant.color.hex });
      }
    }
  }

  res.json({
    success: true,
    data: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
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

  res.json({
    success: true,
    mode: result.mode,
    ...(result.reason && { reason: result.reason }),
    /*
     * The words actually searched for, on the fallback path only.
     *
     * `tokenize` strips filler, so the terms are rarely the words that were
     * typed — surfacing them is the difference between "no results" and "no
     * results *for this*". Same reasoning as the internal AI search bar,
     * which already shows them for exactly this reason.
     */
    ...(result.terms && { terms: result.terms }),
    data: result.data,
  });
});

/** GET /api/shop/products/:id/recommendations — "you might also like". */
const getRecommendations = asyncHandler(async (req, res) => {
  const { getRecommendations: run } = require('../services/recommendationService');
  const result = await run(req.params.id);

  res.json({ success: true, mode: result.mode, reason: result.reason, data: result.data });
});

module.exports = {
  listPublicProducts,
  listPublicCategories,
  listPublicColours,
  getPublicProduct,
  searchProducts,
  getRecommendations,
  PUBLIC_PRODUCT_FIELDS,
  toPublicShape,
};
