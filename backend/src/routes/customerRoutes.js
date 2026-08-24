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
const { requireManagerOrAdmin } = require('../middleware/roles');

const {
  listCustomerActivity,
  addCustomerActivity,
} = require('../controllers/activityController');
const { getCustomerSummary } = require('../controllers/customerInsightsController');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// All three roles may reach these routes. Sales reps are then limited to
// customers they created or are assigned to — enforced inside the controller,
// because that rule depends on the specific record being touched.
router.use(protect);

/*
 * THE CUSTOMER BOOK IS NOT VISIBLE TO A SALES REP AT ALL.
 *
 * Not a filtered slice of it — none of it. A rep's job here is to fulfil the
 * orders assigned to them, and this collection is the most commercially
 * sensitive thing in the system: every name, address and buying history in the
 * business. "Only my customers" still means a slice of that, and a slice is
 * enough to walk out with.
 *
 * What a rep does get is the contact details of the customer on an order
 * assigned to them, which they need to deliver it. That comes from the ORDER
 * endpoints, and it is deliberately narrow: one customer, only while an order
 * for them is open, only for the rep holding it.
 *
 * WRITING IS ADMIN-ONLY, AND READING IS NOT.
 *
 * A manager sees the whole book and changes none of it directly. Their writes
 * become change requests for an admin to approve — see
 * services/changeRequestService. That split is what makes "managers run the
 * business, admins own the record" something the code enforces rather than
 * something the README claims.
 *
 * WHY THE WRITE ROUTES ARE NOT GATED WITH `requireAdmin`.
 *
 * They were, briefly, and it was wrong: a manager got a 403 and had no way to
 * propose anything, which turns "needs approval" into "not allowed". The
 * decision belongs in the handler, where the actor's role picks between
 * applying the change and queueing it — and where the response can say which
 * of the two happened.
 */
router.use(requireManagerOrAdmin);

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
 * The notes timeline.
 *
 * Mounted here rather than on a top-level /api/activity router so it inherits
 * this file's gating for free: `requireManagerOrAdmin` above has already run,
 * which is the rule that keeps the customer book away from sales reps. A
 * separate router would need that rule restated, and a restated rule is one
 * that can drift.
 *
 * There is deliberately no PATCH and no DELETE. Notes are append-only, and the
 * model refuses the write as well as the route not offering it — see
 * models/Activity.
 */
router.route('/:id/activity').get(listCustomerActivity).post(addCustomerActivity);

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
