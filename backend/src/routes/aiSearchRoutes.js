const express = require('express');
const { aiSearch } = require('../controllers/aiSearchController');
const { protect } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roles');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/*
 * Admin only. This searches the internal CRM record book directly — customers,
 * orders, products with their internal fields — which is a materially
 * different exposure than the storefront's product search (public, and
 * re-projected through `shopSearchService` so nothing internal ever leaves).
 * A manager or sales rep with this box open could ask it for the whole
 * customer list in one sentence, which is exactly the access `customerRoutes`
 * otherwise takes care to withhold from a sales rep and to keep read-only
 * to a manager. Restricting the route itself, rather than relying only on
 * `customerScopeFilter`/`orderScopeFilter` inside the controller, means the
 * refusal is a flat 403 before any Gemini call is made — cheaper, and it
 * cannot be quietly loosened by a future change to the scope helpers alone.
 *
 * The rate limit here is about cost, not access: every request is a paid
 * Gemini call, so an unthrottled endpoint lets any signed-in user spend the
 * project's budget — a stuck retry loop does it by accident.
 *
 * Two limits, because they catch different things: per IP (one machine or
 * script hammering the endpoint) and per user (an office behind one NAT address
 * would otherwise share a single quota, and a user on a hotspot could dodge the
 * IP limit entirely). See middleware/rateLimit.js.
 *
 * Ordering matters. `protect` runs first so an unauthenticated flood is rejected
 * by the cheaper check and never consumes a signed-in user's quota — and it is
 * also what puts `req.user` there for `requireAdmin` and the per-user limiter.
 */
router.post('/', protect, requireAdmin, aiSearchLimiter, aiPerUserLimiter, aiSearch);

module.exports = router;
