const express = require('express');
const { listMyMessages } = require('../controllers/shopMessageController');
const { protectBuyer } = require('../middleware/buyerAuth');

const router = express.Router();

// A buyer's own notifications are entirely theirs to see, same as their order
// history — see shopOrderRoutes.js for the identical shape.
router.use(protectBuyer);

router.get('/', listMyMessages);

module.exports = router;
