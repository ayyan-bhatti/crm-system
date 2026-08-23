const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ROLES } = require('../config/constants');
const metrics = require('../services/metrics');
const { getAiStatus } = require('../services/aiStatus');
const { getUsageSummary } = require('../services/aiUsageService');

const router = express.Router();

/*
 * Internal operational endpoints. Admin only, for the whole router.
 *
 * WHY ADMIN RATHER THAN AN IP ALLOW-LIST
 *
 * An allow-list is the usual answer for an internal endpoint, and it does not
 * work on a serverless platform: the app sees the edge network's addresses, not
 * a stable office IP, so the list would either be wrong or so broad as to be
 * meaningless. The app already has a strong notion of "administrator", enforced
 * by the same middleware as everything else, so reusing it is both simpler and
 * harder to get wrong than a second, weaker mechanism.
 *
 * What is behind this matters: route-level latency and error rates describe the
 * shape of the system, and AI spend is commercial information.
 */
router.use(protect, requireRole(ROLES.ADMIN));

/**
 * GET /api/internal/metrics
 *
 * Request counts, error rates and latency per route.
 *
 * Note the `scope` field in the response: on a serverless deployment these are
 * one instance's numbers since it woke up, not the whole deployment's. See the
 * note at the top of services/metrics.js for why that is the right trade.
 */
router.get(
  '/metrics',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: metrics.snapshot() });
  })
);

/**
 * GET /api/internal/ai-usage?days=30
 *
 * What the AI features have cost: calls, tokens each way, estimated spend, the
 * cache hit rate, and a per-feature breakdown with a monthly projection.
 *
 * Admin only because AI spend is commercial information, and because a
 * per-feature cost breakdown says a good deal about how the product is used.
 */
router.get(
  '/ai-usage',
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(1, parseInt(req.query.days, 10) || 30), 365);

    res.json({ success: true, data: await getUsageSummary(days) });
  })
);

/**
 * GET /api/internal/ai-status
 *
 * Whether the AI is configured and actually succeeding.
 *
 * This endpoint exists because of a real failure: GEMINI_API_KEY was never
 * set, so every AI feature had been silently running its non-AI fallback. It
 * broke nothing and showed nothing — AI search returned results, they were
 * just keyword results behind a label that said otherwise. The only evidence
 * was a `mode` field on individual responses.
 *
 * Admin-only like the rest of this router. It reports nothing secret (never the
 * key, or any part of it) but it does describe the deployment's internals, and
 * an unauthenticated "is your AI down" probe is a gift to nobody useful.
 */
router.get(
  '/ai-status',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getAiStatus() });
  })
);

module.exports = router;
