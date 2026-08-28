const express = require('express');
const { getCart, addItem, updateItem, removeItem, mergeCart } = require('../controllers/shopCartController');
const { protectBuyer } = require('../middleware/buyerAuth');

const router = express.Router();

// Buyer-only, in full — a guest cart never reaches the server. See models/Cart.js.
router.use(protectBuyer);

router.get('/', getCart);
router.post('/items', addItem);
router.patch('/items/:productId', updateItem);
router.delete('/items/:productId', removeItem);
router.post('/merge', mergeCart);

module.exports = router;
