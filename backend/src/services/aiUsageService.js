const AiUsageLog = require('../models/AiUsageLog');
const env = require('../config/env');
const { componentLogger } = require('../config/logger');

const log = componentLogger('ai-usage');

/**
 * Recording what AI calls cost, and answering "what are we spending".
 *
 * WHY THE PRICE TABLE IS IN THE CODE AND NOT FETCHED
 *
 * There is no API that reports a model's price, so it has to be written down
 * somewhere. Written down here, with the date it was checked, it is greppable
 * and reviewable — and the estimate it produces is stored per call rather than
 * recomputed on read, so a later price change does not silently rewrite last
 * quarter's spend.
 *
 * The word ESTIMATED is used throughout on purpose. This is a good-faith figure
 * from published per-token rates; it does not know about prompt caching
 * discounts, batch pricing, or the plan the account is actually on. It is for
 * "is this feature costing more than it is worth", not for reconciling an
 * invoice.
 */

/**
 * USD per million tokens, from Google's published Gemini API pricing.
 *
 * `PRICE_CHECKED_ON` exists so that a figure quietly going stale is visible
 * rather than assumed current — a cost report nobody can date is a cost report
 * nobody should trust. It is also why this table was WRONG the moment the
 * provider changed: it still held the previous provider's rates, and would have reported
 * roughly twenty times the real spend without a single test failing, because
 * nothing here can tell a plausible number from a correct one.
 *
 * No entry is carried over for the previous provider. That would normally be
 * wrong — re-costing existing usage rows at the default silently changes what
 * last month cost, which is the one thing a cost report must never do — but
 * there are no such rows to protect: the previous key was never configured on
 * any deployment, so not one call was ever billed. That was the finding that
 * started this work.
 */
const PRICE_CHECKED_ON = '2026-08-23';

const PRICING_USD_PER_MTOK = {
  // Gemini 3 Flash — the model this app actually uses.
  'gemini-3.6-flash': { input: 0.3, output: 2.5 },
  'gemini-flash-latest': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },

  /*
   * Sensible default for an unrecognised model — better a rough number with a
   * warning than silently reporting zero and implying the feature is free.
   * Deliberately the Flash rate rather than the cheapest one: a default that
   * under-reports is how a surprise bill happens.
   */
  default: { input: 0.3, output: 2.5 },
};

function priceFor(model) {
  return PRICING_USD_PER_MTOK[model] || PRICING_USD_PER_MTOK.default;
}

/** Estimated USD for one call. */
function estimateCost({ model, inputTokens = 0, outputTokens = 0 }) {
  const price = priceFor(model);
  const cost = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

  // Six places: a single cheap call is a fraction of a cent, and rounding to
  // four would report most of them as zero.
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * Record one call.
 *
 * Never throws and never blocks the request: a failure to record what something
 * cost must not fail the thing the user asked for. Logged so the gap is known.
 */
async function recordUsage({
  feature,
  model,
  inputTokens = 0,
  outputTokens = 0,
  durationMs = 0,
  attempts = 1,
  outcome = 'ok',
  userId = null,
}) {
  if (env.isTest && !env.aiUsageTrackingInTests) return null;

  try {
    return await AiUsageLog.create({
      feature,
      model,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCost({ model, inputTokens, outputTokens }),
      durationMs: Math.round(durationMs),
      attempts,
      outcome,
      user: userId,
    });
  } catch (err) {
    log.error({ err, feature }, 'could not record AI usage');
    return null;
  }
}

/**
 * Totals over the last `days`, overall and per feature, with a projection.
 *
 * The projection is the number someone actually wants — "at this rate, what
 * does a month cost?" — and it is deliberately labelled as a projection from a
 * window rather than presented as a bill.
 */
async function getUsageSummary(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [overall] = await AiUsageLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: null,
        calls: { $sum: 1 },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        estimatedCostUsd: { $sum: '$estimatedCostUsd' },
        totalDurationMs: { $sum: '$durationMs' },
        // A cache hit costs nothing; counting them is how the cache proves its
        // worth rather than being assumed to work.
        cached: { $sum: { $cond: [{ $eq: ['$outcome', 'cached'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$outcome', 'failed'] }, 1, 0] } },
      },
    },
  ]);

  const byFeature = await AiUsageLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: '$feature',
        calls: { $sum: 1 },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        estimatedCostUsd: { $sum: '$estimatedCostUsd' },
        cached: { $sum: { $cond: [{ $eq: ['$outcome', 'cached'] }, 1, 0] } },
        // Kept per feature, not only in the overall totals — so a feature
        // failing every call can be seen even while the aggregate across
        // every other feature still looks healthy. See services/aiStatus.js.
        failed: { $sum: { $cond: [{ $eq: ['$outcome', 'failed'] }, 1, 0] } },
      },
    },
    { $sort: { estimatedCostUsd: -1 } },
  ]);

  const totals = overall || {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    totalDurationMs: 0,
    cached: 0,
    failed: 0,
  };

  const billableCalls = totals.calls - totals.cached;

  return {
    windowDays: days,
    since,

    pricing: {
      note: 'Estimated from published per-token rates. Excludes caching discounts and plan pricing.',
      checkedOn: PRICE_CHECKED_ON,
      usdPerMillionTokens: PRICING_USD_PER_MTOK,
    },

    totals: {
      calls: totals.calls,
      billableCalls,
      cacheHits: totals.cached,
      cacheHitRate: totals.calls ? round(totals.cached / totals.calls, 4) : 0,
      failedCalls: totals.failed,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      estimatedCostUsd: round(totals.estimatedCostUsd, 4),
      averageDurationMs: billableCalls ? Math.round(totals.totalDurationMs / billableCalls) : 0,
    },

    /*
     * Extrapolated from the window, and named so nobody mistakes it for an
     * invoice. A 7-day window projected to 30 days is a much rougher number
     * than a 30-day one, which is why `windowDays` is returned alongside it.
     */
    projectedMonthlyUsd: days
      ? round((totals.estimatedCostUsd / days) * 30, 4)
      : 0,

    byFeature: byFeature.map((row) => ({
      feature: row._id,
      calls: row.calls,
      cacheHits: row.cached,
      failedCalls: row.failed,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedCostUsd: round(row.estimatedCostUsd, 4),
    })),
  };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round((value || 0) * factor) / factor;
}

module.exports = {
  recordUsage,
  getUsageSummary,
  estimateCost,
  PRICING_USD_PER_MTOK,
  PRICE_CHECKED_ON,
};
