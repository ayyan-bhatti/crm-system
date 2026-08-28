const Product = require('../models/Product');
const aiSearchService = require('./aiSearchService');
const { conditionsToMongo, tokenize } = require('./filterTranslator');
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
   * Fallback: a case-insensitive keyword match, the same honest degradation
   * the internal search's keyword path offers.
   *
   * TWO THINGS THIS USED TO GET WRONG, both found by running the fallback
   * against a real catalogue rather than against a test fixture.
   *
   * It split on whitespace and kept every word of two characters or more, so
   * a shopper's actual phrasing — "something waterproof under $50" — searched
   * for "something" and "under" as if they were product names. `tokenize` is
   * the internal search's own stop-word-aware splitter and already solves
   * this; it is reused here rather than reimplemented, which is the whole
   * reason it lives in `filterTranslator` and not inline there.
   *
   * And it matched on `name` ALONE. A storefront shopper describes what a
   * thing is, not what it is called: "waterproof" is in the Rain Jacket's
   * description and "outdoor" is its category, and neither is in its name, so
   * the one query a shopper is most likely to type returned nothing at all
   * while the product sat in the catalogue. Description and category are both
   * already public — they are in `PUBLIC_PRODUCT_FIELDS` and rendered on the
   * product page — so searching them exposes nothing new.
   */
  const terms = tokenize(query);

  const mongoQuery = terms.length
    ? {
        $or: terms.flatMap((term) => [
          { name: containsRegex(term) },
          { description: containsRegex(term) },
          { category: containsRegex(term) },
        ]),
      }
    : {};

  const data = await Product.find(mongoQuery)
    .select(PUBLIC_PRODUCT_FIELDS)
    .sort({ name: 1 })
    .limit(20)
    .lean();

  return {
    mode: 'fallback',
    reason: translation.reason || 'Search entity was not "product"',
    terms,
    data: data.map(toPublicShape),
  };
}

module.exports = { search };
