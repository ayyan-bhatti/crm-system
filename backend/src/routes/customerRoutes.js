const express = require('express');
const multer = require('multer');
const {
  listCustomers,
  listCustomerOptions,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  importCustomers,
} = require('../controllers/customerController');
const { protect } = require('../middleware/auth');
const { requireManagerOrAdmin, requireRole } = require('../middleware/roles');
const { ROLES } = require('../config/constants');

/*
 * Memory storage, not disk — this deploys as a Vercel serverless function
 * (see config/env.js#isServerless), whose filesystem is read-only outside
 * `/tmp` and does not persist between invocations either way. The file only
 * ever needs to exist for the length of one request, as a Buffer handed
 * straight to exceljs; nothing here ever needs it to be a file on disk.
 *
 * The size limit is generous for a spreadsheet (a 1000-row workbook of plain
 * text is a few hundred KB at most) and exists only to reject something that
 * is obviously not what this endpoint is for before it is fully buffered
 * into memory.
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const {
  listCustomerActivity,
  addCustomerActivity,
  summarizeCustomerActivity,
} = require('../controllers/activityController');
const {
  getCustomerSummary,
  draftMessage,
  getChurnRollup,
} = require('../controllers/customerInsightsController');
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
router.get(
  '/churn-rollup',
  aiSearchLimiter,
  aiPerUserLimiter,
  getChurnRollup
);

/*
 * Bulk-creating customers from a spreadsheet. Admin only — narrower than the
 * admin-direct/manager-via-approval split `createCustomer` uses for a SINGLE
 * new customer; see the long note on the handler for why a batch of rows
 * does not have a useful change-request equivalent. Declared before `/:id`
 * for the same routing-order reason `/options` and `/churn-rollup` are: an
 * unmatched `requireRole` here would otherwise let `/:id` capture "import" as
 * an id and answer with a CastError instead of the real route.
 */
router.post('/import', requireRole(ROLES.ADMIN), upload.single('file'), importCustomers);

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
router.get(
  '/:id/activity/summary',
  aiSearchLimiter,
  aiPerUserLimiter,
  summarizeCustomerActivity
);

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
router.post('/:id/draft-message', aiSearchLimiter, aiPerUserLimiter, draftMessage);

module.exports = router;
