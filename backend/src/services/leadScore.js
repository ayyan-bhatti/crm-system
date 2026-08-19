/**
 * Customer health score, computed from RFM.
 *
 * WHY THIS IS ARITHMETIC AND NOT AN AI CALL
 *
 * It would be easy to ask the model for a score, and it would look more
 * impressive on a feature list. It would also be the wrong choice, for three
 * reasons that are worth being able to say out loud:
 *
 *   1. REPRODUCIBILITY. The same customer, unchanged, must score the same today
 *      and tomorrow. A model asked twice returns two answers, and a health
 *      score that drifts on refresh is not a metric — it is a mood.
 *   2. TESTABILITY. A formula can be unit tested against known inputs. "Is 72
 *      the right score for this customer?" has an answer here and does not have
 *      one for a model.
 *   3. EXPLAINABILITY. A sales rep asking "why is this account at 41?" deserves
 *      "because the last order was 140 days ago", not a paraphrase of a hidden
 *      judgement. The breakdown below IS the explanation, and it is returned
 *      alongside the number.
 *
 * The AI still has a job: it writes the *narrative* about the score (Phase 2.1).
 * Numbers from code, words from the model — the same division as the summary,
 * for the same reason.
 *
 * WHY RFM
 *
 * Recency, Frequency, Monetary value is the standard retail/CRM segmentation
 * model, which matters here for a practical reason: it is a known method with a
 * literature behind it, so the weights below are a documented judgement rather
 * than three numbers someone invented on a Tuesday.
 */

/**
 * The weights. These are the part a business would tune, so they are named,
 * kept together, and each is justified.
 *
 *   RECENCY 40%   — the strongest single predictor of whether a customer buys
 *                   again. Someone who bought last week is a live relationship;
 *                   someone who bought once two years ago mostly is not,
 *                   whatever they spent.
 *   FREQUENCY 35% — repeat buying is habit, and habit is what a rep can build
 *                   on. Weighted close to recency because a regular small
 *                   customer is usually worth more attention than a one-off
 *                   large one.
 *   MONETARY 25%  — deliberately the smallest. Revenue is the most visible
 *                   number and the most misleading one on its own: a single
 *                   large order from a customer who never returned should not
 *                   outrank a steady account.
 */
const WEIGHTS = {
  recency: 0.4,
  frequency: 0.35,
  monetary: 0.25,
};

/**
 * Thresholds, in the units the component measures.
 *
 * Chosen for a general B2B cadence — a customer who orders roughly monthly is
 * healthy, one silent for half a year is not. A business with a different
 * rhythm (annual renewals, daily consumables) would move these, which is why
 * they are one table rather than scattered through the code.
 */
const RECENCY_BANDS = [
  { maxDays: 30, score: 100 },
  { maxDays: 60, score: 85 },
  { maxDays: 90, score: 70 },
  { maxDays: 180, score: 45 },
  { maxDays: 365, score: 20 },
  { maxDays: Infinity, score: 5 },
];

const FREQUENCY_BANDS = [
  { minOrders: 10, score: 100 },
  { minOrders: 6, score: 85 },
  { minOrders: 3, score: 65 },
  { minOrders: 2, score: 45 },
  { minOrders: 1, score: 25 },
  { minOrders: 0, score: 0 },
];

/**
 * Monetary is scored against a fixed ladder rather than against other
 * customers.
 *
 * A percentile would be more statistically respectable and much worse in
 * practice: it needs the whole customer base loaded to score one customer, and
 * — the real problem — a customer's score would change because *someone else*
 * placed an order. A score that moves without the customer doing anything is
 * impossible to explain to the person looking at it.
 */
const MONETARY_BANDS = [
  { minRevenue: 25000, score: 100 },
  { minRevenue: 10000, score: 85 },
  { minRevenue: 5000, score: 70 },
  { minRevenue: 1000, score: 50 },
  { minRevenue: 1, score: 30 },
  { minRevenue: 0, score: 0 },
];

/** Score bands, used for the label and the colour in the UI. */
const HEALTH_BANDS = [
  { min: 75, label: 'healthy' },
  { min: 50, label: 'stable' },
  { min: 25, label: 'at_risk' },
  { min: 0, label: 'dormant' },
];

function scoreRecency(daysSinceLastOrder) {
  // Never ordered. Not the same as "ordered a long time ago" — there is no
  // relationship to have lapsed — but it scores the same, because in both cases
  // the rep's next action is to make contact.
  if (daysSinceLastOrder === null || daysSinceLastOrder === undefined) return 0;

  return RECENCY_BANDS.find((band) => daysSinceLastOrder <= band.maxDays).score;
}

function scoreFrequency(completedCount) {
  return FREQUENCY_BANDS.find((band) => completedCount >= band.minOrders).score;
}

function scoreMonetary(totalRevenue) {
  return MONETARY_BANDS.find((band) => totalRevenue >= band.minRevenue).score;
}

/**
 * Compute the health score from the metrics in customerMetrics.js.
 *
 * Returns the number AND the breakdown that produced it. The breakdown is not
 * debug output — it is the feature. A score with no explanation is a number
 * people learn to ignore.
 *
 * @param {object} metrics from computeCustomerMetrics
 * @returns {{ score: number, band: string, components: object[] }}
 */
function calculateLeadScore(metrics) {
  const components = [
    {
      key: 'recency',
      label: 'Recency',
      weight: WEIGHTS.recency,
      score: scoreRecency(metrics.daysSinceLastOrder),
      detail:
        metrics.daysSinceLastOrder === null
          ? 'No orders yet'
          : `Last ordered ${metrics.daysSinceLastOrder} day${
              metrics.daysSinceLastOrder === 1 ? '' : 's'
            } ago`,
    },
    {
      key: 'frequency',
      label: 'Frequency',
      weight: WEIGHTS.frequency,
      score: scoreFrequency(metrics.completedCount),
      detail: `${metrics.completedCount} completed order${
        metrics.completedCount === 1 ? '' : 's'
      }`,
    },
    {
      key: 'monetary',
      label: 'Value',
      weight: WEIGHTS.monetary,
      score: scoreMonetary(metrics.totalRevenue),
      detail: `${metrics.totalRevenue.toFixed(2)} in total revenue`,
    },
  ];

  const score = Math.round(
    components.reduce((total, component) => total + component.score * component.weight, 0)
  );

  return {
    score,
    band: HEALTH_BANDS.find((band) => score >= band.min).label,
    components,
  };
}

module.exports = {
  calculateLeadScore,
  WEIGHTS,
  RECENCY_BANDS,
  FREQUENCY_BANDS,
  MONETARY_BANDS,
  HEALTH_BANDS,
};
