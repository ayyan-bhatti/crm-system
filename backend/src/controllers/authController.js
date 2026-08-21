const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ROLES, USER_STATUS } = require('../config/constants');
const inviteService = require('../services/inviteService');
const {
  issueSession,
  rotateSession,
  revokeToken,
  revokeAllForUser,
} = require('../services/sessionService');
const { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } = require('../utils/cookies');
const { assertStrongPassword } = require('../utils/passwordPolicy');
const passwordResetService = require('../services/passwordResetService');
const env = require('../config/env');

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
 * Role assignment is deliberately NOT taken from the request body — otherwise
 * anyone could register themselves as an admin. Instead:
 *
 *   - the very first user to register becomes the `admin` (bootstrapping a
 *     fresh install, so there is someone who can manage everyone else)
 *   - every later public registration is a `sales_rep`, the least-privileged role
 *
 * Admins promote users afterwards through PATCH /api/users/:id.
 *
 * Whether later registrations are accepted at all is ALLOW_PUBLIC_SIGNUP, which
 * defaults to open. A deployment holding real customer data on the public
 * internet should close it and use invitations instead; see config/env.js for
 * the trade-off in full. The first-user bootstrap ignores the setting, because
 * a new install has nobody to send an invitation.
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    throw ApiError.badRequest('Name, email and password are required');
  }

  // Checked before the duplicate-email lookup so a weak password is reported
  // even when the address is already taken — otherwise someone fixes the email,
  // resubmits, and only then learns about the password.
  await assertStrongPassword(password, { name, email });

  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    throw ApiError.conflict('An account with that email already exists');
  }

  /*
   * TWO DIFFERENT THINGS HAPPEN HERE, AND ONLY ONE OF THEM IS OPTIONAL.
   *
   * The FIRST account on an empty install is always allowed, whatever the
   * signup setting says, and becomes the admin. A fresh deployment has nobody
   * to send an invitation, so if this were gated too, closing sign-up would
   * lock everyone out of a new install permanently and the only way in would be
   * a seed script or a database console.
   *
   * EVERY LATER account depends on ALLOW_PUBLIC_SIGNUP, and gets the
   * least-privileged role regardless. Open sign-up on a CRM means anyone who
   * can reach the page can read the customer list, which is why an admin can
   * shut it and invite people instead. See config/env.js for the trade-off.
   *
   * countDocuments, not estimatedDocumentCount: the estimate reads collection
   * metadata that can be stale after an unclean shutdown, and this decides
   * whether the caller is handed the admin role. A wrong answer here is an
   * unintended administrator, which is not a risk worth the few milliseconds.
   */
  const isFirstUser = (await User.countDocuments({})) === 0;

  if (!isFirstUser && !env.allowPublicSignup) {
    throw ApiError.forbidden(
      'Public registration is closed on this deployment. SimpleCRM accounts are created ' +
        'by invitation — ask an administrator to invite you.'
    );
  }

  /*
   * The role is assigned here rather than read from req.body. Taking it from
   * the request would let anyone register themselves as an admin, which is the
   * whole reason this is not a field.
   */
  const user = await User.create({
    name,
    email,
    password,
    role: isFirstUser ? ROLES.ADMIN : ROLES.SALES_REP,
    status: USER_STATUS.ACTIVE,
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

  /*
   * The password was right, but the account cannot be used.
   *
   * Checked AFTER the password on purpose. Answering "your account is
   * deactivated" to anyone who types the address would confirm the account
   * exists — the same enumeration leak the identical-error rule above prevents.
   * Requiring the correct password first means only the genuine owner sees
   * this, and they need it: "invalid email or password" would send an
   * offboarded employee off to reset a password that was never the problem.
   */
  if (!user.canSignIn()) {
    const message =
      user.status === USER_STATUS.PENDING
        ? 'This account has not been activated yet. Please use the invitation link you were sent.'
        : 'Your account has been deactivated. Please contact an administrator.';

    throw ApiError.forbidden(message);
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

  await assertStrongPassword(newPassword, { name: user.name, email: user.email });

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

/**
 * POST /api/auth/forgot-password
 *
 * Always answers 200 with the same body, whether or not the address has an
 * account. "No account with that email" would be a free account-enumeration
 * oracle: feed in a list of addresses, learn which ones are customers.
 *
 * The cost is a mistyped address waiting for a mail that never arrives, which
 * the mail content mitigates — an address with no account still receives a
 * message saying so, which is more helpful than silence and tells an attacker
 * nothing, since they cannot read the inbox.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) throw ApiError.badRequest('Email is required');

  // Deliberately not awaited for its RESULT — the response must not vary with
  // what it found. It is awaited for timing consistency.
  await passwordResetService.requestReset(email, req);

  res.json({
    success: true,
    message:
      'If an account exists for that address, a password reset link is on its way. ' +
      'The link expires in 30 minutes.',
  });
});

/**
 * POST /api/auth/reset-password
 *
 * Redeems a reset link. The failure reasons ARE distinguishable here — "this
 * link has expired" is far more useful than a blanket rejection, and unlike the
 * request step there is nothing to enumerate: a token is not an email address.
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    throw ApiError.badRequest('A reset token and a new password are required');
  }

  /*
   * The password is validated BEFORE the token is consumed.
   *
   * Otherwise a weak password would burn the link: the token is single-use, so
   * the user would be told their password was rejected and that their reset
   * link no longer works, and would have to start again.
   */
  const preview = await passwordResetService.peek(token);
  if (preview.ok) {
    await assertStrongPassword(password, {
      name: preview.user.name,
      email: preview.user.email,
    });
  }

  const result = await passwordResetService.resetPassword(token, password);

  if (!result.ok) {
    const messages = {
      expired: 'This reset link has expired. Please request a new one.',
      used: 'This reset link has already been used. Please request a new one.',
      invalid: 'This reset link is not valid. Please request a new one.',
    };
    throw ApiError.badRequest(messages[result.reason] || messages.invalid);
  }

  res.json({
    success: true,
    message: 'Your password has been reset. Please sign in with your new password.',
  });
});

/**
 * GET /api/auth/invite/:token
 *
 * What the accept-invite page loads before showing its form: who the invite is
 * for and which role it grants, so the invitee can see what they are accepting
 * rather than typing a password into an anonymous box.
 *
 * Public by necessity — the whole point is that the recipient has no account
 * yet. The token IS the credential, and it reveals only what the email that
 * carried it already said.
 */
const getInvite = asyncHandler(async (req, res) => {
  const preview = await inviteService.peek(req.params.token);

  if (!preview.ok) {
    throw ApiError.badRequest(
      'This invitation is not valid, has expired, or has already been used.'
    );
  }

  res.json({
    success: true,
    data: {
      name: preview.user.name,
      email: preview.user.email,
      role: preview.user.role,
    },
  });
});

/**
 * POST /api/auth/accept-invite
 *
 * Sets the password and activates the account. Rate limited on the route for
 * the same reason as password reset: it accepts a token, so it is somewhere to
 * guess at them.
 */
const acceptInvite = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    throw ApiError.badRequest('An invitation token and a password are required');
  }

  // Validated before the token is consumed — an invite is single use, so a
  // rejected password would otherwise burn it.
  const preview = await inviteService.peek(token);
  if (preview.ok) {
    await assertStrongPassword(password, {
      name: preview.user.name,
      email: preview.user.email,
    });
  }

  const result = await inviteService.acceptInvite(token, password);

  if (!result.ok) {
    const messages = {
      expired: 'This invitation has expired. Ask an administrator to send a new one.',
      used: 'This invitation has already been used. Try signing in instead.',
      deactivated: 'This account has been deactivated. Please contact an administrator.',
      invalid: 'This invitation is not valid. Ask an administrator to send a new one.',
    };
    throw ApiError.badRequest(messages[result.reason] || messages.invalid);
  }

  /*
   * Signed in immediately on success.
   *
   * The alternative — "your account is ready, now go and log in" — asks someone
   * to type the password they set four seconds ago, for no security gain: they
   * have just proved control of the mailbox AND chosen the credential.
   */
  const session = await issueSession(result.user, req);
  sendSession(res, { user: result.user, ...session }, 201);
});

/** GET /api/auth/me — the currently authenticated user, for session restore. */
const getMe = asyncHandler(async (req, res) => {
  res.json({ success: true, data: { user: req.user } });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  getInvite,
  acceptInvite,
  getMe,
};
