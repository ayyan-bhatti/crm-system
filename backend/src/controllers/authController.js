const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ROLES } = require('../config/constants');
const {
  issueSession,
  rotateSession,
  revokeToken,
} = require('../services/sessionService');
const { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } = require('../utils/cookies');

/**
 * Send a freshly issued session to the client.
 *
 * The tokens go out as httpOnly cookies, which is what the browser app uses.
 * The access token is ALSO returned in the JSON body, for one reason: a
 * non-browser caller (a script, the test suite, a future mobile client) has no
 * cookie jar and needs some way to obtain a credential. The React app ignores
 * this field entirely and never writes it anywhere — that is the whole point of
 * the change. The refresh token is never in the body; it exists only as a
 * cookie, so there is no code path in which JavaScript could store it.
 */
function sendSession(res, { user, accessToken, refreshToken }, statusCode = 200) {
  setAuthCookies(res, { accessToken, refreshToken });

  res.status(statusCode).json({
    success: true,
    data: { user, token: accessToken },
  });
}

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

  const session = await issueSession(user, req);
  sendSession(res, { user, ...session }, 201);
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

  const session = await issueSession(user, req);
  sendSession(res, { user, ...session });
});

/**
 * POST /api/auth/refresh
 *
 * Deliberately unauthenticated in the `protect` sense: the whole purpose of
 * this endpoint is to be callable once the access token has already expired.
 * The refresh cookie is the credential.
 *
 * Every call rotates: the presented token is consumed and a new one issued.
 * See services/sessionService for why (reuse detection).
 */
const refresh = asyncHandler(async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE];

  if (!presented) {
    throw ApiError.unauthorized('No session to refresh');
  }

  let session;
  try {
    session = await rotateSession(presented, req);
  } catch (err) {
    // A dead refresh token means the browser is holding cookies that will never
    // work again. Clearing them stops the client retrying forever.
    clearAuthCookies(res);
    throw err;
  }

  sendSession(res, session);
});

/**
 * POST /api/auth/logout
 *
 * Two things have to happen, and doing only one of them is the usual bug:
 *
 *   1. clear the cookies, so this browser stops sending them
 *   2. revoke the refresh token server-side, so a copy captured earlier is
 *      dead too. Without this, "logging out" is cosmetic — anyone holding the
 *      old refresh token can still mint access tokens for the rest of the week.
 *
 * Always answers 200, even with no cookie present. Logging out is idempotent;
 * a client that has already lost its session should not be told its attempt to
 * tidy up failed.
 */
const logout = asyncHandler(async (req, res) => {
  await revokeToken(req.cookies?.[REFRESH_COOKIE], 'logout');
  clearAuthCookies(res);

  res.json({ success: true, message: 'Signed out' });
});

/** GET /api/auth/me — the currently authenticated user, for session restore. */
const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

module.exports = { register, login, refresh, logout, getMe };
