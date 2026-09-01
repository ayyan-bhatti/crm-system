const mongoose = require('mongoose');
const Order = require('../models/Order');
const { ORDER_STATUS } = require('../config/constants');

/**
 * Every number the customer summary is built from, computed from the database.
 *
 * THE POINT OF THIS FILE
 *
 * The AI feature is "summarise this customer". The tempting shape is to hand
 * the model the customer's order history and ask it to describe it — and that
 * is exactly the shape that produces a CRM which confidently reports the wrong
 * revenue. Language models are not arithmetic engines: they will add fourteen
 * order totals and be plausibly, invisibly wrong, and the person reading the
 * summary has no way to tell.
 *
 * So the division is absolute:
 *
 *   this file      computes every figure, with MongoDB doing the arithmetic
 *   the model      receives those figures and writes prose about them
 *
 * The model never sees raw orders and is never asked to count anything. If the
 * AI call fails entirely, these numbers are still correct and still shown —
 * which is why the endpoint degrades to a template rather than to an error.
 */

/** Revenue window used for the trend comparison, in days. */
const TREND_WINDOW_DAYS = 90;

/**
 * Only completed orders count as revenue.
 *
 * Pending orders are not money yet — they may still be cancelled — and counting
 * them would make the summary optimistic in exactly the situation where
 * accuracy matters. Cancelled orders obviously do not count. Stating this in
 * one place matters because the dashboard and the summary must agree; two
 * different definitions of "revenue" in one product is a support ticket
 * waiting to happen.
 */
const REVENUE_STATUS = ORDER_STATUS.COMPLETED;

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Aggregate one customer's order history into the figures the summary needs.
 *
 * A single aggregation pipeline rather than several queries: it is one round
 * trip, and — more importantly — every figure is computed from the same view of
 * the data, so the order count and the revenue can never disagree because an
 * order arrived between two separate reads.
 *
 * @returns {Promise<object>} plain numbers, safe to send to the model.
 */
async function computeCustomerMetrics(customerId) {
  const id = new mongoose.Types.ObjectId(String(customerId));

  const windowStart = daysAgo(TREND_WINDOW_DAYS);
  const previousWindowStart = daysAgo(TREND_WINDOW_DAYS * 2);

  const [result] = await Order.aggregate([
    { $match: { customer: id } },
    {
      $group: {
        _id: null,

        // Every order, whatever its status — "they placed 12 orders" includes
        // the ones they cancelled, and hiding those would misrepresent the
        // relationship.
        orderCount: { $sum: 1 },

        completedCount: {
          $sum: { $cond: [{ $eq: ['$status', REVENUE_STATUS] }, 1, 0] },
        },
        cancelledCount: {
          $sum: { $cond: [{ $eq: ['$status', ORDER_STATUS.CANCELLED] }, 1, 0] },
        },

        totalRevenue: {
          $sum: { $cond: [{ $eq: ['$status', REVENUE_STATUS] }, '$total', 0] },
        },

        /*
         * Split by where the order came from, so the summary can say a
         * customer buys through both channels rather than treating a
         * storefront purchase as if a rep had entered it. Every order counts
         * here regardless of status, same as `orderCount` above — a
         * cancelled storefront order is still evidence somebody tried to buy
         * something.
         */
        storefrontOrderCount: {
          $sum: { $cond: [{ $eq: ['$source', 'storefront'] }, 1, 0] },
        },

        // The two trend windows, summed in the same pass.
        recentRevenue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', REVENUE_STATUS] },
                  { $gte: ['$createdAt', windowStart] },
                ],
              },
              '$total',
              0,
            ],
          },
        },
        previousRevenue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', REVENUE_STATUS] },
                  { $gte: ['$createdAt', previousWindowStart] },
                  { $lt: ['$createdAt', windowStart] },
                ],
              },
              '$total',
              0,
            ],
          },
        },

        firstOrderDate: { $min: '$createdAt' },
        lastOrderDate: { $max: '$createdAt' },
      },
    },
  ]);

  const base = result || {
    orderCount: 0,
    completedCount: 0,
    cancelledCount: 0,
    totalRevenue: 0,
    recentRevenue: 0,
    previousRevenue: 0,
    firstOrderDate: null,
    lastOrderDate: null,
    storefrontOrderCount: 0,
  };

  const totalRevenue = round(base.totalRevenue);

  return {
    orderCount: base.orderCount,
    completedCount: base.completedCount,
    cancelledCount: base.cancelledCount,

    totalRevenue,
    // Average across COMPLETED orders only, to stay consistent with revenue.
    // Dividing revenue by every order (including cancellations) would produce a
    // number that is not the average of anything.
    averageOrderValue: base.completedCount ? round(totalRevenue / base.completedCount) : 0,

    firstOrderDate: base.firstOrderDate,
    lastOrderDate: base.lastOrderDate,
    daysSinceLastOrder: base.lastOrderDate ? daysBetween(base.lastOrderDate, new Date()) : null,

    trend: describeTrend(base),
    trendWindowDays: TREND_WINDOW_DAYS,
    recentRevenue: round(base.recentRevenue),
    previousRevenue: round(base.previousRevenue),

    storefrontOrderCount: base.storefrontOrderCount,
    internalOrderCount: base.orderCount - base.storefrontOrderCount,
  };
}

/**
 * The same figures, for MANY customers, in one pipeline.
 *
 * WHY THIS EXISTS RATHER THAN A LOOP OVER `computeCustomerMetrics`
 *
 * The marketing contacts screen shows a segment tag for every row, and those
 * tags are read off these metrics. Calling the single-customer function once
 * per row is one aggregation per contact — a hundred round trips to render one
 * page, and a thousand once the book grows. That is not a performance nicety:
 * a list that takes twelve seconds is a list nobody filters, and the filtering
 * is the feature.
 *
 * WHY THE ARITHMETIC IS DUPLICATED RATHER THAN SHARED
 *
 * It is not duplicated — it is the same `$group` body with a different `_id`.
 * The definitions that matter (revenue is completed orders only; the trend
 * windows are 90 days and the 90 before that) are stated once at the top of
 * this file and used by both, so the two cannot disagree about what revenue
 * means. That was the risk worth designing against: a contacts screen calling
 * someone "high value" on a different definition of value from the one their
 * own summary page uses.
 *
 * @param {Array} customerIds
 * @returns {Promise<Map<string, object>>} keyed by customer id as a string.
 *   Customers with no orders are ABSENT rather than present with zeroes — the
 *   caller has to distinguish "no purchase history" from "spent nothing", and
 *   a zero-filled row cannot express the difference.
 */
async function computeMetricsForCustomers(customerIds) {
  const ids = (customerIds || [])
    .filter(Boolean)
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  if (!ids.length) return new Map();

  const windowStart = daysAgo(TREND_WINDOW_DAYS);
  const previousWindowStart = daysAgo(TREND_WINDOW_DAYS * 2);

  const rows = await Order.aggregate([
    { $match: { customer: { $in: ids } } },
    {
      $group: {
        _id: '$customer',
        orderCount: { $sum: 1 },
        completedCount: {
          $sum: { $cond: [{ $eq: ['$status', REVENUE_STATUS] }, 1, 0] },
        },
        totalRevenue: {
          $sum: { $cond: [{ $eq: ['$status', REVENUE_STATUS] }, '$total', 0] },
        },
        recentRevenue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', REVENUE_STATUS] },
                  { $gte: ['$createdAt', windowStart] },
                ],
              },
              '$total',
              0,
            ],
          },
        },
        previousRevenue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$status', REVENUE_STATUS] },
                  { $gte: ['$createdAt', previousWindowStart] },
                  { $lt: ['$createdAt', windowStart] },
                ],
              },
              '$total',
              0,
            ],
          },
        },
        firstOrderDate: { $min: '$createdAt' },
        lastOrderDate: { $max: '$createdAt' },
      },
    },
  ]);

  const now = new Date();
  const byCustomer = new Map();

  for (const row of rows) {
    const totalRevenue = round(row.totalRevenue);

    byCustomer.set(String(row._id), {
      orderCount: row.orderCount,
      completedCount: row.completedCount,
      totalRevenue,
      averageOrderValue: row.completedCount ? round(totalRevenue / row.completedCount) : 0,
      firstOrderDate: row.firstOrderDate,
      lastOrderDate: row.lastOrderDate,
      daysSinceLastOrder: row.lastOrderDate ? daysBetween(row.lastOrderDate, now) : null,
      trend: describeTrend(row),
      recentRevenue: round(row.recentRevenue),
      previousRevenue: round(row.previousRevenue),
    });
  }

  return byCustomer;
}

/**
 * Classify the revenue trend.
 *
 * Deliberately coarse — five buckets, not a percentage. A percentage change
 * between two 90-day windows sounds precise and is mostly noise for a customer
 * with three orders; a word is honest about how much the data actually
 * supports. The 20% threshold is a judgement, chosen so an ordinary variation
 * in one order's size does not read as a trend.
 */
function describeTrend({ orderCount, recentRevenue, previousRevenue }) {
  if (orderCount === 0) return 'no_orders';

  // Nothing in either window: the relationship has gone quiet.
  if (recentRevenue === 0 && previousRevenue === 0) return 'dormant';

  // Bought recently with no prior history to compare against.
  if (previousRevenue === 0) return 'new';

  if (recentRevenue === 0) return 'declining';

  const change = (recentRevenue - previousRevenue) / previousRevenue;

  if (change > 0.2) return 'rising';
  if (change < -0.2) return 'declining';
  return 'steady';
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000));
}

/** Money to two decimals — floating-point sums otherwise produce 1249.9999999. */
function round(value) {
  return Math.round((value || 0) * 100) / 100;
}

module.exports = {
  computeCustomerMetrics,
  computeMetricsForCustomers,
  describeTrend,
  TREND_WINDOW_DAYS,
  REVENUE_STATUS,
};
