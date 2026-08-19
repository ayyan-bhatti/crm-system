const express = require('express');
const {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} = require('../controllers/customerController');
const { protect } = require('../middleware/auth');

const { getCustomerSummary } = require('../controllers/customerInsightsController');
const { aiSearchLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// All three roles may reach these routes. Sales reps are then limited to
// customers they created or are assigned to — enforced inside the controller,
// because that rule depends on the specific record being touched.
router.use(protect);

router.route('/').get(listCustomers).post(createCustomer);
router.route('/:id').get(getCustomer).patch(updateCustomer).delete(deleteCustomer);

/*
 * The AI-backed account summary.
 *
 * Rate limited with the same limiter as AI search, because it is the same
 * concern: each call is a paid Anthropic request, and an unthrottled one is a
 * way for any signed-in user to spend the project's budget. Phase 2.4 replaces
 * this with a limiter that also counts per user rather than only per IP.
 */
router.get('/:id/summary', aiSearchLimiter, getCustomerSummary);

module.exports = router;
