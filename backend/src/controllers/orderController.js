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
const { withTransaction } = require('../utils/transaction');

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
//
// TRANSACTIONS
//
// Every handler that moves stock now runs inside a MongoDB transaction (see
// utils/transaction.js). Two collections change together — Order and Product —
// and without a transaction a crash between the two writes leaves the database
// genuinely wrong rather than merely stale: stock taken with no order to show
// for it, or an order whose stock was never taken and can be sold again.
//
// The `session` threaded through these helpers is what puts each query inside
// the transaction. A query that does not receive it runs outside, is neither
// isolated nor rolled back, and makes the transaction decorative — which is why
// it is an explicit parameter on every one of them rather than something
// ambient.
// ---------------------------------------------------------------------------

/**
 * Validate the requested lines against live product data and build the order
 * items, snapshotting each product's current price.
 *
 * The client's own `total` is never trusted — it is always recomputed here.
 */
async function buildOrderItems(rawItems, session = null) {
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
  const products = await Product.find({ _id: { $in: productIds } }).session(session);

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
 * The `stockQty: { $gte: quantity }` condition is what makes this safe under
 * concurrency. It is a single atomic operation: MongoDB matches the document
 * and applies the decrement without anything getting in between, so two
 * requests for the last unit cannot both succeed. The loser matches no document
 * and reports zero modified — it does not silently drive stock negative, which
 * is what a read-then-write check does.
 *
 * Inside a transaction there is no manual rollback: if any line fails, the
 * thrown error aborts the transaction and every decrement already applied
 * disappears with it. The previous version compensated by hand, which worked
 * until the process died between the failure and the compensation.
 *
 * When transactions are unavailable (a standalone dev MongoDB — see
 * utils/transaction.js) `session` is null and the hand-rolled compensation is
 * used instead, so the fallback is degraded rather than broken.
 */
async function decrementStock(items, session = null) {
  const applied = [];

  for (const item of items) {
    const result = await Product.updateOne(
      { _id: item.product, stockQty: { $gte: item.quantity } },
      { $inc: { stockQty: -item.quantity } },
      { session }
    );

    if (result.modifiedCount !== 1) {
      // Without a transaction, put back whatever we already took. With one, the
      // abort does it — and doing both would double-credit the stock.
      if (!session) await restoreStock(applied, null);

      const product = await Product.findById(item.product).session(session);
      throw ApiError.badRequest(
        `Insufficient stock to complete this order for "${product ? product.name : item.product}"`
      );
    }

    applied.push(item);
  }
}

/** Add stock back — used when cancelling a completed order, and on rollback. */
async function restoreStock(items, session = null) {
  for (const item of items) {
    await Product.updateOne(
      { _id: item.product },
      { $inc: { stockQty: item.quantity } },
      { session }
    );
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

  if (status && ![ORDER_STATUS.PENDING, ORDER_STATUS.COMPLETED].includes(status)) {
    throw ApiError.badRequest('A new order must be created as pending or completed');
  }

  const completing = status === ORDER_STATUS.COMPLETED;

  /*
   * The whole sequence — validate the customer, price the lines, write the
   * order, take the stock — happens inside one transaction. Either all of it is
   * visible or none of it is; there is no moment at which another request can
   * observe an order whose stock has not been taken, or stock taken for an
   * order that does not exist.
   *
   * `session` has to be passed to every query in here. One that misses it runs
   * outside the transaction and quietly loses the guarantee, which is the
   * standard way a transaction ends up being decoration.
   */
  const order = await withTransaction(async (session) => {
    const customer = await Customer.findById(customerId).session(session);
    if (!customer) throw ApiError.notFound('Customer not found');

    // A sales rep may only place orders for their own customers.
    if (!canAccessCustomer(req.user, customer)) {
      throw ApiError.forbidden('You do not have access to this customer');
    }

    const { items, total } = await buildOrderItems(rawItems, session);

    // Order.create with a session takes an array — the single-document form
    // does not accept options.
    const [created] = await Order.create(
      [
        {
          customer: customer._id,
          items,
          total,
          status: completing ? ORDER_STATUS.COMPLETED : ORDER_STATUS.PENDING,
          completedAt: completing ? new Date() : null,
          createdBy: req.user._id,
        },
      ],
      { session }
    );

    // Stock moves last. If it fails, throwing here aborts the transaction and
    // the order above is never written — no compensation to remember.
    if (completing) await decrementStock(items, session);

    return created;
  });

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

  /*
   * Transactional for the same reason creation is: a completion decrements
   * stock AND stamps completedAt, and a cancellation restores stock AND clears
   * it. If half of either pair lands, the guard that stops stock being taken
   * twice is now lying about what happened.
   *
   * The order document is loaded inside the transaction as well, so the read
   * that decides whether to move stock and the write that moves it see the same
   * snapshot. Loading it outside would reintroduce exactly the read-then-write
   * gap the transaction is here to close.
   */
  const order = await withTransaction(async (session) => {
    // The customer is populated because the ownership check may need to read
    // its `assignedTo` — a sales rep can edit an order they did not create if
    // it belongs to a customer assigned to them.
    const found = await Order.findById(req.params.id).populate('customer').session(session);
    if (!found) throw ApiError.notFound('Order not found');

    if (!canAccessOrderDocument(req.user, found)) {
      throw ApiError.forbidden('You do not have access to this order');
    }

    // --- Item edits: only while the order is still pending -------------------
    if (rawItems !== undefined) {
      if (found.status !== ORDER_STATUS.PENDING) {
        throw ApiError.badRequest(
          `Items cannot be changed on a ${found.status} order. Create a new order instead.`
        );
      }
      const { items, total } = await buildOrderItems(rawItems, session);
      found.items = items;
      found.total = total;
    }

    // --- Status transitions --------------------------------------------------
    if (status !== undefined && status !== found.status) {
      const from = found.status;

      if (from === ORDER_STATUS.CANCELLED) {
        throw ApiError.badRequest('A cancelled order cannot be reopened');
      }

      if (status === ORDER_STATUS.COMPLETED) {
        // completedAt is the guard: if it is already set, the stock for this
        // order has been taken once and must not be taken again.
        if (!found.completedAt) {
          await decrementStock(found.items, session);
          found.completedAt = new Date();
        }
        found.status = ORDER_STATUS.COMPLETED;
      } else if (status === ORDER_STATUS.CANCELLED) {
        // Only give stock back if it was actually taken.
        if (found.completedAt) {
          await restoreStock(found.items, session);
          found.completedAt = null;
        }
        found.status = ORDER_STATUS.CANCELLED;
      } else if (status === ORDER_STATUS.PENDING) {
        throw ApiError.badRequest(`An order cannot move from ${from} back to pending`);
      } else {
        throw ApiError.badRequest(`Unknown order status: ${status}`);
      }
    }

    await found.save({ session });
    return found;
  });

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
  /*
   * Also transactional: restoring the stock and removing the order are one
   * change. Restoring stock and then failing to delete would credit inventory
   * for an order that still exists and can be cancelled again — inventing units
   * out of nothing.
   */
  await withTransaction(async (session) => {
    // Populated for the same reason as in updateOrder — see the note there.
    const order = await Order.findById(req.params.id).populate('customer').session(session);
    if (!order) throw ApiError.notFound('Order not found');

    if (!canAccessOrderDocument(req.user, order)) {
      throw ApiError.forbidden('You do not have access to this order');
    }

    if (order.completedAt) await restoreStock(order.items, session);

    await order.deleteOne({ session });
  });

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
