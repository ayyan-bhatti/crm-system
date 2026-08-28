const Product = require('../models/Product');
const aiSearchService = require('./aiSearchService');
const { conditionsToMongo } = require('./filterTranslator');
const { containsRegex } = require('../utils/queryHelpers');
const { toPublicShape, PUBLIC_PRODUCT_FIELDS } = require('../controllers/shopProductController');

/**
 * Natural-language product search for the storefront.
 *
 * SAME PATTERN AS THE INTERNAL AI SEARCH, A DIFFERENT LAST STEP.
 *
 * `aiSearchService.translateQuery` — free text in, a validated structured
 * filter out — is reused exactly as it is for staff, forced to the
 * `product` entity: a storefront visitor is never asking about customers or
 * orders, and there is no role scope to resolve here in the first place, so
 * nothing about the translation step needs to differ. What has to differ is
 * the LAST step. `filterTranslator.runFilter` hands back full `Product`
 * documents — correct for staff, wrong here, since the storefront must
 * never return `sku`, `lowStockThreshold`, or an exact stock count. So this
 * takes the validated filter's already-built Mongo query
 * (`conditionsToMongo`, the same helper `runFilter` itself uses) and runs it
 * through the identical narrow projection `GET /api/shop/products` uses —
 * one public shape, whichever way a product was found.
 */

async function search(query) {
  const translation = await aiSearchService.translateQuery(query, { entity: 'product' });

  if (translation.mode === 'ai' && translation.filter.entity === 'product') {
    const { conditions, sort, limit } = translation.filter;
    const mongoQuery = conditionsToMongo(conditions);

    const data = await Product.find(mongoQuery)
      .select(PUBLIC_PRODUCT_FIELDS)
      .sort({ [sort.field]: sort.direction === 'asc' ? 1 : -1 })
      .limit(limit)
      .lean();

    return { mode: 'ai', data: data.map(toPublicShape) };
  }

  /*
   * Fallback: a plain case-insensitive substring match on the name, ranked
   * by nothing in particular — the same honest degradation the internal
   * search's keyword path offers, scoped to the one field a shopper's
   * question is actually about.
   */
  const terms = String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);

  const mongoQuery = terms.length
    ? { $or: terms.map((term) => ({ name: containsRegex(term) })) }
    : {};

  const data = await Product.find(mongoQuery)
    .select(PUBLIC_PRODUCT_FIELDS)
    .sort({ name: 1 })
    .limit(20)
    .lean();

  return {
    mode: 'fallback',
    reason: translation.reason || 'Search entity was not "product"',
    data: data.map(toPublicShape),
  };
}

module.exports = { search };
