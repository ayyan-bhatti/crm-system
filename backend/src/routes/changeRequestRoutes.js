const express = require('express');
const {
  listChangeRequests,
  approveChangeRequest,
  rejectChangeRequest,
  summarizeChangeRequest,
} = require('../controllers/changeRequestController');
const { protect } = require('../middleware/auth');
const { requireManagerOrAdmin } = require('../middleware/roles');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/*
 * Approving customer and order changes.
 *
 * STAFF-INITIATED requests (a manager's customer edit, an order-item edit, a
 * deletion, a rep's transfer) stay admin-only in effect: managers are who
 * most of those come from, and an approver who can approve their own request
 * is not an approver. That rule has no per-request check because the whole
 * role used to be excluded outright.
 *
 * BUYER-INITIATED requests (a cancellation or an edit a customer asked for
 * on their own pending order) are different — no manager submitted one, so
 * there is no self-approval conflict, and the storefront brief is explicit
 * that these should be visible to any manager, not gated to admin alone.
 * Rather than a second route tree, the gate here is loosened to
 * `requireManagerOrAdmin` and the per-request distinction is enforced in
 * `changeRequestController.js`, which is the only place that knows which
 * request a given call is about.
 */
router.use(protect, requireManagerOrAdmin);

router.get('/', listChangeRequests);
router.get('/:id/summary', aiSearchLimiter, aiPerUserLimiter, summarizeChangeRequest);
router.patch('/:id/approve', approveChangeRequest);
router.patch('/:id/reject', rejectChangeRequest);

module.exports = router;
