const express = require('express');
const {
  listMyOrders,
  getMyOrder,
  requestCancel,
  requestEdit,
} = require('../controllers/shopOrderController');
const { protectBuyer } = require('../middleware/buyerAuth');

const router = express.Router();

// A buyer's order history is entirely theirs to see; there is no guest view.
router.use(protectBuyer);

router.get('/', listMyOrders);
router.get('/:id', getMyOrder);
router.post('/:id/request-cancel', requestCancel);
router.post('/:id/request-edit', requestEdit);

module.exports = router;
