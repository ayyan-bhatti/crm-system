const express = require('express');
const {
  listChangeRequests,
  approveChangeRequest,
  rejectChangeRequest,
} = require('../controllers/changeRequestController');
const { protect } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/roles');

const router = express.Router();

/*
 * Approving customer and order changes. Admin only, all of it.
 *
 * Not delegated to managers for the obvious reason: managers are who these
 * requests come from, and an approver who can approve their own request is not
 * an approver. There is no per-request check for "did you ask for this" because
 * the whole role is excluded — a narrower rule would be a rule with an edge
 * case, and this one has none.
 */
router.use(protect, requireAdmin);

router.get('/', listChangeRequests);
router.patch('/:id/approve', approveChangeRequest);
router.patch('/:id/reject', rejectChangeRequest);

module.exports = router;
