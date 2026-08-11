const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { signToken } = require('../utils/token');
const { ROLES } = require('../config/constants');

/**
 * POST /api/auth/register
 *
 * Role assignment on public sign-up is deliberately NOT taken from the request
 * body — otherwise anyone could register themselves as an admin. Instead:
 *
 *   - the very first user to register becomes the `admin` (bootstrapping a
 *     fresh install, so there is someone who can manage everyone else)
 *   - every later public registration is a `sales_rep`, the least-privileged role
 *
 * Admins promote users afterwards through PATCH /api/users/:id.
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    throw ApiError.badRequest('Name, email and password are required');
  }

  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    throw ApiError.conflict('An account with that email already exists');
  }

  const isFirstUser = (await User.estimatedDocumentCount()) === 0;

  const user = await User.create({
    name,
    email,
    password,
    role: isFirstUser ? ROLES.ADMIN : ROLES.SALES_REP,
  });

  res.status(201).json({
    success: true,
    data: { user, token: signToken(user) },
  });
});

/**
 * POST /api/auth/login
 *
 * Both "no such email" and "wrong password" return the same 401 message, so the
 * endpoint can't be used to enumerate which email addresses have accounts.
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw ApiError.badRequest('Email and password are required');
  }

  // `password` has select:false on the schema, so ask for it explicitly.
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  res.json({
    success: true,
    data: { user, token: signToken(user) },
  });
});

/** GET /api/auth/me — the currently authenticated user, for session restore. */
const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

module.exports = { register, login, getMe };
