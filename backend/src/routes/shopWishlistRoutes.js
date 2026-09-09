const express = require('express');
const {
  getWishlist,
  addToWishlist,
  removeFromWishlist,
  mergeWishlist,
} = require('../controllers/shopWishlistController');
const { protectBuyer } = require('../middleware/buyerAuth');

const router = express.Router();

// Buyer-only, in full — a guest wishlist never reaches the server. See
// shopWishlistController.js's note, mirroring the cart's own split.
router.use(protectBuyer);

router.get('/', getWishlist);
router.post('/', addToWishlist);
router.delete('/:productId', removeFromWishlist);
router.post('/merge', mergeWishlist);

module.exports = router;
