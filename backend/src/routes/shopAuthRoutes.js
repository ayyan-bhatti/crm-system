const express = require('express');
const {
  register,
  login,
  refresh,
  logout,
  getMe,
  addAddress,
  updateAddress,
  deleteAddress,
  resendVerification,
} = require('../controllers/shopAuthController');
const { protectBuyer } = require('../middleware/buyerAuth');
const {
  shopLoginLimiter,
  shopRegisterLimiter,
  shopVerificationLimiter,
} = require('../middleware/rateLimit');

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

router.post('/addresses', protectBuyer, addAddress);
router.patch('/addresses/:addressId', protectBuyer, updateAddress);
router.delete('/addresses/:addressId', protectBuyer, deleteAddress);

/*
 * Authenticated rather than taking an email in the body — same reasoning as
 * the identical staff-side route: an anonymous "resend to this address"
 * endpoint is a way to make this server spam anyone's inbox on demand.
 */
router.post('/resend-verification', protectBuyer, shopVerificationLimiter, resendVerification);

module.exports = router;
