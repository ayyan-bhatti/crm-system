const express = require('express');
const { getSummary, getDigest } = require('../controllers/dashboardController');
const { protect } = require('../middleware/auth');
const { requireManagerOrAdmin } = require('../middleware/roles');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.use(protect);

router.get('/summary', getSummary);
router.get('/digest', requireManagerOrAdmin, aiSearchLimiter, aiPerUserLimiter, getDigest);

module.exports = router;
