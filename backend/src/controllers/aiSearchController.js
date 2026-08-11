const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
// Imported as a namespace rather than destructured so tests can stub
// `translateQuery` without making a live API call.
const aiSearchService = require('../services/aiSearchService');
const { runFilter, runKeywordSearch } = require('../services/filterTranslator');
const { customerScopeFilter } = require('./customerController');
const { orderScopeFilter } = require('./orderController');

const MAX_QUERY_LENGTH = 500;

/**
 * POST /api/ai-search
 *
 * Body: { "query": "customers in Karachi with no orders in the last 30 days" }
 *
 * Always answers with results. If the AI path is unavailable for any reason the
 * response falls back to a keyword search and says so, so the UI can label what
 * the user is looking at rather than showing an error.
 *
 * Response:
 *   {
 *     success: true,
 *     mode: "ai" | "fallback",
 *     reason: "<why the fallback happened>",   // fallback only
 *     terms: ["karachi"],                       // words searched, fallback only
 *     entity: "customer",
 *     filter: { ... },                          // the structured filter, ai only
 *     count: 12,
 *     data: [ ... ]
 *   }
 */
const aiSearch = asyncHandler(async (req, res) => {
  const { query, entity: requestedEntity } = req.body;

  if (typeof query !== 'string' || !query.trim()) {
    throw ApiError.badRequest('A non-empty "query" string is required');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw ApiError.badRequest(`Query cannot exceed ${MAX_QUERY_LENGTH} characters`);
  }

  // Role scoping is resolved up front, for whichever entity the model picks.
  // The same scope filters the normal list endpoints use are applied here, so
  // a sales rep cannot reach another rep's records through AI search.
  const scopeFilters = {
    customer: customerScopeFilter(req.user),
    order: await orderScopeFilter(req.user),
    product: {}, // products have no per-user ownership
  };

  const translation = await aiSearchService.translateQuery(query.trim());

  // --- Fallback: keyword search ---------------------------------------------
  if (translation.mode === 'fallback') {
    const { entity, data, terms } = await runKeywordSearch(query, scopeFilters, requestedEntity);

    return res.json({
      success: true,
      mode: 'fallback',
      reason: translation.reason,
      entity,
      filter: null,
      // The words actually searched for, after filler was stripped. Without
      // this a user cannot tell why a question produced these results.
      terms,
      count: data.length,
      data,
    });
  }

  // --- AI path: run the validated structured filter --------------------------
  const { filter } = translation;
  const { data } = await runFilter(filter, scopeFilters[filter.entity]);

  return res.json({
    success: true,
    mode: 'ai',
    entity: filter.entity,
    filter,
    count: data.length,
    data,
  });
});

module.exports = { aiSearch };
