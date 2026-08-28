const express = require('express');
const { checkout } = require('../controllers/shopCheckoutController');
const { attachBuyerIfPresent } = require('../middleware/buyerAuth');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

/*
 * `attachBuyerIfPresent` rather than `protectBuyer` — checkout is the one
 * route both a guest and a signed-in buyer use, and the whole point is that
 * neither is turned away. `idempotency` runs after it so a signed-in buyer's
 * key is scoped to their own id rather than falling back to their IP.
 */
router.post('/', attachBuyerIfPresent, idempotency, checkout);

module.exports = router;
