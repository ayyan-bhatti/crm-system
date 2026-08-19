const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { canAccessCustomer } = require('../middleware/roles');
const { computeCustomerMetrics } = require('../services/customerMetrics');
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

  // Called through the module object rather than a destructured reference so
  // the test suite can stub it, exactly as the AI search tests do.
  const generated = await customerSummaryService.generateSummary(customer, metrics);

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
      summary,
      mode: generated.mode,
      // Only on the fallback path, and only useful to a developer — but a
      // silent downgrade is a bug nobody finds until someone asks why the
      // summaries read oddly.
      ...(generated.mode === 'fallback' ? { fallbackReason: generated.reason } : {}),
    },
  });
});

module.exports = { getCustomerSummary };
