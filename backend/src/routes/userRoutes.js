const express = require('express');
const {
  listUsers,
  listAssignableUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  inviteUser,
  listPendingRequests,
  approveUser,
  rejectUser,
  setUserStatus,
  getActivityDigest,
} = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const { requireRole, requireManagerOrAdmin } = require('../middleware/roles');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');
const { ROLES } = require('../config/constants');

const router = express.Router();

// Everything below requires a valid token.
router.use(protect);

// Any authenticated user may look up colleagues to populate an "assign to"
// dropdown. Declared before `/:id` so "assignable" isn't parsed as an id.
router.get('/assignable', listAssignableUsers);

/*
 * Inviting is open to managers as well as admins, so onboarding does not
 * bottleneck on a single administrator. The role a manager may GRANT is capped
 * in the controller — a manager who could mint an admin would be an admin.
 *
 * Declared before the admin-only gate below, or a manager would never reach it.
 */
router.post('/invite', requireManagerOrAdmin, inviteUser);

// Everything else is admin-only — managers and sales reps get a 403.
router.use(requireRole(ROLES.ADMIN));

/*
 * The sign-up approval queue.
 *
 * Separate routes from the general update and from /status, for the same
 * reason order reassignment is: these are decisions rather than edits. An
 * approval grants access that did not exist, and the audit entry should read
 * "approved as manager (asked for manager)" rather than a general update that
 * happens to contain a status field.
 *
 * Admin only, inherited from the requireRole above. Approving accounts is not
 * delegated to managers: a manager who can approve accounts can approve one
 * for themselves under another name.
 */
router.get('/pending', listPendingRequests);
router.patch('/:id/approve', approveUser);
router.patch('/:id/reject', rejectUser);

/*
 * The staff activity digest. Declared before `/:id`, or "activity-digest" is
 * parsed as a user id, and rate-limited like every other paid model call.
 *
 * Admin only, inherited from the requireRole above — this reports who has and
 * has not been changing records, which is oversight of colleagues rather than
 * anyone's own work.
 */
router.get('/activity-digest', aiSearchLimiter, aiPerUserLimiter, getActivityDigest);

router.route('/').get(listUsers).post(createUser);
router.route('/:id').get(getUser).patch(updateUser).delete(deleteUser);

/*
 * Deactivate / reactivate. A separate route from the general update because it
 * is a different kind of action: renaming someone is cosmetic, deactivating
 * them cuts off access mid-session and revokes their tokens.
 */
router.patch('/:id/status', setUserStatus);

module.exports = router;
