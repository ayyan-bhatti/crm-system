const express = require('express');
const { aiSearch } = require('../controllers/aiSearchController');
const { protect } = require('../middleware/auth');
const { aiSearchLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/*
 * Authenticated only. Role scoping is applied inside the controller, using the
 * same filters as the regular list endpoints.
 *
 * The rate limit here is about cost, not access: every request is a paid
 * Anthropic call, so an unthrottled endpoint lets any signed-in user spend the
 * project's budget — a stuck retry loop does it by accident.
 *
 * Ordering matters. `protect` runs first so that an unauthenticated flood is
 * rejected by the cheaper check and never consumes a signed-in user's quota.
 */
router.post('/', protect, aiSearchLimiter, aiSearch);

module.exports = router;
