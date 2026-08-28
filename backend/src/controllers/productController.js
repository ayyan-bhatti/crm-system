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

  const data = await Product.find(filter)
    .select('name sku price stockQty')
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
const createProduct = asyncHandler(async (req, res) => {
  const { name, sku, price, stockQty, category, lowStockThreshold, imageUrl, description } =
    req.body;

  const product = await Product.create({
    name,
    sku,
    price,
    stockQty,
    category,
    lowStockThreshold,
    imageUrl,
    description,
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

  // save() rather than findByIdAndUpdate() so schema validators (min: 0 on
  // price and stock) run against the new values.
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

module.exports = {
  listProducts,
  listProductOptions,
  listCategories,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
};
