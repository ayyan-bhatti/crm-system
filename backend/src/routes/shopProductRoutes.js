const express = require('express');
const {
  listPublicProducts,
  listPublicCategories,
  listPublicColours,
  getPublicProduct,
  searchProducts,
  getRecommendations,
} = require('../controllers/shopProductController');

const router = express.Router();

// Entirely public — no auth middleware at all. See the controller for why the
// projection, not a permission check, is what protects internal fields here.
//
// Every literal path is declared before "/:id", or Express would read "search",
// "categories" and "colours" as product ids and answer 404 for all three.
router.get('/search', searchProducts);
router.get('/categories', listPublicCategories);
router.get('/colours', listPublicColours);
router.get('/', listPublicProducts);
router.get('/:id', getPublicProduct);
router.get('/:id/recommendations', getRecommendations);

module.exports = router;
