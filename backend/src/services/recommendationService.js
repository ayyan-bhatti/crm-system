const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const { toPublicShape, PUBLIC_PRODUCT_FIELDS } = require('../controllers/shopProductController');

const log = componentLogger('ai-recommendations');

const RECOMMEND_LIMIT = 4;
const MAX_REASON = 160;

/**
 * "You might also like" — on the product page and the cart.
 *
 * THE LIST IS COMPUTED, NEVER GENERATED.
 *
 * Which products appear is decided entirely by co-purchase counts from real
 * completed orders — the model is not asked to suggest products, and could
 * not invent one that passed validation even if it tried, since the reply
 * schema below has no field a product could go in. Its only job is one short
 * line explaining why this particular list makes sense together, which is
 * exactly the kind of judgement a fixed template does badly (the co-purchase
 * reason for two products bought together is different every time; the code
 * that counts pairs has no way to say what it is).
 */

/** Products most often bought alongside `productId`, from completed orders. */
async function coPurchased(productId, limit) {
  const id = new mongoose.Types.ObjectId(String(productId));

  const rows = await Order.aggregate([
    { $match: { status: 'completed', 'items.product': id } },
    { $unwind: '$items' },
    { $match: { 'items.product': { $ne: id } } },
    { $group: { _id: '$items.product', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);

  return rows.map((r) => r._id);
}

/** Fallback when there is no purchase history yet: same category, in stock. */
async function sameCategoryFallback(product, limit, excludeIds) {
  const rows = await Product.find({
    _id: { $nin: [product._id, ...excludeIds] },
    category: product.category,
    stockQty: { $gt: 0 },
  })
    .select(PUBLIC_PRODUCT_FIELDS)
    .limit(limit)
    .lean();

  return rows;
}

function validateReason(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reason = string(raw.reason, MAX_REASON);
  return reason ? { reason } : null;
}

function callModel(anchorName, recommended) {
  return aiClient.complete({
    feature: 'shop-recommendations',
    system:
      'You write one short, friendly sentence explaining why a list of products is being ' +
      'recommended together on a storefront. You are given the product someone is looking ' +
      'at and the list they will be shown — both already decided. Do not suggest a ' +
      'different product, and do not mention any product not in the given list. ' +
      'Respond with a JSON object only: {"reason": "<one sentence, no more than 20 words>"}',
    user: JSON.stringify({
      viewing: anchorName,
      recommended: recommended.map((p) => p.name),
    }),
    maxTokens: 200,
  });
}

/**
 * Recommendations for the product/cart pages.
 *
 * Never throws. `{ mode: 'ai'|'fallback', reason, data }` — `data` is always
 * populated from real orders (or the category fallback) regardless of mode;
 * only the one-line explanation differs.
 */
async function getRecommendations(productId) {
  const product = await Product.findById(productId).select(PUBLIC_PRODUCT_FIELDS);
  if (!product) return { mode: 'fallback', reason: 'Product not found', data: [] };

  const coIds = await coPurchased(productId, RECOMMEND_LIMIT);
  let data = coIds.length
    ? await Product.find({ _id: { $in: coIds } }).select(PUBLIC_PRODUCT_FIELDS).lean()
    : [];

  let basis = 'co-purchase';
  if (data.length < RECOMMEND_LIMIT) {
    const extra = await sameCategoryFallback(
      product,
      RECOMMEND_LIMIT - data.length,
      data.map((p) => p._id)
    );
    if (data.length === 0) basis = 'category';
    data = [...data, ...extra];
  }

  const shaped = data.map(toPublicShape);

  if (!shaped.length) {
    return { mode: 'fallback', reason: 'Nothing to recommend yet', data: [] };
  }

  const genericReason =
    basis === 'co-purchase'
      ? 'Frequently bought together with this item.'
      : `Popular in ${product.category}.`;

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', reason: genericReason, data: shaped };
  }

  let text;
  try {
    text = await callModel(product.name, shaped);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the generic reason');
    return { mode: 'fallback', reason: genericReason, data: shaped };
  }

  const result = parseAndValidate(text, validateReason);
  if (!result.ok) return { mode: 'fallback', reason: genericReason, data: shaped };

  return { mode: 'ai', reason: result.value.reason, data: shaped };
}

module.exports = { getRecommendations, coPurchased, validateReason };
