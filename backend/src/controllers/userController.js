const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ROLE_VALUES } = require('../config/constants');

/**
 * User management. Every route in this controller is admin-only — that
 * restriction is applied once in routes/userRoutes.js rather than repeated here.
 */

/**
 * GET /api/users
 * Supports `?role=` and `?search=` (name or email).
 *
 * Note: managers and sales reps are allowed to call GET /api/users/assignable
 * instead (see below), because assigning a customer to a colleague requires
 * knowing who your colleagues are.
 */
const listUsers = asyncHandler(async (req, res) => {
  const { role, search } = req.query;
  const filter = {};

  if (role) filter.role = role;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const users = await User.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, count: users.length, data: users });
});

/**
 * GET /api/users/assignable
 * A trimmed list (id + name + role only) for populating "assigned to" dropdowns.
 * Available to any authenticated user — it exposes no sensitive fields.
 */
const listAssignableUsers = asyncHandler(async (req, res) => {
  const users = await User.find({}).select('name email role').sort({ name: 1 });
  res.json({ success: true, count: users.length, data: users });
});

/** GET /api/users/:id */
const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  res.json({ success: true, data: user });
});

/**
 * POST /api/users
 * Admin-created accounts, where specifying the role IS allowed.
 */
const createUser = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    throw ApiError.badRequest('Name, email and password are required');
  }
  if (role && !ROLE_VALUES.includes(role)) {
    throw ApiError.badRequest(`Role must be one of: ${ROLE_VALUES.join(', ')}`);
  }

  const user = await User.create({ name, email, password, role });
  res.status(201).json({ success: true, data: user });
});

/**
 * PATCH /api/users/:id
 * Updates name, email, role and/or password.
 */
const updateUser = asyncHandler(async (req, res) => {
  const { name, email, role, password } = req.body;

  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  if (role && !ROLE_VALUES.includes(role)) {
    throw ApiError.badRequest(`Role must be one of: ${ROLE_VALUES.join(', ')}`);
  }

  if (name !== undefined) user.name = name;
  if (email !== undefined) user.email = email;
  if (role !== undefined) user.role = role;
  // Assigning here (rather than findByIdAndUpdate) keeps the pre-save hook in
  // play, so the new password is hashed.
  if (password !== undefined) user.password = password;

  await user.save();
  res.json({ success: true, data: user });
});

/**
 * DELETE /api/users/:id
 * Blocks self-deletion, which would otherwise let the last admin lock everyone
 * out of user management.
 */
const deleteUser = asyncHandler(async (req, res) => {
  if (req.params.id === req.user._id.toString()) {
    throw ApiError.badRequest('You cannot delete your own account');
  }

  const user = await User.findByIdAndDelete(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  res.json({ success: true, message: 'User deleted', data: { id: req.params.id } });
});

/** Escape user input before it is embedded in a RegExp. */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  listUsers,
  listAssignableUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
};
