const express = require('express');
const { listPublicProducts, getPublicProduct } = require('../controllers/shopProductController');

const router = express.Router();

// Entirely public — no auth middleware at all. See the controller for why the
// projection, not a permission check, is what protects internal fields here.
router.get('/', listPublicProducts);
router.get('/:id', getPublicProduct);

module.exports = router;
