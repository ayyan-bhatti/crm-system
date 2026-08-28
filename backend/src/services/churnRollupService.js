const Customer = require('../models/Customer');
const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const { computeCustomerMetrics } = require('./customerMetrics');
const { assessChurnRisk, LEVELS } = require('./churnRisk');

const log = componentLogger('ai-churn-rollup');

const MAX_ROLLUP = 10;
const MAX_NARRATIVE = 900;
/*
 * A ceiling on how many customers are scored per request, not a page size.
 * This is a live, per-customer computation (see the note below on why it
 * cannot be an aggregation) — a business with a customer book far beyond
 * this size needs the underlying score cached rather than computed on
 * every request, which is future work this ceiling deliberately does not
 * pretend to solve.
 */
const MAX_SCANNED = 300;

/**
 * "Here's who to call this week" — churn risk rolled up across a team, for
 * a manager or admin.
 *
 * REUSES THE EXISTING PER-CUSTOMER SCORE, DOES NOT REDEFINE IT.
 *
 * `assessChurnRisk` already exists and is entirely rule-based — see
 * services/churnRisk.js. This does not recompute risk differently at scale;
 * it runs the same function once per customer who has a rep actively
 * working them (`assignedTo` set — an unclaimed lead has no relationship to
 * be at risk of losing) and keeps the ones it already rates moderate or
 * high. The model never sees a raw order and is never asked to judge risk;
 * it writes one paragraph OF the list code already built.
 *
 * WHY THIS IS PER-CUSTOMER RATHER THAN ONE AGGREGATION
 *
 * Churn risk is relative to each customer's OWN order cadence — see
 * churnRisk.js — which is not a single pipeline's worth of arithmetic across
 * customers with different histories. The trade-off is real and stated
 * plainly: this scans up to `MAX_SCANNED` customers per call rather than
 * running one query, which is the honest cost of a per-customer measure
 * over a company-wide list.
 */

async function computeRiskRollup() {
  const customers = await Customer.find({ assignedTo: { $ne: null } })
    .select('name assignedTo')
    .populate('assignedTo', 'name')
    .limit(MAX_SCANNED);

  const scored = [];
  for (const customer of customers) {
    const metrics = await computeCustomerMetrics(customer._id);
    const risk = assessChurnRisk(metrics);

    if (risk.level === LEVELS.MODERATE || risk.level === LEVELS.HIGH) {
      scored.push({
        customerId: customer._id,
        name: customer.name,
        repName: customer.assignedTo?.name || null,
        level: risk.level,
        label: risk.label,
        reason: risk.reason,
      });
    }
  }

  // High risk first; within a level, the order scan already returns customers
  // in a stable, arbitrary order, which is fine — this list is a work queue,
  // not a leaderboard.
  scored.sort((a, b) => (a.level === b.level ? 0 : a.level === LEVELS.HIGH ? -1 : 1));

  return scored.slice(0, MAX_ROLLUP);
}

function validateNarrative(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const narrative = string(raw.narrative, MAX_NARRATIVE);
  return narrative ? { narrative } : null;
}

function buildSystemPrompt() {
  return `You write a short "who to call this week" note for a sales manager, based on a
list of customers ALREADY flagged as at risk of churning, with the reason each was
flagged. Do not add a customer not in the list, and do not change anyone's risk level —
report what is given. Mention names. Two to four sentences.

Respond with a JSON object only: {"narrative": "<the note text>"}`;
}

function callModel(rollup, userId) {
  return aiClient.complete({
    feature: 'churn-rollup',
    userId,
    system: buildSystemPrompt(),
    user: JSON.stringify(
      rollup.map(({ name, repName, level, label, reason }) => ({
        name,
        rep: repName,
        level,
        label,
        reason,
      }))
    ),
    maxTokens: 500,
  });
}

function fallbackNarrative(rollup) {
  if (!rollup.length) return 'No customers are currently flagged as at risk.';

  const names = rollup
    .slice(0, 5)
    .map((c) => `${c.name} (${c.label})`)
    .join(', ');

  return `${rollup.length} customer${rollup.length === 1 ? ' is' : 's are'} flagged this week: ${names}${
    rollup.length > 5 ? ', and others' : ''
  }.`;
}

/** The team churn roll-up. Never throws. `{ mode, rollup, narrative }`. */
async function getRollup(userId = null) {
  const rollup = await computeRiskRollup();

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', rollup, narrative: fallbackNarrative(rollup) };
  }

  if (!rollup.length) {
    return { mode: 'fallback', rollup, narrative: fallbackNarrative(rollup) };
  }

  let text;
  try {
    text = await callModel(rollup, userId);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the templated roll-up');
    return { mode: 'fallback', rollup, narrative: fallbackNarrative(rollup) };
  }

  const result = parseAndValidate(text, validateNarrative);
  if (!result.ok) return { mode: 'fallback', rollup, narrative: fallbackNarrative(rollup) };

  return { mode: 'ai', rollup, narrative: result.value.narrative };
}

module.exports = { getRollup, computeRiskRollup, validateNarrative };
