const express = require('express');
const { aiSearch } = require('../controllers/aiSearchController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Authenticated only. Role scoping is applied inside the controller, using the
// same filters as the regular list endpoints.
router.post('/', protect, aiSearch);

module.exports = router;
