const Product = require('../models/Product');
const Order = require('../models/Order');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const { ORDER_STATUS } = require('../config/constants');

const log = componentLogger('ai-reorder-suggestions');

const VELOCITY_WINDOW_DAYS = 30;
const MAX_SUGGESTIONS = 10;
const MAX_JUSTIFICATION = 160;

/**
 * Which products need reordering, and why, for a manager.
 *
 * WHICH PRODUCTS APPEAR IS ENTIRELY CODE'S DECISION.
 *
 * A product qualifies by two facts the database already knows: it is at or
 * below its own `lowStockThreshold`, and it has actually sold recently — a
 * low-stock product nobody is buying is not urgent, it is just quiet. The
 * model is never asked which products to flag and could not change the list
 * even if it tried, since the response schema only has room for one
 * justification string per product ALREADY in the list, matched by
 * position. If the model returns the wrong number of justifications, the
 * entire response is rejected rather than guessed at — a mismatched count
 * means the reply cannot be trusted to be about this exact list.
 */

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Units of each product sold via completed orders in the velocity window. */
async function recentVelocity() {
  const since = daysAgo(VELOCITY_WINDOW_DAYS);

  const rows = await Order.aggregate([
    { $match: { status: ORDER_STATUS.COMPLETED, completedAt: { $gte: since } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.product', units: { $sum: '$items.quantity' } } },
  ]);

  return new Map(rows.map((r) => [String(r._id), r.units]));
}

/** Low-stock products that are actually selling, ranked by how fast. */
async function computeCandidates() {
  const lowStock = await Product.find({
    $expr: { $lte: ['$stockQty', '$lowStockThreshold'] },
  }).select('name sku category stockQty lowStockThreshold');

  const velocity = await recentVelocity();

  return lowStock
    .map((p) => ({
      productId: p._id,
      name: p.name,
      sku: p.sku,
      category: p.category,
      stockQty: p.stockQty,
      lowStockThreshold: p.lowStockThreshold,
      unitsSoldRecently: velocity.get(String(p._id)) || 0,
    }))
    .filter((p) => p.unitsSoldRecently > 0)
    .sort((a, b) => b.unitsSoldRecently - a.unitsSoldRecently)
    .slice(0, MAX_SUGGESTIONS);
}

/** Validate the model's reply against the EXACT candidate list, by position. */
function makeValidator(candidates) {
  return function validate(raw) {
    if (!raw || !Array.isArray(raw.items)) return null;
    if (raw.items.length !== candidates.length) return null;

    const justifications = raw.items.map((item) =>
      item && typeof item === 'object' ? string(item.justification, MAX_JUSTIFICATION) : null
    );

    if (justifications.some((j) => !j)) return null;

    return { justifications };
  };
}

function buildSystemPrompt() {
  return `You write a one-line reorder justification for each product in a fixed list of
low-stock, fast-selling products at a retailer. The list and its figures — stock level,
threshold, and units sold in the last ${VELOCITY_WINDOW_DAYS} days — are ALREADY decided;
you are not choosing which products to flag, only explaining each one briefly. Return
exactly one justification per product, IN THE SAME ORDER as given. Never invent a number
not given to you.

Respond with a JSON object only:
{"items": [{"justification": "<one short sentence>"}, ...]}`;
}

function callModel(candidates, userId) {
  return aiClient.complete({
    feature: 'reorder-suggestions',
    userId,
    system: buildSystemPrompt(),
    // eslint-disable-next-line no-unused-vars -- productId is intentionally excluded from the payload
    user: JSON.stringify(candidates.map(({ productId, ...rest }) => rest)),
    maxTokens: 800,
  });
}

function fallbackJustification(candidate) {
  return (
    `${candidate.unitsSoldRecently} sold in the last ${VELOCITY_WINDOW_DAYS} days, ` +
    `${candidate.stockQty} left (threshold ${candidate.lowStockThreshold}).`
  );
}

/**
 * Reorder suggestions. Never throws.
 * `{ mode: 'ai'|'fallback', items: [{ ...candidate, justification }] }`.
 */
async function getSuggestions(userId = null) {
  const candidates = await computeCandidates();

  if (!candidates.length) {
    return { mode: 'fallback', items: [] };
  }

  if (!aiClient.isConfigured()) {
    return {
      mode: 'fallback',
      items: candidates.map((c) => ({ ...c, justification: fallbackJustification(c) })),
    };
  }

  let text;
  try {
    text = await callModel(candidates, userId);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the deterministic justifications');
    return {
      mode: 'fallback',
      items: candidates.map((c) => ({ ...c, justification: fallbackJustification(c) })),
    };
  }

  const result = parseAndValidate(text, makeValidator(candidates));
  if (!result.ok) {
    return {
      mode: 'fallback',
      items: candidates.map((c) => ({ ...c, justification: fallbackJustification(c) })),
    };
  }

  return {
    mode: 'ai',
    items: candidates.map((c, i) => ({ ...c, justification: result.value.justifications[i] })),
  };
}

module.exports = { getSuggestions, computeCandidates, makeValidator };
