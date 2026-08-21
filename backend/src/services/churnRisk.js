/**
 * Churn risk: is this customer going quiet?
 *
 * WHY THIS IS NOT JUST THE HEALTH SCORE AGAIN
 *
 * The RFM score answers "how valuable is this relationship". Churn risk answers
 * a different question — "is it ending" — and the two genuinely disagree. A
 * customer with 40 orders and £50k of revenue who has not bought in six months
 * scores extremely well and is the single most urgent call to make. A score
 * cannot express that, because most of its inputs are historical and history
 * does not decay.
 *
 * WHY IT IS RELATIVE TO EACH CUSTOMER'S OWN CADENCE
 *
 * The obvious implementation is a fixed threshold: 90 days without an order
 * means at risk. That is wrong in both directions, and expensively so.
 *
 *   A customer who orders every three weeks and has been silent for 90 days is
 *   four cycles overdue. Something has happened — they are buying elsewhere, or
 *   their contact left. That is the most urgent call in the book.
 *
 *   A customer who orders once a year, every year, is at 90 days exactly where
 *   they always are. Flagging them wastes a call and teaches the rep that the
 *   flag means nothing.
 *
 * So the measure is how many of the customer's OWN typical gaps have elapsed
 * since their last order. Everything needed for that — first order, last order,
 * completed count — is already computed in customerMetrics, so this adds a
 * calculation and no new data, no new query, and no AI call.
 *
 * WHY IT IS COMPUTED, NOT GENERATED
 *
 * Same reasoning as the health score. A rep asking "why is this flagged?"
 * deserves "they normally order every 24 days and it has been 96" — a fact they
 * can check and act on — rather than a model's opinion that changes on refresh.
 * The AI writes the surrounding prose; the flag is arithmetic.
 */

/**
 * How many of a customer's own gaps must pass before the relationship looks
 * like it is ending.
 *
 * Chosen so that ordinary variation does not trip it. Someone who orders
 * roughly monthly is often a fortnight late; at 1.5 gaps they are noticeably
 * overdue, and at 3 they have missed two whole cycles, which is no longer a
 * delay but a pattern.
 */
const MODERATE_AT_GAPS = 1.5;
const HIGH_AT_GAPS = 3;

/**
 * Fallback thresholds for a customer with only ONE order.
 *
 * There is no cadence to measure against — one order gives no gap — so this is
 * the one place a fixed number is unavoidable. It is deliberately generous,
 * because a single purchase says very little: someone who bought once four
 * months ago may simply not need anything yet, and calling them "high risk"
 * on that evidence is the kind of false positive that makes a rep ignore the
 * column.
 */
const SINGLE_ORDER_MODERATE_DAYS = 120;
const SINGLE_ORDER_HIGH_DAYS = 240;

const LEVELS = {
  UNKNOWN: 'unknown',
  LOW: 'low',
  MODERATE: 'moderate',
  HIGH: 'high',
};

/**
 * The customer's typical gap between orders, in days.
 *
 * Measured across the whole relationship rather than between the last two
 * orders: two orders placed a day apart during one busy week would otherwise
 * suggest a one-day cadence and flag them as catastrophically overdue by
 * Thursday.
 *
 * @returns {number|null} null when there are too few orders to say.
 */
function typicalGapDays({ completedCount, firstOrderDate, lastOrderDate }) {
  if (completedCount < 2 || !firstOrderDate || !lastOrderDate) return null;

  const spanMs = new Date(lastOrderDate).getTime() - new Date(firstOrderDate).getTime();
  const gaps = completedCount - 1;
  const days = spanMs / gaps / (24 * 60 * 60 * 1000);

  // Several orders on the same day produce a zero or near-zero span, which
  // would make every subsequent day look like an infinite number of missed
  // cycles. Treating that as "no measurable cadence" is the honest answer.
  return days >= 1 ? days : null;
}

/**
 * Assess churn risk from the metrics customerMetrics already computed.
 *
 * Returns the level AND the reasoning behind it — the explanation is the
 * feature, exactly as with the health score. A flag a rep cannot interrogate is
 * a flag they learn to ignore.
 *
 * @param {object} metrics from computeCustomerMetrics
 * @returns {{ level: string, label: string, reason: string, gapsOverdue: number|null,
 *             typicalGapDays: number|null }}
 */
function assessChurnRisk(metrics) {
  const { completedCount = 0, daysSinceLastOrder, trend } = metrics;

  /*
   * Never bought anything. That is not churn — there is no relationship to
   * lose — it is an unconverted lead, and calling it "low risk" would be
   * technically true and actively misleading on a screen a rep uses to decide
   * who to chase.
   */
  if (!completedCount || daysSinceLastOrder === null || daysSinceLastOrder === undefined) {
    return {
      level: LEVELS.UNKNOWN,
      label: 'No purchase history',
      reason: 'This customer has not completed an order yet, so there is no pattern to compare against.',
      gapsOverdue: null,
      typicalGapDays: null,
    };
  }

  const gap = typicalGapDays(metrics);

  // ---- One order: no cadence to measure, so fall back to fixed thresholds ----
  if (gap === null) {
    if (daysSinceLastOrder >= SINGLE_ORDER_HIGH_DAYS) {
      return {
        level: LEVELS.HIGH,
        label: 'Likely lost',
        reason: `Their only order was ${daysSinceLastOrder} days ago and has not been repeated.`,
        gapsOverdue: null,
        typicalGapDays: null,
      };
    }

    if (daysSinceLastOrder >= SINGLE_ORDER_MODERATE_DAYS) {
      return {
        level: LEVELS.MODERATE,
        label: 'Not yet repeated',
        reason: `They ordered once, ${daysSinceLastOrder} days ago, and have not come back.`,
        gapsOverdue: null,
        typicalGapDays: null,
      };
    }

    return {
      level: LEVELS.LOW,
      label: 'Too early to tell',
      reason: `Their first order was ${daysSinceLastOrder} days ago — not long enough to read anything into.`,
      gapsOverdue: null,
      typicalGapDays: null,
    };
  }

  // ---- The normal case: measured against their own rhythm ----
  const gapsOverdue = daysSinceLastOrder / gap;
  const rounded = Math.round(gap);

  const cadence = `They normally order about every ${rounded} day${rounded === 1 ? '' : 's'}`;
  const silence = `it has been ${daysSinceLastOrder}`;

  if (gapsOverdue >= HIGH_AT_GAPS) {
    return {
      level: LEVELS.HIGH,
      label: 'At risk of churn',
      reason: `${cadence}, and ${silence} — around ${Math.floor(gapsOverdue)} cycles missed.`,
      gapsOverdue: round(gapsOverdue),
      typicalGapDays: rounded,
    };
  }

  if (gapsOverdue >= MODERATE_AT_GAPS) {
    return {
      level: LEVELS.MODERATE,
      label: 'Overdue an order',
      reason: `${cadence}, and ${silence}.`,
      gapsOverdue: round(gapsOverdue),
      typicalGapDays: rounded,
    };
  }

  /*
   * On schedule by cadence — but a falling spend is still worth surfacing.
   *
   * Someone ordering on time for steadily less money is leaving slowly, and the
   * cadence measure alone would never notice. This is the one place the trend
   * classification feeds in, and it only ever raises the level by one step.
   */
  if (trend === 'declining') {
    return {
      level: LEVELS.MODERATE,
      label: 'Spending less',
      reason: `${cadence} and are on schedule, but their spend has fallen against the previous quarter.`,
      gapsOverdue: round(gapsOverdue),
      typicalGapDays: rounded,
    };
  }

  return {
    level: LEVELS.LOW,
    label: 'On track',
    reason: `${cadence}, and their last order was ${daysSinceLastOrder} days ago — on schedule.`,
    gapsOverdue: round(gapsOverdue),
    typicalGapDays: rounded,
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

module.exports = {
  assessChurnRisk,
  typicalGapDays,
  LEVELS,
  MODERATE_AT_GAPS,
  HIGH_AT_GAPS,
  SINGLE_ORDER_MODERATE_DAYS,
  SINGLE_ORDER_HIGH_DAYS,
};
