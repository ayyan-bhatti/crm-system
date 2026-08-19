const express = require('express');
const {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  deleteOrder,
} = require('../controllers/orderController');
const { protect } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

// Same shape as customers: all roles reach the routes, and sales reps are
// scoped to orders they created or that belong to their customers.
router.use(protect);

/*
 * Order creation is the one endpoint where a retry can cost real money, so it
 * takes an optional `Idempotency-Key` header — a dropped response, a refresh
 * mid-request or a double-click then produces one order instead of two. The
 * middleware runs after `protect` because keys are scoped per user.
 */
router.route('/').get(listOrders).post(idempotency, createOrder);
router.route('/:id').get(getOrder).patch(updateOrder).delete(deleteOrder);

module.exports = router;
