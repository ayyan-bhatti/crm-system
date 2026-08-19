const express = require('express');
const { aiSearch } = require('../controllers/aiSearchController');
const { protect } = require('../middleware/auth');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/*
 * Authenticated only. Role scoping is applied inside the controller, using the
 * same filters as the regular list endpoints.
 *
 * The rate limit here is about cost, not access: every request is a paid
 * Anthropic call, so an unthrottled endpoint lets any signed-in user spend the
 * project's budget — a stuck retry loop does it by accident.
 *
 * Two limits, because they catch different things: per IP (one machine or
 * script hammering the endpoint) and per user (an office behind one NAT address
 * would otherwise share a single quota, and a user on a hotspot could dodge the
 * IP limit entirely). See middleware/rateLimit.js.
 *
 * Ordering matters. `protect` runs first so an unauthenticated flood is rejected
 * by the cheaper check and never consumes a signed-in user's quota — and it is
 * also what puts `req.user` there for the per-user limiter to key on.
 */
router.post('/', protect, aiSearchLimiter, aiPerUserLimiter, aiSearch);

module.exports = router;
