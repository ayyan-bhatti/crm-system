const Customer = require('../models/Customer');
const Cart = require('../models/Cart');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { withTransaction } = require('../utils/transaction');
const { placeOrder, ORDER_POPULATE } = require('./orderController');
const { matchOrCreateCustomer } = require('../services/storefrontCustomerService');
const { recordAudit } = require('../services/auditService');

/**
 * POST /api/shop/checkout
 *
 * Reuses `placeOrder()` — the same pricing-at-time-of-order, atomic order
 * numbering and stock-decrement guarantees every other order in this app
 * gets. A storefront order is not a structurally different kind of order;
 * the only difference is who is calling: an unauthenticated guest or a
 * signed-in buyer instead of staff. See `services/storefrontCustomerService`
 * for the customer-matching half of this, and `middleware/idempotency.js`
 * for why the same `Idempotency-Key` header works here too — a dropped
 * response on a checkout button is the same lost-connection problem it
 * solves for the internal order form, just with a less forgiving audience:
 * staff can look an order up and ask; a guest who is not sure their order
 * went through has no such recourse and will otherwise just try again.
 *
 * STOREFRONT ORDERS ALWAYS START `pending`, REGARDLESS OF WHAT WAS SENT.
 *
 * `status` is never read from the request body here. A staff-placed order
 * may be recorded as already `completed` (an over-the-phone sale being
 * entered after the fact); nothing about a storefront checkout is ever
 * after the fact — stock should not move until staff actually fulfil it.
 */
const checkout = asyncHandler(async (req, res) => {
  const rawItems = req.body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw ApiError.badRequest('A checkout needs at least one item');
  }

  const buyer = req.buyer || null;

  let name;
  let email;
  let phone = '';
  let address = '';
  let city = '';

  if (buyer) {
    name = buyer.name;
    email = buyer.email;

    const chosen = req.body.addressId
      ? buyer.addresses.id(req.body.addressId)
      : buyer.addresses[0];

    if (req.body.addressId && !chosen) {
      throw ApiError.badRequest('That is not one of your saved addresses');
    }

    if (chosen) {
      address = chosen.address;
      phone = chosen.phone || '';
    }
  } else {
    ({ name, email, phone = '', address = '', city = '' } = req.body);

    if (!name || !email) {
      throw ApiError.badRequest('Name and email are required to check out as a guest');
    }
  }

  const order = await withTransaction(async (session) => {
    /*
     * A returning buyer already linked to a `Customer` skips matching
     * entirely and orders straight against it — matching by email again
     * would be redundant, and could in principle resolve somewhere else if
     * the buyer's account email were ever changed after the link was made.
     */
    const customer = buyer?.linkedCustomerId
      ? await Customer.findById(buyer.linkedCustomerId).session(session)
      : await matchOrCreateCustomer({ email, name, phone, address, city }, session);

    if (!customer) throw ApiError.notFound('Customer not found');

    if (buyer && !buyer.linkedCustomerId) {
      buyer.linkedCustomerId = customer._id;
      await buyer.save({ session });
    }

    const placed = await placeOrder(
      {
        customerId: customer._id,
        rawItems,
        status: 'pending',
        assignedTo: null,
        source: 'storefront',
        buyerId: buyer ? buyer._id : null,
      },
      session
    );

    // A signed-in buyer's cart is spent the moment their order is placed —
    // inside the same transaction, so a rollback of the order leaves the
    // cart untouched rather than emptying it for nothing.
    if (buyer) {
      await Cart.updateOne({ buyer: buyer._id }, { items: [] }, { session });
    }

    return placed;
  });

  /*
   * `recordAudit` reads `req.user` for its actor snapshot, which does not
   * exist on a guest or buyer request — it degrades to an empty actor rather
   * than erroring, but an audit entry with no actor at all is not useful. The
   * buyer or guest's identity goes in the note instead.
   */
  await recordAudit(req, {
    action: 'create',
    entity: 'order',
    entityId: order._id,
    label: `Order ${order._id}`,
    after: order,
    note: buyer
      ? `Storefront checkout by buyer ${buyer.email}`
      : `Storefront guest checkout by ${email}`,
  });

  await order.populate(ORDER_POPULATE);

  res.status(201).json({ success: true, data: order });
});

module.exports = { checkout };
