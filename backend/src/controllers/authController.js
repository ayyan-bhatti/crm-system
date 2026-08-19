const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ROLES } = require('../config/constants');
const {
  issueSession,
  rotateSession,
  revokeToken,
  revokeAllForUser,
} = require('../services/sessionService');
const { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } = require('../utils/cookies');
const { assertStrongPassword } = require('../utils/passwordPolicy');

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

  // Checked before the duplicate-email lookup so a weak password is reported
  // even when the address is already taken — otherwise someone fixes the email,
  // resubmits, and only then learns about the password.
  assertStrongPassword(password, { name, email });

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
 *
 * Guarded twice: a per-IP rate limit on the route (volume from one address) and
 * a per-account lockout here (guesses against one account, from anywhere). See
 * middleware/rateLimit.js and the lockout section of models/User.
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw ApiError.badRequest('Email and password are required');
  }

  // `password` has select:false on the schema, so ask for it explicitly — as do
  // the lockout counters.
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select(
    '+password +failedLoginAttempts +lockUntil'
  );

  /*
   * A locked account is refused before the password is even checked.
   *
   * Checking first also means a locked account costs no bcrypt comparison,
   * which matters: bcrypt is deliberately slow, so an attacker who could force
   * one per request has a cheap way to exhaust the server's CPU.
   *
   * ENUMERATION TRADE-OFF, stated plainly: a 429 here reveals that the address
   * has an account, where an unknown address gets a 401. That is a real leak,
   * and it is the accepted price of the defence — the alternative (locking
   * nothing, or faking a lock for addresses with no account) either removes the
   * protection or needs per-email state for accounts that do not exist, which
   * is itself a way to fill the database. The per-IP limiter is what covers
   * bulk enumeration.
   */
  if (user && user.isLocked()) {
    const seconds = user.lockRemainingSeconds();
    res.set('Retry-After', String(seconds));
    return res.status(429).json({
      success: false,
      message: `Too many failed sign-in attempts. Try again in ${formatWait(seconds)}.`,
      retryAfterSeconds: seconds,
    });
  }

  if (!user || !(await user.comparePassword(password))) {
    // Only a real account has a counter to advance. An unknown address is
    // handled by the per-IP limiter instead.
    if (user) await user.registerFailedLogin();
    throw ApiError.unauthorized('Invalid email or password');
  }

  await user.clearFailedLogins();

  const session = await issueSession(user, req);
  return sendSession(res, { user, ...session });
});

/** "90 seconds" reads better than "in 90 seconds" for a two-minute wait. */
function formatWait(seconds) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

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

/**
 * POST /api/auth/change-password
 *
 * The password-reset surface this app actually has. A full "forgot password"
 * flow needs an email provider to deliver a one-time link, and there is none
 * configured — inventing one would be a fake feature, so this is the honest
 * version: an authenticated user changing their own password.
 *
 * Three things it does that are easy to leave out:
 *
 *   1. Requires the CURRENT password. Without it, anyone who walks up to an
 *      unlocked laptop — or holds a stolen access token — can lock the real
 *      owner out of their own account.
 *   2. Applies the same strength policy as registration. A policy enforced on
 *      one of the two paths that set a password is not a policy.
 *   3. Revokes every other session. A password change is what someone does
 *      when they think their account is compromised; if the attacker's session
 *      survives it, the change achieved nothing. A fresh session is issued for
 *      this browser so the user is not logged out by their own action.
 */
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    throw ApiError.badRequest('Current password and new password are required');
  }

  const user = await User.findById(req.user._id).select('+password');

  if (!(await user.comparePassword(currentPassword))) {
    throw ApiError.unauthorized('Current password is incorrect');
  }

  assertStrongPassword(newPassword, { name: user.name, email: user.email });

  if (await user.comparePassword(newPassword)) {
    throw ApiError.badRequest('New password must be different from the current one');
  }

  user.password = newPassword; // The pre-save hook hashes it.
  await user.save();

  await revokeAllForUser(user._id, 'password changed');

  // Issue a new session so the user stays signed in on the device they just
  // used, while every other device is signed out.
  const session = await issueSession(user, req);
  sendSession(res, { user, ...session });
});

/** GET /api/auth/me — the currently authenticated user, for session restore. */
const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

module.exports = { register, login, refresh, logout, changePassword, getMe };
