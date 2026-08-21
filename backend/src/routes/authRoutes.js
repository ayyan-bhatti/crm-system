const express = require('express');
const {
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
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const {
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
} = require('../middleware/rateLimit');

const router = express.Router();

/*
 * Public — and therefore the endpoints worth attacking. Both are rate limited
 * per IP; login is additionally protected by the per-account lockout in the
 * controller. See middleware/rateLimit.js for the chosen thresholds and why.
 */
router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);

/**
 * Refresh and logout are public in the `protect` sense on purpose.
 *
 * Refresh must work precisely when the access token has expired, so requiring a
 * valid access token would make it useless. Logout must work when the session
 * is already broken, so that a client can always clear its cookies. In both
 * cases the refresh cookie is the credential, and both endpoints verify it
 * themselves.
 */
router.post('/refresh', refresh);
router.post('/logout', logout);

/*
 * The forgot-password flow. Both steps are public by necessity — the whole
 * point is that the user cannot sign in.
 *
 * Both are rate limited, and for different reasons. Requesting a reset sends an
 * email, so an unthrottled endpoint is a way to use this server to spam someone
 * else's inbox. Redeeming one accepts a token, so an unthrottled endpoint is
 * somewhere to guess at them — 32 random bytes are not guessable, but a limit
 * costs nothing and removes the question.
 */
router.post('/forgot-password', passwordResetLimiter, forgotPassword);
router.post('/reset-password', passwordResetLimiter, resetPassword);

/*
 * Accepting an invitation. Public for the same reason the reset routes are:
 * the recipient has no account to authenticate with yet, and the token in the
 * link is the credential.
 *
 * Rate limited because both accept a token, which makes them somewhere to guess
 * at one — 32 random bytes are not guessable, but the limit costs nothing and
 * removes the question.
 */
router.get('/invite/:token', passwordResetLimiter, getInvite);
router.post('/accept-invite', passwordResetLimiter, acceptInvite);

// Authenticated
router.get('/me', protect, getMe);

/*
 * Rate limited as well as authenticated: the endpoint verifies the current
 * password, which makes it a second place an attacker with a hijacked session
 * can guess one. Endpoints behind a login are the easy ones to forget.
 */
router.post('/change-password', protect, passwordResetLimiter, changePassword);

module.exports = router;
