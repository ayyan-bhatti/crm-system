const Order = require('../models/Order');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parseOrderNumber } = require('../services/orderNumber');
const courierService = require('../services/courierService');

/**
 * The public "track my order" lookup — no buyer session, no staff session,
 * anyone with the two facts on the delivery note.
 *
 * WHY TWO FACTORS, AND WHY THEY NEVER DIFFER IN THE RESPONSE
 *
 * `orderNumber` alone is not a secret — it is sequential (`ORD-000142`,
 * `ORD-000143`, ...) specifically so a human can read it down a phone line,
 * which is the opposite of hard to guess. The email on the order is the
 * second factor, the same way a delivery courier asks "and the name on the
 * parcel?" before saying anything. A response that says "wrong email" for a
 * real order number and "no such order" for a made-up one hands an attacker
 * a free oracle for which order numbers exist at all — every branch below
 * that fails returns the exact same generic message.
 *
 * WHAT IS DELIBERATELY NOT RETURNED
 *
 * No items, no prices, no address, no phone number. This is a courier
 * tracking page, not a receipt — a stranger who somehow lands on a valid
 * (order number, email) pair should learn "it shipped, here is the courier",
 * not read someone else's order contents. The signed-in buyer's own order
 * page (`GET /api/shop/orders/:id`) is where the itemised version lives,
 * behind an actual login.
 */
const GENERIC_NOT_FOUND =
  'No order matches that order number and email. Double-check both and try again.';

const trackOrder = asyncHandler(async (req, res) => {
  const { orderNumber, email } = req.body;

  const canonical = parseOrderNumber(orderNumber);
  const suppliedEmail = String(email || '').trim().toLowerCase();

  if (!canonical || !suppliedEmail) {
    throw ApiError.badRequest('Enter both the order number and the email used to place it.');
  }

  const order = await Order.findOne({ orderNumber: canonical }).populate('customer', 'email');

  /*
   * "No such order" and "right order, wrong email" are the SAME outcome here
   * — see the note above. There is no separate branch for the two, on
   * purpose: a separate branch is exactly how the two would eventually drift
   * apart, in wording or in timing, into the oracle this is trying to avoid.
   */
  const orderEmail = order?.customer?.email;
  const matches = Boolean(orderEmail) && orderEmail.toLowerCase() === suppliedEmail;

  if (!matches) {
    throw ApiError.notFound(GENERIC_NOT_FOUND);
  }

  res.json({
    success: true,
    data: {
      orderNumber: order.orderNumber,
      // Already `cancelled` here when the order is — see the fulfilment
      // update rules in orderController.js, which keep the two in sync.
      fulfilment: order.fulfilment,
      createdAt: order.createdAt,
      estimatedDeliveryAt: order.estimatedDeliveryAt,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
      itemCount: order.items.length,
      courier: order.courier,
      trackingNumber: order.trackingNumber,
      trackingUrl: courierService.buildTrackingUrl(order.courier, order.trackingNumber),
    },
  });
});

module.exports = { trackOrder };
