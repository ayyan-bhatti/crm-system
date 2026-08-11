const express = require('express');
const {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  deleteOrder,
} = require('../controllers/orderController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Same shape as customers: all roles reach the routes, and sales reps are
// scoped to orders they created or that belong to their customers.
router.use(protect);

router.route('/').get(listOrders).post(createOrder);
router.route('/:id').get(getOrder).patch(updateOrder).delete(deleteOrder);

module.exports = router;
