const express = require('express');
const {
  listCustomers,
  listCustomerOptions,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} = require('../controllers/customerController');
const { protect } = require('../middleware/auth');

const { getCustomerSummary } = require('../controllers/customerInsightsController');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// All three roles may reach these routes. Sales reps are then limited to
// customers they created or are assigned to — enforced inside the controller,
// because that rule depends on the specific record being touched.
router.use(protect);

router.route('/').get(listCustomers).post(createCustomer);

/*
 * The searchable picker's endpoint.
 *
 * Declared BEFORE '/:id' or Express would read "options" as a customer id and
 * answer with a CastError — the same trap the products router already avoids
 * for "categories".
 */
router.get('/options', listCustomerOptions);
router.route('/:id').get(getCustomer).patch(updateCustomer).delete(deleteCustomer);

/*
 * The AI-backed account summary.
 *
 * Rate limited exactly like AI search, and for the same reason: each call is a
 * paid Gemini request, so an unthrottled endpoint is a way for any signed-in
 * user to spend the project's budget — a stuck retry loop does it by accident.
 * Limited per IP and per user; see middleware/rateLimit.js for why both.
 *
 * `router.use(protect)` above has already run, so `req.user` is available for
 * the per-user limiter to key on.
 */
router.get('/:id/summary', aiSearchLimiter, aiPerUserLimiter, getCustomerSummary);

module.exports = router;
