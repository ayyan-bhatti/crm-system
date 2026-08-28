const express = require('express');
const { register, login, refresh, logout, getMe } = require('../controllers/shopAuthController');
const { protectBuyer } = require('../middleware/buyerAuth');
const { shopLoginLimiter, shopRegisterLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/register', shopRegisterLimiter, register);
router.post('/login', shopLoginLimiter, login);

/*
 * Refresh and logout are public in the `protectBuyer` sense, for the same
 * reason their staff equivalents are — see `authRoutes.js`. Refresh has to
 * work once the access token has expired, and logout has to work when the
 * session is already broken; both verify the refresh cookie themselves.
 */
router.post('/refresh', refresh);
router.post('/logout', logout);

router.get('/me', protectBuyer, getMe);

module.exports = router;
