const express = require('express');
const {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} = require('../controllers/customerController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// All three roles may reach these routes. Sales reps are then limited to
// customers they created or are assigned to — enforced inside the controller,
// because that rule depends on the specific record being touched.
router.use(protect);

router.route('/').get(listCustomers).post(createCustomer);
router.route('/:id').get(getCustomer).patch(updateCustomer).delete(deleteCustomer);

module.exports = router;
