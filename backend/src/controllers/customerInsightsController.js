const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { canAccessCustomer } = require('../middleware/roles');
const { computeCustomerMetrics } = require('../services/customerMetrics');
const { calculateLeadScore } = require('../services/leadScore');
const { assessChurnRisk } = require('../services/churnRisk');
const customerSummaryService = require('../services/customerSummaryService');
const { buildFallbackSummary } = require('../services/summaryFallback');

/**
 * GET /api/customers/:id/summary
 *
 * An account summary: the figures, plus a short narrative about them.
 *
 * THE SHAPE OF THE RESPONSE IS THE DESIGN
 *
 *   data.metrics    computed from the database. Always present, always correct.
 *   data.summary    the narrative. Written by the model, or by a template when
 *                   the model is unavailable.
 *   data.mode       which of the two produced it — 'ai' or 'fallback'.
 *
 * `mode` is in the response because the UI has to be able to say so. A
 * generated sentence and a templated one look identical on screen, and letting
 * a reader assume the first when it is the second is the kind of small
 * dishonesty that costs trust in the whole feature.
 *
 * The figures are computed BEFORE the model is called and returned regardless
 * of what it does. A failed AI call degrades the wording, never the data.
 */
const getCustomerSummary = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');

  // Same rule as reading the customer itself — a summary is a view of the
  // record, so it cannot be a way around the record's permissions.
  if (!canAccessCustomer(req.user, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  const metrics = await computeCustomerMetrics(customer._id);

  /*
   * Computed here, not by the model, and computed BEFORE the AI call — so the
   * score is available whichever path the narrative takes. See the reasoning at
   * the top of services/leadScore.js: a health score that changes when you
   * refresh the page is not a metric.
   */
  const health = calculateLeadScore(metrics);

  /*
   * Churn risk answers a different question from the health score, and the two
   * genuinely disagree: a customer with forty orders who has gone quiet scores
   * superbly and is the most urgent call in the book. Computed from the same
   * metrics, so it costs one function call and no extra query.
   */
  const churn = assessChurnRisk(metrics);

  // Called through the module object rather than a destructured reference so
  // the test suite can stub it, exactly as the AI search tests do.
  const generated = await customerSummaryService.generateSummary(
    customer,
    metrics,
    health,
    req.user?._id?.toString() ?? null
  );

  const summary =
    generated.mode === 'ai'
      ? {
          headline: generated.headline,
          summary: generated.summary,
          recommendedAction: generated.recommendedAction,
          confidence: generated.confidence,
        }
      : buildFallbackSummary(customer, metrics);

  res.json({
    success: true,
    data: {
      customer: { _id: customer._id, name: customer.name, company: customer.company },
      metrics,
      health,
      churn,
      summary,
      mode: generated.mode,
      // Only on the fallback path, and only useful to a developer — but a
      // silent downgrade is a bug nobody finds until someone asks why the
      // summaries read oddly.
      ...(generated.mode === 'fallback' ? { fallbackReason: generated.reason } : {}),
    },
  });
});

/**
 * POST /api/customers/:id/draft-message — body: { tone: 'check-in'|'upsell'|'win-back' }
 *
 * See services/messageDraftService.js — the draft is never sent from here,
 * only returned for a rep to review and send by hand.
 */
const draftMessage = asyncHandler(async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) throw ApiError.notFound('Customer not found');

  if (!canAccessCustomer(req.user, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  const metrics = await computeCustomerMetrics(customer._id);

  const messageDraftService = require('../services/messageDraftService');
  const result = await messageDraftService.draft(
    customer,
    metrics,
    req.body.tone,
    req.user?._id?.toString() ?? null
  );

  res.json({
    success: true,
    data: { mode: result.mode, subject: result.subject, body: result.body },
  });
});

/**
 * GET /api/customers/churn-rollup — manager and admin.
 *
 * See services/churnRollupService.js — the flagged list is entirely the
 * existing per-customer `assessChurnRisk` rule, run across the book; the
 * model only narrates the list code already built.
 */
const getChurnRollup = asyncHandler(async (req, res) => {
  const { getRollup } = require('../services/churnRollupService');
  const result = await getRollup(req.user?._id?.toString() ?? null);

  res.json({
    success: true,
    mode: result.mode,
    count: result.rollup.length,
    data: { rollup: result.rollup, narrative: result.narrative },
  });
});

module.exports = { getCustomerSummary, draftMessage, getChurnRollup };
