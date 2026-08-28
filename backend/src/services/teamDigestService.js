const Order = require('../models/Order');
const User = require('../models/User');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const { ORDER_STATUS } = require('../config/constants');

const log = componentLogger('ai-team-digest');

const WINDOW_DAYS = 7;
const MAX_NARRATIVE = 900;

/**
 * The weekly team performance digest, for a manager or admin.
 *
 * Same split as the customer summary: every figure below is computed with
 * MongoDB doing the arithmetic, and the model's only job is to narrate
 * numbers it is handed, never to produce or check one.
 */

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** This week's and last week's figures, plus a per-rep breakdown of this week. */
async function computeWeeklyFigures() {
  const since = daysAgo(WINDOW_DAYS);
  const previousSince = daysAgo(WINDOW_DAYS * 2);

  const [thisWeek] = await Order.aggregate([
    { $match: { status: ORDER_STATUS.COMPLETED, completedAt: { $gte: since } } },
    { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
  ]);

  const [lastWeek] = await Order.aggregate([
    {
      $match: {
        status: ORDER_STATUS.COMPLETED,
        completedAt: { $gte: previousSince, $lt: since },
      },
    },
    { $group: { _id: null, revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
  ]);

  const byRep = await Order.aggregate([
    {
      $match: {
        status: ORDER_STATUS.COMPLETED,
        completedAt: { $gte: since },
        assignedTo: { $ne: null },
      },
    },
    { $group: { _id: '$assignedTo', revenue: { $sum: '$total' }, orders: { $sum: 1 } } },
    { $sort: { revenue: -1 } },
  ]);

  const repIds = byRep.map((r) => r._id);
  const reps = await User.find({ _id: { $in: repIds } }).select('name');
  const nameById = new Map(reps.map((r) => [String(r._id), r.name]));

  const round = (n) => Math.round((n || 0) * 100) / 100;

  return {
    windowDays: WINDOW_DAYS,
    revenue: round(thisWeek?.revenue),
    orders: thisWeek?.orders || 0,
    previousRevenue: round(lastWeek?.revenue),
    previousOrders: lastWeek?.orders || 0,
    byRep: byRep.map((r) => ({
      name: nameById.get(String(r._id)) || 'Former colleague',
      revenue: round(r.revenue),
      orders: r.orders,
    })),
  };
}

function validateNarrative(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const narrative = string(raw.narrative, MAX_NARRATIVE);
  return narrative ? { narrative } : null;
}

function buildSystemPrompt() {
  return `You write a short weekly performance digest for a sales manager, narrating
figures that have ALREADY been calculated from the database. Never calculate, estimate
or restate a number differently than given. Mention which reps did well by name if the
data shows a clear leader; do not rank reps if the numbers are close enough that doing
so would be misleading. Two to four sentences, direct, no filler.

Respond with a JSON object only: {"narrative": "<the digest text>"}`;
}

function callModel(figures, userId) {
  return aiClient.complete({
    feature: 'team-digest',
    userId,
    system: buildSystemPrompt(),
    user: JSON.stringify(figures),
    maxTokens: 500,
  });
}

function fallbackNarrative(figures) {
  const change =
    figures.previousRevenue > 0
      ? Math.round(((figures.revenue - figures.previousRevenue) / figures.previousRevenue) * 100)
      : null;

  const trend =
    change === null
      ? ''
      : change > 0
        ? ` That's up ${change}% on the week before.`
        : change < 0
          ? ` That's down ${Math.abs(change)}% on the week before.`
          : ' That matches the week before.';

  const leader = figures.byRep[0]
    ? ` ${figures.byRep[0].name} led the team with ${figures.byRep[0].orders} order${
        figures.byRep[0].orders === 1 ? '' : 's'
      }.`
    : '';

  return (
    `${figures.orders} order${figures.orders === 1 ? '' : 's'} completed this week, ` +
    `totalling ${figures.revenue}.${trend}${leader}`
  );
}

/** The weekly digest. Never throws. `{ mode, figures, narrative }`. */
async function getDigest(userId = null) {
  const figures = await computeWeeklyFigures();

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', figures, narrative: fallbackNarrative(figures) };
  }

  let text;
  try {
    text = await callModel(figures, userId);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the templated digest');
    return { mode: 'fallback', figures, narrative: fallbackNarrative(figures) };
  }

  const result = parseAndValidate(text, validateNarrative);
  if (!result.ok) return { mode: 'fallback', figures, narrative: fallbackNarrative(figures) };

  return { mode: 'ai', figures, narrative: result.value.narrative };
}

module.exports = { getDigest, computeWeeklyFigures, validateNarrative };
