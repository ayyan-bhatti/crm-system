const Product = require('../models/Product');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { recordAudit } = require('../services/auditService');
const {
  containsRegex,
  getPagination,
  getSort,
  paginatedResponse,
  applyCursor,
  cursorResponse,
} = require('../utils/queryHelpers');

const SORTABLE_FIELDS = ['name', 'sku', 'price', 'stockQty', 'category', 'createdAt'];

/**
 * Products have no per-record ownership: every authenticated user can read them
 * and only managers/admins can write. That split is enforced entirely by route
 * middleware, which is why there are no permission checks in this file.
 */

/**
 * GET /api/products
 * Filters: ?category= ?lowStock=true ?search= (name / sku)
 * Paging:  ?page= ?limit= ?sort=
 */
const listProducts = asyncHandler(async (req, res) => {
  const { category, lowStock, search } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const filter = {};

  if (category) filter.category = containsRegex(category);

  if (search) {
    const rx = containsRegex(search);
    filter.$or = [{ name: rx }, { sku: rx }];
  }

  // "Low stock" compares two fields on the same document, which a plain
  // comparison cannot express — $expr is what allows field-to-field comparison.
  // It honours each product's own lowStockThreshold rather than one global number.
  if (lowStock === 'true') {
    filter.$expr = { $lte: ['$stockQty', '$lowStockThreshold'] };
  }

  const sort = getSort(req.query, SORTABLE_FIELDS);

  /*
   * Two paging modes on one endpoint, chosen by whether `?cursor=` is present.
   *
   * Offset is the default because the UI wants page numbers and a total.
   * Cursor is there for deep traversal and for callers that cannot tolerate
   * drift — see the long note in utils/queryHelpers.js for the trade-off.
   */
  if (req.query.cursor !== undefined) {
    const data = await Product.find(applyCursor(filter, req.query.cursor, sort))
      .sort(sort)
      .limit(limit + 1);

    return res.json(cursorResponse({ data, limit, sort }));
  }

  const [data, total] = await Promise.all([
    Product.find(filter).sort(sort).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  return res.json(paginatedResponse({ data, total, page, limit }));
});

/**
 * GET /api/products/options?search=&limit=
 *
 * The product picker's endpoint. Same reasoning as the customer one — see the
 * note there for why this is not just the list endpoint with a small limit.
 *
 * `stockQty` and `price` are included even though they are not part of the
 * label, because the order form shows both next to each option and uses stock
 * for its immediate feedback. Fetching them here saves a second request per
 * selected product, which would otherwise be the picker's real cost.
 */
const listProductOptions = asyncHandler(async (req, res) => {
  const { search } = req.query;
  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 20), 25);

  const filter = {};

  if (search) {
    const rx = containsRegex(search);
    filter.$or = [{ name: rx }, { sku: rx }];
  }

  /*
   * `variants` is selected too, and leaving it out was a real bug rather than
   * a missing nicety.
   *
   * The staff order form builds its lines from these options, so without the
   * variants it could not know a product HAS colours — it offered the product,
   * sent a line with no variant, and the API correctly refused with "sold in
   * specific colours — choose one before ordering". The form gave no way to
   * choose one, so every variant product in the catalogue was simply
   * unorderable from the CRM, and it looked like the New Order page was broken
   * rather than like a missing field.
   *
   * Unlike the storefront projection, the per-variant `stockQty` is included.
   * That rule exists to stop an ANONYMOUS shopper reading inventory levels;
   * this route is staff-only and already returns the product-level count for
   * the same reason the form needs it — to warn before the server has to.
   */
  const data = await Product.find(filter)
    .select('name sku price stockQty variants')
    .sort({ name: 1 })
    .limit(limit)
    .lean();

  res.json({ success: true, count: data.length, data });
});

/**
 * GET /api/products/categories
 * The distinct category list, for populating the filter dropdown in the UI.
 * Declared before `/:id` in the router so "categories" isn't read as an id.
 */
const listCategories = asyncHandler(async (req, res) => {
  const categories = await Product.distinct('category');
  res.json({ success: true, count: categories.length, data: categories.sort() });
});

/** GET /api/products/:id */
const getProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  res.json({ success: true, data: product });
});

/** POST /api/products — managers and admins only. */
/**
 * Validate and normalise a `variants` array from a request body.
 *
 * DONE HERE RATHER THAN LEFT TO THE SCHEMA, for the same reason `resolveAssignee`
 * in the order controller validates before saving: Mongoose's message for a
 * failed subdocument validator names a path (`variants.2.color.hex`) and the
 * person filling in the form needs to know which ROW is wrong and why.
 *
 * The duplicate check is the part that is not merely cosmetic. Two rows for the
 * same colour and size are not a typo to be tidied — they are two independent
 * stock pools for one buyable thing, so half the stock becomes unreachable
 * (nothing can pick the second one) and the product's headline `stockQty`
 * over-reports what can actually be sold.
 */
function normaliseVariants(raw) {
  if (raw === undefined) return undefined;

  if (!Array.isArray(raw)) {
    throw ApiError.badRequest('variants must be a list');
  }

  if (raw.length > 40) {
    throw ApiError.badRequest('A product can have at most 40 variants');
  }

  const seen = new Set();

  return raw.map((entry, index) => {
    const row = index + 1;
    const colorName = String(entry?.color?.name ?? entry?.colorName ?? '').trim();
    const colorHex = String(entry?.color?.hex ?? entry?.colorHex ?? '').trim();
    const size = String(entry?.size ?? '').trim();
    const stockQty = Number(entry?.stockQty);

    if (!colorName) {
      throw ApiError.badRequest(`Variant ${row} needs a colour name`);
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(colorHex)) {
      throw ApiError.badRequest(
        `Variant ${row} ("${colorName}") needs a six-digit hex colour like #1a2b3c`
      );
    }
    if (!Number.isInteger(stockQty) || stockQty < 0) {
      throw ApiError.badRequest(
        `Variant ${row} ("${colorName}") needs a whole quantity of 0 or more`
      );
    }

    const key = `${colorName.toLowerCase()}::${size.toLowerCase()}`;
    if (seen.has(key)) {
      throw ApiError.badRequest(
        `Variant ${row} repeats "${colorName}${size ? ` / ${size}` : ''}". ` +
          'Combine them into one row with the total quantity.'
      );
    }
    seen.add(key);

    const priceOverride =
      entry?.priceOverride === undefined ||
      entry?.priceOverride === null ||
      entry?.priceOverride === ''
        ? null
        : Number(entry.priceOverride);

    if (priceOverride !== null && (Number.isNaN(priceOverride) || priceOverride < 0)) {
      throw ApiError.badRequest(`Variant ${row} ("${colorName}") has an invalid price`);
    }

    /*
     * `_id` is carried through when the client sends one, so an EDIT keeps the
     * same variant ids. Dropping them would mint new ones on every save, which
     * would orphan the `variantId` snapshot on every existing order line and
     * make live stock for that colour unaddressable.
     */
    return {
      ...(entry?._id ? { _id: entry._id } : {}),
      color: { name: colorName, hex: colorHex.toLowerCase() },
      size,
      stockQty,
      priceOverride,
    };
  });
}

/** Validate an image gallery: a list of non-empty URL strings. */
function normaliseImages(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw ApiError.badRequest('images must be a list');

  const cleaned = raw.map((url) => String(url || '').trim()).filter(Boolean);
  if (cleaned.length > 8) {
    throw ApiError.badRequest('A product can have at most 8 additional images');
  }
  return cleaned;
}

const createProduct = asyncHandler(async (req, res) => {
  const { name, sku, price, stockQty, category, lowStockThreshold, imageUrl, description } =
    req.body;

  // Required on CREATE only, not on the schema itself — every product seeded
  // or created before this rule existed keeps its empty `imageUrl` and still
  // falls back to the storefront's generated placeholder. A schema-level
  // `required` would instead fail validation the next time any of THOSE
  // products was merely edited for an unrelated field, which is not what
  // "new products need a photo" was ever meant to reach back and break.
  if (!imageUrl || !imageUrl.trim()) {
    throw ApiError.badRequest('Image URL is required for a new product');
  }

  const variants = normaliseVariants(req.body.variants);
  const images = normaliseImages(req.body.images);

  const product = await Product.create({
    name,
    sku,
    price,
    /*
     * When variants are supplied their sum IS the stock, and any `stockQty` in
     * the body is ignored rather than merged. Two sources of truth for one
     * number is how they drift; the model's pre-save hook enforces the same
     * rule on every later write. See the note on that hook.
     */
    stockQty,
    category,
    lowStockThreshold,
    imageUrl,
    description,
    ...(variants ? { variants } : {}),
    ...(images ? { images } : {}),
  });

  await recordAudit(req, {
    action: 'create',
    entity: 'product',
    entityId: product._id,
    after: product,
  });

  res.status(201).json({ success: true, data: product });
});

/** PATCH /api/products/:id — managers and admins only. */
const updateProduct = asyncHandler(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  // Snapshotted before any field is touched — see the note in customerController.
  const before = product.toObject();

  const editable = [
    'name',
    'sku',
    'price',
    'stockQty',
    'category',
    'lowStockThreshold',
    'imageUrl',
    'description',
  ];
  editable.forEach((field) => {
    if (req.body[field] !== undefined) product[field] = req.body[field];
  });

  const variants = normaliseVariants(req.body.variants);
  const images = normaliseImages(req.body.images);

  if (variants !== undefined) product.variants = variants;
  if (images !== undefined) product.images = images;

  // save() rather than findByIdAndUpdate() so schema validators (min: 0 on
  // price and stock) run against the new values — and so the pre-save hook that
  // keeps `stockQty` equal to the sum of the variants actually fires. That hook
  // is why `stockQty` is deliberately NOT recomputed by hand here.
  await product.save();

  // Stock edits are the ones worth being able to trace later: a manual
  // correction and a mistake look identical in the product document itself.
  await recordAudit(req, {
    action: 'update',
    entity: 'product',
    entityId: product._id,
    before,
    after: product,
  });

  res.json({ success: true, data: product });
});

/** DELETE /api/products/:id — managers and admins only. */
const deleteProduct = asyncHandler(async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) throw ApiError.notFound('Product not found');

  await recordAudit(req, {
    action: 'delete',
    entity: 'product',
    entityId: product._id,
    label: product.name,
    before: product,
  });

  res.json({ success: true, message: 'Product deleted', data: { id: req.params.id } });
});

/**
 * GET /api/products/reorder-suggestions — manager and admin.
 *
 * See services/reorderSuggestionService.js — which products appear is
 * decided entirely by code (low stock AND actually selling); the model only
 * writes the justification for each one already chosen.
 */
const getReorderSuggestions = asyncHandler(async (req, res) => {
  const { getSuggestions } = require('../services/reorderSuggestionService');
  const result = await getSuggestions(req.user?._id?.toString() ?? null);

  res.json({ success: true, mode: result.mode, count: result.items.length, data: result.items });
});

module.exports = {
  listProducts,
  listProductOptions,
  listCategories,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getReorderSuggestions,
};
