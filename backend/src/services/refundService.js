const Order = require('../models/Order');
const stripeService = require('./stripeService');
const { PAYMENT_STATUS } = require('../config/constants');
const { componentLogger } = require('../config/logger');

const log = componentLogger('refunds');

/**
 * Refunding a cancelled order.
 *
 * THE ORDERING RULE, WHICH IS THE WHOLE POINT OF THIS FILE
 *
 * Money goes back BEFORE stock does. The brief put it as "only restore stock
 * once the refund call succeeds", and that is the same discipline the stock
 * transaction logic already follows everywhere else in this codebase: never
 * record a consequence of something that has not actually happened.
 *
 * Getting it the other way round — cancel, restock, then refund — produces a
 * specific and nasty failure. If the refund call fails (card expired, Stripe
 * down, network gone) you now have an order marked cancelled, inventory
 * credited back and sold to somebody else, and a customer who has been charged
 * for goods they will not receive and cannot get money back for without a
 * manual intervention nobody has been told to make.
 *
 * WHY THE STRIPE CALL HAPPENS OUTSIDE THE DATABASE TRANSACTION
 *
 * Two independent reasons, both sufficient:
 *
 *   1. A MongoDB transaction can be retried automatically on a write conflict.
 *      A Stripe call inside one would be re-issued by that retry. Refunds are
 *      not naturally idempotent, so that is a route to refunding twice.
 *   2. A network call inside a transaction holds locks for the duration of
 *      somebody else's outage.
 *
 * The idempotency key below closes the remaining window — a refund retried at
 * the HTTP layer, or an admin double-clicking approve — by making Stripe itself
 * recognise the second attempt as the same one and return the original refund
 * instead of creating another.
 *
 * WHAT IS DELIBERATELY NOT HANDLED
 *
 * A crash between "Stripe refunded" and "database updated" leaves a refunded
 * payment on an order still marked paid. That is visible (the Stripe dashboard
 * and the order disagree) and safe (the customer has their money; nothing has
 * been over-restocked, because the stock restore had not run yet). Making it
 * impossible would need a durable outbox, which is a great deal of machinery
 * for a window measured in milliseconds. Stating the gap is more useful than
 * pretending it is closed.
 */

/** Whether this order has money that could be given back. */
function isRefundable(order) {
  return (
    order?.payment?.status === PAYMENT_STATUS.PAID && Boolean(order?.payment?.paymentIntentId)
  );
}

/**
 * Refund an order if it was genuinely paid through Stripe.
 *
 * Returns `null` when there is nothing to refund — a cash-on-delivery order, an
 * order placed before payments existed, or one already refunded. That is a
 * normal outcome and NOT an error: most cancellations in this app are of orders
 * nobody ever paid for.
 *
 * Throws if a refund was owed and Stripe refused. Callers must let that
 * propagate rather than swallowing it, because the whole ordering guarantee
 * above depends on the cancellation not proceeding.
 *
 * @param {string|object} orderOrId
 * @returns {Promise<null|{ refundId: string, amount: number, status: string }>}
 */
async function refundOrderIfPaid(orderOrId) {
  const order =
    typeof orderOrId === 'string' || orderOrId?._bsontype || !orderOrId?.payment
      ? await Order.findById(orderOrId?._id || orderOrId)
      : orderOrId;

  if (!order) return null;

  if (!isRefundable(order)) {
    log.debug(
      { orderId: order._id, paymentStatus: order.payment?.status },
      'nothing to refund on this order'
    );
    return null;
  }

  if (!stripeService.isEnabled()) {
    /*
     * A paid order exists but this deployment has no Stripe key — which means
     * somebody removed the key after taking money. Refusing the cancellation is
     * the correct response: proceeding would restore stock for an order whose
     * customer is still out of pocket, and the only person who can fix that is
     * an operator who needs to be told, loudly, rather than a customer who will
     * find out slowly.
     */
    log.error(
      { orderId: order._id },
      'cannot refund a paid order — Stripe is not configured on this deployment'
    );
    throw new Error(
      'This order was paid by card and cannot be refunded because Stripe is not ' +
        'configured. Restore the STRIPE_SECRET_KEY before cancelling it.'
    );
  }

  const refund = await stripeService.refundPayment(
    order.payment.paymentIntentId,
    // Stable per order — see the long note above on why this is not optional.
    `refund_order_${order._id}`
  );

  /*
   * Written with `updateOne` rather than by mutating and saving the document.
   * The caller may be about to open a transaction and re-read this order; a
   * half-saved Mongoose document floating around outside it is a good way to
   * overwrite the transaction's own changes on a later save.
   */
  await Order.updateOne(
    { _id: order._id },
    {
      $set: {
        'payment.status': PAYMENT_STATUS.REFUNDED,
        'payment.refundId': refund.id,
        'payment.refundedAt': new Date(),
      },
    }
  );

  log.info({ orderId: order._id, refundId: refund.id }, 'order refunded ahead of cancellation');

  return { refundId: refund.id, amount: refund.amount, status: refund.status };
}

module.exports = { refundOrderIfPaid, isRefundable };
