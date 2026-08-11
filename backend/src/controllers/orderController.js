const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ORDER_STATUS } = require('../config/constants');
const { hasFullRecordAccess, canAccessCustomer } = require('../middleware/roles');
const { customerScopeFilter } = require('./customerController');
const {
  getPagination,
  getSort,
  paginatedResponse,
  getDateRange,
} = require('../utils/queryHelpers');

const SORTABLE_FIELDS = ['total', 'status', 'createdAt'];

// ---------------------------------------------------------------------------
// Stock helpers
//
// This is the part of the app most likely to go wrong, so the rules are spelled
// out here in one place:
//
//   1. An order can only be created if every line has enough stock.
//   2. Stock is decremented exactly once, when the order becomes `completed`.
//   3. Cancelling a completed order puts the stock back.
//
// Rule 2 is enforced by the `completedAt` timestamp rather than by the status
// alone: status can be written repeatedly with the same value, but `completedAt`
// tells us whether the decrement has already happened.
// ---------------------------------------------------------------------------

/**
 * Validate the requested lines against live product data and build the order
 * items, snapshotting each product's current price.
 *
 * The client's own `total` is never trusted — it is always recomputed here.
 */
async function buildOrderItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw ApiError.badRequest('An order must contain at least one item');
  }

  // Merge duplicate lines for the same product first. Otherwise two lines of 6
  // against a stock of 10 would each pass the check individually and oversell.
  const merged = new Map();
  for (const line of rawItems) {
    const productId = line.product;
    const quantity = Number(line.quantity);

    if (!mongoose.isValidObjectId(productId)) {
      throw ApiError.badRequest(`Invalid product id: ${productId}`);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw ApiError.badRequest('Each item needs an integer quantity of at least 1');
    }

    merged.set(String(productId), (merged.get(String(productId)) || 0) + quantity);
  }

  const productIds = [...merged.keys()];
  const products = await Product.find({ _id: { $in: productIds } });

  if (products.length !== productIds.length) {
    const found = new Set(products.map((p) => String(p._id)));
    const missing = productIds.filter((id) => !found.has(id));
    throw ApiError.badRequest(`Unknown product id(s): ${missing.join(', ')}`);
  }

  const items = [];
  let total = 0;

  for (const product of products) {
    const quantity = merged.get(String(product._id));

    if (quantity > product.stockQty) {
      throw ApiError.badRequest(
        `Insufficient stock for "${product.name}" (${product.sku}): ` +
          `requested ${quantity}, available ${product.stockQty}`
      );
    }

    items.push({ product: product._id, quantity, priceAtOrder: product.price });
    total += quantity * product.price;
  }

  // Round to cents — floating-point multiplication of prices otherwise produces
  // totals like 59.99000000000001.
  return { items, total: Math.round(total * 100) / 100 };
}

/**
 * Decrement stock for every line of an order.
 *
 * The `stockQty: { $gte: quantity }` condition makes each update conditional, so
 * two requests completing the same order concurrently cannot drive stock
 * negative — the second one matches nothing and reports zero modified docs.
 * If any line fails, the lines already applied are rolled back.
 */
async function decrementStock(items) {
  const applied = [];

  for (const item of items) {
    const result = await Product.updateOne(
      { _id: item.product, stockQty: { $gte: item.quantity } },
      { $inc: { stockQty: -item.quantity } }
    );

    if (result.modifiedCount !== 1) {
      // Put back whatever we already took before reporting the failure.
      await restoreStock(applied);
      const product = await Product.findById(item.product);
      throw ApiError.badRequest(
        `Insufficient stock to complete this order for "${product ? product.name : item.product}"`
      );
    }

    applied.push(item);
  }
}

/** Add stock back — used when cancelling a completed order, and on rollback. */
async function restoreStock(items) {
  for (const item of items) {
    await Product.updateOne({ _id: item.product }, { $inc: { stockQty: item.quantity } });
  }
}

/**
 * The slice of the order collection a user may see.
 *
 * Sales reps get orders they created, plus orders belonging to any customer in
 * their own customer scope. The customer lookup runs first because MongoDB
 * cannot join across collections in a plain find().
 */
async function orderScopeFilter(user) {
  if (hasFullRecordAccess(user)) return {};

  const customerIds = await Customer.find(customerScopeFilter(user)).distinct('_id');

  return { $or: [{ createdBy: user._id }, { customer: { $in: customerIds } }] };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * GET /api/orders
 * Filters: ?status= ?customer= ?from= ?to= (date range on createdAt)
 * Paging:  ?page= ?limit= ?sort=
 */
const listOrders = asyncHandler(async (req, res) => {
  const { status, customer, from, to } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const filter = { ...(await orderScopeFilter(req.user)) };

  if (status) filter.status = status;
  if (customer) filter.customer = customer;

  const createdAt = getDateRange(from, to);
  if (createdAt) filter.createdAt = createdAt;

  const [data, total] = await Promise.all([
    Order.find(filter)
      .populate('customer', 'name email company city status')
      .populate('createdBy', 'name email role')
      .populate('items.product', 'name sku price')
      .sort(getSort(req.query, SORTABLE_FIELDS))
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);

  res.json(paginatedResponse({ data, total, page, limit }));
});

/** GET /api/orders/:id */
const getOrder = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id)
    .populate('customer')
    .populate('createdBy', 'name email role')
    .populate('items.product', 'name sku price stockQty');

  if (!order) throw ApiError.notFound('Order not found');

  if (!canAccessOrderDocument(req.user, order)) {
    throw ApiError.forbidden('You do not have access to this order');
  }

  res.json({ success: true, data: order });
});

/**
 * POST /api/orders
 *
 * Accepts `status: "completed"` to record an already-fulfilled sale, in which
 * case stock is decremented as part of creation. Otherwise the order starts as
 * `pending` and stock moves later, on completion.
 */
const createOrder = asyncHandler(async (req, res) => {
  const { customer: customerId, items: rawItems, status } = req.body;

  if (!customerId) throw ApiError.badRequest('An order must reference a customer');

  const customer = await Customer.findById(customerId);
  if (!customer) throw ApiError.notFound('Customer not found');

  // A sales rep may only place orders for their own customers.
  if (!canAccessCustomer(req.user, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  if (status && ![ORDER_STATUS.PENDING, ORDER_STATUS.COMPLETED].includes(status)) {
    throw ApiError.badRequest('A new order must be created as pending or completed');
  }

  const { items, total } = await buildOrderItems(rawItems);
  const completing = status === ORDER_STATUS.COMPLETED;

  // Take the stock before writing the order, so a stock failure leaves no
  // half-valid order behind.
  if (completing) await decrementStock(items);

  let order;
  try {
    order = await Order.create({
      customer: customer._id,
      items,
      total,
      status: completing ? ORDER_STATUS.COMPLETED : ORDER_STATUS.PENDING,
      completedAt: completing ? new Date() : null,
      createdBy: req.user._id,
    });
  } catch (err) {
    if (completing) await restoreStock(items);
    throw err;
  }

  await order.populate([
    { path: 'customer', select: 'name email company city status' },
    { path: 'items.product', select: 'name sku price' },
  ]);

  res.status(201).json({ success: true, data: order });
});

/**
 * PATCH /api/orders/:id
 *
 * Handles the status transitions, which are the only place stock moves:
 *
 *   pending   -> completed   decrement stock, stamp completedAt
 *   completed -> cancelled   restore stock, clear completedAt
 *   pending   -> cancelled   nothing to restore (stock was never taken)
 *
 * Re-sending the same status is a no-op, so a duplicate request can't
 * double-decrement.
 */
const updateOrder = asyncHandler(async (req, res) => {
  const { status, items: rawItems } = req.body;

  // The customer is populated because the ownership check may need to read its
  // `assignedTo` — a sales rep can edit an order they did not create if it
  // belongs to a customer assigned to them.
  const order = await Order.findById(req.params.id).populate('customer');
  if (!order) throw ApiError.notFound('Order not found');

  if (!canAccessOrderDocument(req.user, order)) {
    throw ApiError.forbidden('You do not have access to this order');
  }

  // --- Item edits: only while the order is still pending ---------------------
  if (rawItems !== undefined) {
    if (order.status !== ORDER_STATUS.PENDING) {
      throw ApiError.badRequest(
        `Items cannot be changed on a ${order.status} order. Create a new order instead.`
      );
    }
    const { items, total } = await buildOrderItems(rawItems);
    order.items = items;
    order.total = total;
  }

  // --- Status transitions ----------------------------------------------------
  if (status !== undefined && status !== order.status) {
    const from = order.status;

    if (from === ORDER_STATUS.CANCELLED) {
      throw ApiError.badRequest('A cancelled order cannot be reopened');
    }

    if (status === ORDER_STATUS.COMPLETED) {
      // completedAt is the guard: if it is already set, the stock for this
      // order has been taken once and must not be taken again.
      if (!order.completedAt) {
        await decrementStock(order.items);
        order.completedAt = new Date();
      }
      order.status = ORDER_STATUS.COMPLETED;
    } else if (status === ORDER_STATUS.CANCELLED) {
      // Only give stock back if it was actually taken.
      if (order.completedAt) {
        await restoreStock(order.items);
        order.completedAt = null;
      }
      order.status = ORDER_STATUS.CANCELLED;
    } else if (status === ORDER_STATUS.PENDING) {
      throw ApiError.badRequest(`An order cannot move from ${from} back to pending`);
    } else {
      throw ApiError.badRequest(`Unknown order status: ${status}`);
    }
  }

  await order.save();
  await order.populate([
    { path: 'customer', select: 'name email company city status' },
    { path: 'items.product', select: 'name sku price' },
  ]);

  res.json({ success: true, data: order });
});

/**
 * DELETE /api/orders/:id
 *
 * Deleting a completed order restores its stock, so the numbers stay honest.
 */
const deleteOrder = asyncHandler(async (req, res) => {
  // Populated for the same reason as in updateOrder — see the note there.
  const order = await Order.findById(req.params.id).populate('customer');
  if (!order) throw ApiError.notFound('Order not found');

  if (!canAccessOrderDocument(req.user, order)) {
    throw ApiError.forbidden('You do not have access to this order');
  }

  if (order.completedAt) await restoreStock(order.items);

  await order.deleteOne();

  res.json({ success: true, message: 'Order deleted', data: { id: req.params.id } });
});

/**
 * Ownership check for a single order.
 *
 * Kept local rather than using the generic `canAccessOrder` helper because here
 * we may need to load the order's customer to answer the question, which the
 * synchronous helper cannot do.
 */
function canAccessOrderDocument(user, order) {
  if (hasFullRecordAccess(user)) return true;

  const createdBy = order.createdBy?._id || order.createdBy;
  if (createdBy && String(createdBy) === String(user._id)) return true;

  // When the customer is populated we can check assignment directly.
  const customer = order.customer;
  if (customer && customer.assignedTo !== undefined) {
    return canAccessCustomer(user, customer);
  }

  return false;
}

module.exports = {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  deleteOrder,
  orderScopeFilter,
};
