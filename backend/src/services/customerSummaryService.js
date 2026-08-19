const Anthropic = require('@anthropic-ai/sdk');
const env = require('../config/env');
const { extractJson } = require('./aiSearchService');
const { TREND_WINDOW_DAYS } = require('./customerMetrics');

/**
 * The AI half of the customer summary: prose only, never numbers.
 *
 * WHAT THE MODEL IS AND IS NOT ALLOWED TO DO
 *
 * Everything quantitative is computed in customerMetrics.js and passed in. The
 * model's entire job is to read those figures and write two or three sentences
 * a salesperson can act on. It is never asked to count, add or compare —
 * because a language model doing arithmetic is confidently and invisibly wrong,
 * and a CRM that misreports revenue is worse than one with no summary at all.
 *
 * That constraint is enforced twice, not once:
 *
 *   in the prompt      it is told the figures are already correct and that it
 *                      must not invent or restate new ones
 *   in the validator   the response schema has NO numeric fields at all, so a
 *                      number the model made up has nowhere to go. Anything
 *                      outside the schema is dropped rather than trusted.
 *
 * A prompt instruction alone would be a request. The schema is the guarantee.
 */

const anthropic = env.anthropicApiKey
  ? new Anthropic({ apiKey: env.anthropicApiKey, timeout: 20000, maxRetries: 1 })
  : null;

/** Caps on the generated text, so one odd response cannot flood the UI. */
const MAX_HEADLINE = 90;
const MAX_SUMMARY = 600;
const MAX_ACTION = 240;

const CONFIDENCE_VALUES = ['low', 'medium', 'high'];

/**
 * How each trend value should be read. Sent to the model so it describes the
 * classification we computed rather than reinterpreting the raw revenue
 * figures and reaching a different conclusion.
 */
const TREND_MEANINGS = {
  rising: `revenue in the last ${TREND_WINDOW_DAYS} days is more than 20% above the ${TREND_WINDOW_DAYS} days before`,
  steady: 'revenue is roughly flat between the two windows',
  declining: 'revenue has fallen by more than 20%, or stopped entirely',
  new: 'they have bought recently but have no earlier history to compare against',
  dormant: 'no revenue in either window — the relationship has gone quiet',
  no_orders: 'they have never placed an order',
};

function buildSystemPrompt() {
  return `You write short account summaries for a CRM used by sales representatives.

You will be given a customer's details, a set of figures that have ALREADY been
calculated from the database, and a health score that has ALREADY been calculated
from those figures. All of it is correct and authoritative.

CRITICAL RULES
- Never calculate, estimate, or invent a number. Do not add up, average, or compare
  figures yourself. If you want to mention a figure, use one exactly as given.
- Never state anything the data does not show. You do not know why a customer
  stopped buying, only that they did.
- Write for someone deciding what to do next, not for a report. Be concrete and brief.
- If the data is thin (one order, or none), say so plainly instead of padding.
- Your wording must AGREE with the health score you are given. Do not describe an
  account as strong if the score is low, or vice versa — the reader can see both.
  Explain the score; do not second-guess it.

Trend values mean:
${Object.entries(TREND_MEANINGS)
  .map(([key, meaning]) => `- "${key}": ${meaning}`)
  .join('\n')}

Respond with a JSON object only — no prose, no markdown fences.

{
  "headline": "<at most 8 words, the one thing to know>",
  "summary": "<2-3 sentences describing the relationship>",
  "recommendedAction": "<one specific next step the rep could take this week>",
  "confidence": "low" | "medium" | "high"
}

"confidence" is how well the data supports your summary — "low" for a customer with
one order or none, "high" for a long consistent history. It is about the evidence,
not about how sure you are of your wording.`;
}

/** The facts handed to the model. Nothing here is raw order data. */
function buildUserMessage(customer, metrics, health = null) {
  return JSON.stringify(
    {
      customer: {
        name: customer.name,
        company: customer.company || null,
        city: customer.city || null,
        status: customer.status,
        notes: customer.notes || null,
        addedOn: customer.createdAt,
      },
      calculatedFigures: {
        totalOrders: metrics.orderCount,
        completedOrders: metrics.completedCount,
        cancelledOrders: metrics.cancelledCount,
        totalRevenue: metrics.totalRevenue,
        averageOrderValue: metrics.averageOrderValue,
        firstOrderDate: metrics.firstOrderDate,
        lastOrderDate: metrics.lastOrderDate,
        daysSinceLastOrder: metrics.daysSinceLastOrder,
        trend: metrics.trend,
      },
      /*
       * The health score, already calculated. Given to the model so its wording
       * agrees with the number the user is looking at — a paragraph saying "a
       * strong account" next to a score of 31 is worse than no paragraph.
       *
       * It is in "calculatedFigures" territory, so the same rule applies: quote
       * it, never recompute it. And as with every other number, the response
       * schema has no field for it, so the model cannot return one.
       */
      healthScore: health
        ? {
            score: health.score,
            band: health.band,
            drivers: health.components.map((c) => `${c.label}: ${c.detail}`),
          }
        : null,
    },
    null,
    2
  );
}

/**
 * Validate the model's reply against the response schema.
 *
 * Same approach as the AI search filter validator, and for the same reason: the
 * model's output is untrusted input, exactly like a request body. Here the
 * risk is not injection but *fabrication* — so the schema's most important
 * property is what it leaves out. There is no numeric field, therefore no place
 * for a hallucinated figure to land.
 *
 * @returns {object|null} the cleaned object, or null if it cannot be trusted.
 */
function validateSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const text = (value, max) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, max);
  };

  const headline = text(raw.headline, MAX_HEADLINE);
  const summary = text(raw.summary, MAX_SUMMARY);

  // Both are required: a summary with no headline renders as a broken card, and
  // half a response is not better than the deterministic fallback.
  if (!headline || !summary) return null;

  return {
    headline,
    summary,
    // Optional — a customer with no history may genuinely have no useful action.
    recommendedAction: text(raw.recommendedAction, MAX_ACTION),
    confidence: CONFIDENCE_VALUES.includes(raw.confidence) ? raw.confidence : 'low',
  };
}

async function callModel(customer, metrics, health) {
  const response = await anthropic.messages.create({
    model: env.anthropicModel,
    // Small: the reply is a handful of sentences. A generous cap here would
    // only ever pay for output nobody reads.
    max_tokens: 600,
    output_config: { effort: 'low' },
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(customer, metrics, health) }],
  });

  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Generate the narrative half of a customer summary.
 *
 * Never throws. Returns `{ mode: 'ai', ...fields }` or
 * `{ mode: 'fallback', reason, ...fields }` — the caller always has something
 * to render, because the figures are correct either way and a summary screen
 * that errors out is worse than one with plain wording.
 */
async function generateSummary(customer, metrics, health = null) {
  if (!anthropic) {
    return { mode: 'fallback', reason: 'ANTHROPIC_API_KEY is not configured' };
  }

  let text;
  try {
    text = await callModel(customer, metrics, health);
  } catch (err) {
    if (!env.isTest) {
      // eslint-disable-next-line no-console
      console.warn(`[ai-summary] model call failed, using template: ${err.message}`);
    }
    return { mode: 'fallback', reason: `AI request failed: ${err.message}` };
  }

  const parsed = extractJson(text);
  if (!parsed) {
    return { mode: 'fallback', reason: 'AI response was not valid JSON' };
  }

  const validated = validateSummary(parsed);
  if (!validated) {
    return { mode: 'fallback', reason: 'AI response did not match the expected shape' };
  }

  return { mode: 'ai', ...validated };
}

module.exports = {
  generateSummary,
  // Exported for tests and for reuse by the deterministic fallback.
  buildSystemPrompt,
  buildUserMessage,
  validateSummary,
  MAX_HEADLINE,
  MAX_SUMMARY,
  MAX_ACTION,
};
