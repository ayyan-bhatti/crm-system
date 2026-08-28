const { money } = require('../utils/format');

/**
 * The summary written without a model.
 *
 * WHY THIS EXISTS RATHER THAN AN ERROR
 *
 * Every figure on the summary screen is computed from the database, so when the
 * AI call fails nothing about the *data* is unavailable — only the wording is.
 * Returning a 503 in that situation would hide correct information behind a
 * failure in the optional part of the feature, which is the wrong trade every
 * time. It is also what the existing AI search does, so the two behave alike.
 *
 * The wording is deliberately plainer than the model's. It is not trying to
 * imitate one — a template pretending to be a generated summary would be
 * harder to trust than one that obviously is not, and the response says which
 * mode produced it so the UI can label it honestly.
 */

/** Short description of what the trend classification means, in plain words. */
const TREND_PHRASES = {
  rising: 'Spending is up compared with the previous quarter.',
  steady: 'Spending is steady compared with the previous quarter.',
  declining: 'Spending is down compared with the previous quarter.',
  new: 'This is a new relationship with no earlier history to compare against.',
  dormant: 'There has been no activity in the last two quarters.',
  no_orders: 'They have not placed an order yet.',
};

function buildFallbackSummary(customer, metrics) {
  const { orderCount, totalRevenue, daysSinceLastOrder, trend, averageOrderValue } = metrics;

  if (orderCount === 0) {
    return {
      headline: 'No orders yet',
      summary:
        `${customer.name} was added on ${formatDate(customer.createdAt)} and has not placed ` +
        'an order yet.',
      recommendedAction: 'Make first contact and find out what they need.',
      confidence: 'low',
    };
  }

  const parts = [
    `${orderCount} order${orderCount === 1 ? '' : 's'} totalling ${money(totalRevenue)}` +
      (averageOrderValue ? `, averaging ${money(averageOrderValue)} each.` : '.'),
  ];

  if (daysSinceLastOrder !== null) {
    parts.push(
      daysSinceLastOrder === 0
        ? 'Their most recent order was today.'
        : `Last ordered ${daysSinceLastOrder} day${daysSinceLastOrder === 1 ? '' : 's'} ago.`
    );
  }

  parts.push(TREND_PHRASES[trend] || '');

  if (metrics.storefrontOrderCount > 0) {
    parts.push(
      `${metrics.storefrontOrderCount} of those order${
        metrics.storefrontOrderCount === 1 ? ' was' : 's were'
      } placed through the storefront directly.`
    );
  }

  return {
    headline: buildHeadline(metrics),
    summary: parts.filter(Boolean).join(' '),
    recommendedAction: recommendAction(metrics),
    // Never higher than 'medium': a template cannot judge how well the data
    // supports a conclusion, so claiming high confidence would be a lie told by
    // a string concatenation.
    confidence: orderCount >= 3 ? 'medium' : 'low',
  };
}

function buildHeadline({ trend, daysSinceLastOrder, orderCount }) {
  if (trend === 'rising') return 'Growing account';
  if (trend === 'dormant') return 'Gone quiet';
  if (trend === 'declining') return 'Spending is falling';
  if (daysSinceLastOrder !== null && daysSinceLastOrder > 90) return 'Overdue a follow-up';
  if (orderCount === 1) return 'One order so far';
  return 'Steady account';
}

/**
 * A next step, chosen by rule.
 *
 * Rules rather than prose because there are only a few honest recommendations
 * that follow from these figures alone, and the template should not pretend to
 * more insight than that.
 */
function recommendAction({ trend, daysSinceLastOrder, orderCount }) {
  if (trend === 'dormant' || (daysSinceLastOrder !== null && daysSinceLastOrder > 120)) {
    return 'Reach out to check whether their needs have changed.';
  }
  if (trend === 'declining') {
    return 'Ask what has changed before the account goes quiet.';
  }
  if (trend === 'rising') {
    return 'Good time to discuss a larger or recurring order.';
  }
  if (orderCount === 1) {
    return 'Follow up on the first order to encourage a second.';
  }
  return 'Keep the regular check-in scheduled.';
}

function formatDate(value) {
  if (!value) return 'an unknown date';
  return new Date(value).toISOString().slice(0, 10);
}

module.exports = { buildFallbackSummary, TREND_PHRASES };
