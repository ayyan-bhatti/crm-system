const express = require('express');
const {
  listOrders,
  listDeliveries,
  getOrder,
  createOrder,
  updateOrder,
  assignOrder,
  requestOrderTransfer,
  updateFulfilment,
  getOrderTracking,
  deleteOrder,
} = require('../controllers/orderController');
const {
  listOrderActivity,
  addOrderActivity,
  summarizeOrderActivity,
} = require('../controllers/activityController');
const { protect } = require('../middleware/auth');
const { requireManagerOrAdmin } = require('../middleware/roles');
const { idempotency } = require('../middleware/idempotency');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');

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
 * The delivery board. Declared BEFORE `/:id`, or Express matches "deliveries"
 * as an order id and the route becomes a 404 for a malformed ObjectId — the
 * classic ordering bug in an Express router, and silent because the 404 looks
 * like a missing record rather than a shadowed route.
 *
 * Scoped like every other order read rather than gated: a rep sees the parcels
 * on their own orders, which is precisely the list they need to work from.
 */
router.get('/deliveries', listDeliveries);
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

/*
 * A rep asking for an order to be handed on.
 *
 * No role middleware, because the rule is about the RECORD rather than the
 * role: whoever holds this order may ask. The handler checks that. A manager or
 * admin reaching it would simply be taking the long way round to something they
 * can already do directly, which is harmless.
 */
router.post('/:id/transfer-request', requestOrderTransfer);

/*
 * Moving an order along the delivery sequence, and setting the date the
 * customer is told to expect it.
 *
 * NO ROLE MIDDLEWARE, and that is the considered choice rather than an
 * omission. The rule is about the RECORD, not the role — admin and manager see
 * every order, a rep sees the ones assigned to them, and `canAccessOrderDocument`
 * inside the handler already encodes exactly that. Gating the route to
 * manager-or-admin would leave the person who physically posted the parcel
 * unable to say so, and every shipment update would arrive second-hand through
 * somebody repeating what they were told.
 *
 * Separate from PATCH /:id for the same reason `/assign` is: `status` decides
 * whether a sale counts and whether stock moves, this decides what the customer
 * is told about a parcel, and they have different audiences and different
 * permissions. See the note above updateFulfilment.
 */
router.patch('/:id/fulfilment', updateFulfilment);

/*
 * The tracking-page link plus, for a DHL shipment, a live status pulled from
 * DHL's own API. Same access rule as the fulfilment update above and for the
 * same reason — this is a read of the same record, not a role-scoped report.
 */
router.get('/:id/tracking', getOrderTracking);

/*
 * The notes timeline.
 *
 * No role middleware, for the same reason as the transfer request above: the
 * rule is about the record. Whoever may open this order may read and add its
 * notes, which the handler resolves with the same helper the order's own
 * endpoints use — so the assigned rep can write down what happened on a
 * delivery, and a rep holding no claim to the order gets the same 403 they get
 * from the order itself.
 *
 * No PATCH, no DELETE. Notes are append-only and the model enforces it as well
 * as the routes omitting it — see models/Activity.
 */
router.route('/:id/activity').get(listOrderActivity).post(addOrderActivity);
router.get(
  '/:id/activity/summary',
  aiSearchLimiter,
  aiPerUserLimiter,
  summarizeOrderActivity
);

module.exports = router;
