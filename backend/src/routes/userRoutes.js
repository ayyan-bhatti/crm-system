const express = require('express');
const {
  listUsers,
  listAssignableUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  inviteUser,
  setUserStatus,
} = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const { requireRole, requireManagerOrAdmin } = require('../middleware/roles');
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

router.route('/').get(listUsers).post(createUser);
router.route('/:id').get(getUser).patch(updateUser).delete(deleteUser);

/*
 * Deactivate / reactivate. A separate route from the general update because it
 * is a different kind of action: renaming someone is cosmetic, deactivating
 * them cuts off access mid-session and revokes their tokens.
 */
router.patch('/:id/status', setUserStatus);

module.exports = router;
