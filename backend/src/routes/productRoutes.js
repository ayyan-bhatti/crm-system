const express = require('express');
const {
  listProducts,
  listProductOptions,
  listCategories,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} = require('../controllers/productController');
const { protect } = require('../middleware/auth');
const { requireManagerOrAdmin } = require('../middleware/roles');

const router = express.Router();

router.use(protect);

// --- Read: any authenticated user, including sales reps --------------------
// Declared before '/:id' so "categories" and "options" aren't parsed as ids.
router.get('/categories', listCategories);
router.get('/options', listProductOptions);
router.get('/', listProducts);
router.get('/:id', getProduct);

// --- Write: managers and admins only ---------------------------------------
// Sales reps have read-only access to products, so every route below this line
// returns 403 for them.
router.post('/', requireManagerOrAdmin, createProduct);
router.patch('/:id', requireManagerOrAdmin, updateProduct);
router.delete('/:id', requireManagerOrAdmin, deleteProduct);

module.exports = router;
