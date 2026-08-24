const express = require('express');
const {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  assignOrder,
  deleteOrder,
} = require('../controllers/orderController');
const { protect } = require('../middleware/auth');
const { requireManagerOrAdmin } = require('../middleware/roles');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

// Same shape as customers: all roles reach the routes, and sales reps are
// scoped to orders they created or that belong to their customers.
router.use(protect);

/*
 * Order creation is the one endpoint where a retry can cost real money, so it
 * takes an optional `Idempotency-Key` header — a dropped response, a refresh
 * mid-request or a double-click then produces one order instead of two. The
 * middleware runs after `protect` because keys are scoped per user.
 */
/*
 * Reading is scoped, not gated: everyone reaches this route and a sales rep
 * sees only the orders assigned to them (see orderScopeFilter).
 *
 * CREATING is manager-or-admin. An order is a commercial commitment — it
 * prices the lines and reserves what will become stock movement — and a rep
 * fulfils orders rather than agreeing them. They also have no customer book to
 * choose a customer from, so the form could not be completed even if the route
 * allowed it.
 */
router.route('/').get(listOrders).post(requireManagerOrAdmin, idempotency, createOrder);
/*
 * PATCH is open to the assigned rep on purpose, and narrowed inside the
 * handler: they may move the order to completed or cancelled, and are refused
 * if they try to change the items. That split cannot be expressed as route
 * middleware, because it depends on which FIELDS the body carries — see the
 * note in updateOrder.
 *
 * DELETE is manager-or-admin. Deleting a completed order restores stock, which
 * is a correction to the ledger rather than a step in fulfilling an order.
 */
router
  .route('/:id')
  .get(getOrder)
  .patch(updateOrder)
  .delete(requireManagerOrAdmin, deleteOrder);

/*
 * Reassigning an order to a different rep.
 *
 * A separate route from PATCH /:id, and manager-or-admin rather than
 * scope-checked, because it is a different kind of change: editing an order
 * alters what was sold, reassigning it alters who is accountable — which is
 * attached to commission and to who fields the call when something goes wrong.
 * A rep may do the first to their own order and must not do the second, and
 * expressing that inside the general update handler would mean a per-field
 * permission check, which is where rules like this go wrong quietly.
 */
router.patch('/:id/assign', requireManagerOrAdmin, assignOrder);

module.exports = router;
