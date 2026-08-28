const Order = require('../models/Order');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { getPagination } = require('../utils/queryHelpers');
const { ORDER_POPULATE } = require('./orderController');
const changeRequestService = require('../services/changeRequestService');

/**
 * A buyer's own orders: `/api/shop/orders*`. Everything here is scoped to
 * `req.buyer._id` — a buyer has no broader view of the order collection than
 * that, ever, the same way a sales rep's view is scoped to `assignedTo`.
 */

/** GET /api/shop/orders — the signed-in buyer's own orders, newest first. */
const listMyOrders = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query);
  const filter = { buyerId: req.buyer._id };

  const [data, total] = await Promise.all([
    Order.find(filter)
      .populate(ORDER_POPULATE)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

/**
 * Load an order and refuse it unless it belongs to the signed-in buyer.
 *
 * 404, not 403, for someone else's order — matching the rest of this app's
 * rule for a sub-resource whose existence a caller has no business learning:
 * a buyer probing order ids has no way to tell "not yours" from "does not
 * exist" apart, which is exactly the point.
 */
async function loadOwnOrder(req) {
  const order = await Order.findById(req.params.id).populate(ORDER_POPULATE);
  if (!order || String(order.buyerId) !== String(req.buyer._id)) {
    throw ApiError.notFound('Order not found');
  }
  return order;
}

/** GET /api/shop/orders/:id */
const getMyOrder = asyncHandler(async (req, res) => {
  const order = await loadOwnOrder(req);
  res.json({ success: true, data: order });
});

/** Refuse a request against an order that is no longer pending. */
function assertStillPending(order) {
  if (order.status !== 'pending') {
    throw ApiError.badRequest(
      `This order is already ${order.status} and can no longer be changed.`
    );
  }
}

/** POST /api/shop/orders/:id/request-cancel */
const requestCancel = asyncHandler(async (req, res) => {
  const order = await loadOwnOrder(req);
  assertStillPending(order);

  const request = await changeRequestService.submit(
    {
      entity: 'order',
      entityId: order._id,
      action: 'cancel',
      label: order.orderNumber || String(order._id),
    },
    req.buyer
  );

  res.status(202).json({
    success: true,
    message: 'Your cancellation request has been sent for approval.',
    data: request,
  });
});

/** POST /api/shop/orders/:id/request-edit — body: { items: [{ product, quantity }] } */
const requestEdit = asyncHandler(async (req, res) => {
  const order = await loadOwnOrder(req);
  assertStillPending(order);

  const rawItems = req.body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw ApiError.badRequest('An edit request needs at least one item');
  }

  const request = await changeRequestService.submit(
    {
      entity: 'order',
      entityId: order._id,
      action: 'update',
      payload: { items: rawItems },
      label: order.orderNumber || String(order._id),
    },
    req.buyer
  );

  res.status(202).json({
    success: true,
    message: 'Your edit request has been sent for approval.',
    data: request,
  });
});

/** POST /api/shop/orders/ask — body: { question } */
const askAboutOrders = asyncHandler(async (req, res) => {
  const { question } = req.body;
  if (typeof question !== 'string' || !question.trim()) {
    throw ApiError.badRequest('A non-empty "question" is required');
  }
  if (question.length > 500) {
    throw ApiError.badRequest('Question cannot exceed 500 characters');
  }

  const { answer } = require('../services/orderAssistantService');
  const result = await answer(question.trim(), req.buyer._id);

  res.json({ success: true, mode: result.mode, data: { answer: result.answer } });
});

module.exports = { listMyOrders, getMyOrder, requestCancel, requestEdit, askAboutOrders };
