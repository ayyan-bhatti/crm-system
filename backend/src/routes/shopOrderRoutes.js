const express = require('express');
const {
  listMyOrders,
  getMyOrder,
  requestCancel,
  requestEdit,
  askAboutOrders,
} = require('../controllers/shopOrderController');
const { protectBuyer } = require('../middleware/buyerAuth');

const router = express.Router();

// A buyer's order history is entirely theirs to see; there is no guest view.
router.use(protectBuyer);

// Declared before "/:id" so "ask" is never read as an order id.
router.post('/ask', askAboutOrders);
router.get('/', listMyOrders);
router.get('/:id', getMyOrder);
router.post('/:id/request-cancel', requestCancel);
router.post('/:id/request-edit', requestEdit);

module.exports = router;
