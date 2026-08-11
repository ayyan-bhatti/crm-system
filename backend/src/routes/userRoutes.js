const express = require('express');
const {
  listUsers,
  listAssignableUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
} = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ROLES } = require('../config/constants');

const router = express.Router();

// Everything below requires a valid token.
router.use(protect);

// Any authenticated user may look up colleagues to populate an "assign to"
// dropdown. Declared before `/:id` so "assignable" isn't parsed as an id.
router.get('/assignable', listAssignableUsers);

// User management proper is admin-only — managers and sales reps get a 403.
router.use(requireRole(ROLES.ADMIN));

router.route('/').get(listUsers).post(createUser);
router.route('/:id').get(getUser).patch(updateUser).delete(deleteUser);

module.exports = router;
