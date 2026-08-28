const express = require('express');
const {
  listPublicProducts,
  getPublicProduct,
  searchProducts,
  getRecommendations,
} = require('../controllers/shopProductController');

const router = express.Router();

// Entirely public — no auth middleware at all. See the controller for why the
// projection, not a permission check, is what protects internal fields here.
// Declared before "/:id" so "search" is never read as a product id.
router.get('/search', searchProducts);
router.get('/', listPublicProducts);
router.get('/:id', getPublicProduct);
router.get('/:id/recommendations', getRecommendations);

module.exports = router;
