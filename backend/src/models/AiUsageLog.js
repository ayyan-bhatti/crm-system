const mongoose = require('mongoose');

/**
 * One row per AI call: what it was for, what it cost, and how long it took.
 *
 * WHY A COLLECTION WHEN THE SAME FIGURES ARE ALREADY LOGGED
 *
 * The log line answers "what happened just now" and is excellent at it. It is
 * poor at "what did we spend last month, and on which feature" — that is an
 * aggregation over a time range, which means either a log platform with a query
 * language and a long enough retention window, or a table.
 *
 * A table is the cheaper answer here, and it survives log rotation. It is also
 * what makes the projected-monthly-cost figure in the admin view possible
 * without anyone exporting anything.
 *
 * WHAT IS DELIBERATELY NOT STORED
 *
 * Not the prompt, and not the response. Prompts contain customer names, notes
 * and order history; keeping a second copy of that in a collection nobody
 * thinks of as customer data is how data ends up somewhere it should not be.
 * The token COUNTS are all the cost question needs, and a hash of the prompt is
 * enough to spot a repeated query without storing the query.
 */
const aiUsageLogSchema = new mongoose.Schema({
  /** 'ai-search' | 'customer-summary' — matches the logger's component names. */
  feature: {
    type: String,
    required: true,
    index: true,
  },
  model: {
    type: String,
    required: true,
  },

  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },

  /**
   * Estimated cost in USD at the time of the call.
   *
   * Stored rather than computed on read, because prices change: recomputing
   * last quarter's spend at today's rates would quietly rewrite history. The
   * rate used is kept alongside it for the same reason.
   */
  estimatedCostUsd: { type: Number, default: 0 },

  durationMs: { type: Number, default: 0 },
  attempts: { type: Number, default: 1 },

  /** 'ok' | 'failed' | 'cached' — a cache hit costs nothing and is worth counting. */
  outcome: {
    type: String,
    enum: ['ok', 'failed', 'cached'],
    default: 'ok',
    index: true,
  },

  /** Who triggered it, so a runaway user is identifiable. Never the prompt. */
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
    // No `index: true` here — the TTL index below already indexes this field,
    // and declaring both makes Mongoose warn about a duplicate at boot.
  },
});

/** The summary query: totals per feature over a date range. */
aiUsageLogSchema.index({ createdAt: -1, feature: 1 });

/**
 * Ninety days, then gone.
 *
 * Unlike the audit trail — which deliberately has no TTL because deleting
 * evidence is the failure mode — this is operational cost data. Three months
 * covers "is this month worse than last" and any trend worth acting on, and
 * nobody investigates an incident by reading token counts from last year.
 */
aiUsageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model('AiUsageLog', aiUsageLogSchema);
