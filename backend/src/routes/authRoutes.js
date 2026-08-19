const express = require('express');
const {
  register,
  login,
  refresh,
  logout,
  getMe,
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');

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

// Authenticated
router.get('/me', protect, getMe);

module.exports = router;
