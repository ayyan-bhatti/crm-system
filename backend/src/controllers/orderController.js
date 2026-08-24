const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { ORDER_STATUS, USER_STATUS } = require('../config/constants');
const {
  hasFullRecordAccess,
  canAccessCustomer,
  canWriteOrders,
  isAdmin,
} = require('../middleware/roles');
const changeRequestService = require('../services/changeRequestService');
const {
  getPagination,
  getSort,
  paginatedResponse,
  getDateRange,
  applyCursor,
  cursorResponse,
} = require('../utils/queryHelpers');
const { withTransaction } = require('../utils/transaction');
const { recordAudit } = require('../services/auditService');
const { nextOrderNumber, parseOrderNumber } = require('../services/orderNumber');

const SORTABLE_FIELDS = ['total', 'status', 'createdAt'];

/**
 * What of the customer travels with an order.
 *
 * Includes `phone` and `address`, which is the ONLY route by which a sales rep
 * sees customer contact details — they have no access to the customer book. A
 * rep holding an order has to be able to ring the customer and deliver to
 * them; withholding that would leave them able to see the work and unable to
 * do it.
 *
 * Deliberately narrow all the same: no notes, no owner, no status history. One
 * customer, reachable only through an order assigned to the person asking.
 */
const CUSTOMER_FIELDS_ON_ORDER = 'name email company city status phone address';

/*
 * A value no order number can hold, used when `?search=` is not an order
 * number at all. Matching nothing is the honest answer to a search for
 * something that cannot exist; ignoring the parameter and returning every
 * order would look like the search silently failed.
 */
const NO_SUCH_ORDER_NUMBER = '__no_such_order__';

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
 *
 * WHAT THE STOCK CHECK IN HERE IS AND IS NOT
 *
 * It reads `stockQty` and compares. That is a read-then-write check, and on its
 * own it is unsafe: between this read and the decrement, another request can
 * take the stock, and both callers would believe they had it.
 *
 * It is kept anyway, because it is the only place that can produce a *useful*
 * error — it knows the product's name, SKU, how many were asked for and how
 * many exist ("Insufficient stock for Blue Widget (SKU-12): requested 5,
 * available 2"). The atomic decrement can only report that it matched nothing.
 *
 * So the division of labour is deliberate:
 *
 *   this check          fast, friendly, advisory. Catches the overwhelmingly
 *                       common case — a genuinely impossible order — and
 *                       explains it well.
 *   decrementStock      the actual guarantee. A conditional update that cannot
 *                       be raced. Correctness lives there and only there.
 *
 * For a *pending* order this check is the only stock validation that runs at
 * all, and that is correct: a pending order reserves nothing, so its check is
 * inherently advisory — the stock is verified again, atomically, on completion.
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

    // Advisory — see the note above. decrementStock is what actually enforces it.
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

  /*
   * A sales rep gets exactly the orders ASSIGNED to them, and nothing else.
   *
   * This replaced a three-branch rule — orders they created, OR orders for a
   * customer they owned, OR orders explicitly assigned. Both of the first two
   * are now impossible: a rep cannot create an order, and has no customers.
   * Leaving them in would be dead branches that still cost an index lookup and
   * still had to be reasoned about every time this was read.
   *
   * One fact, one branch. Assignment is the whole of a rep's world.
   */
  return { assignedTo: user._id };
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
  const { status, customer, from, to, search } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const filter = { ...(await orderScopeFilter(req.user)) };

  if (status) filter.status = status;
  if (customer) filter.customer = customer;

  /*
   * `?search=` looks the order up by its human-readable number, which is the
   * entire point of having one — somebody quotes ORD-000142 and you need to
   * find it.
   *
   * An exact match on the normalised form rather than a partial one. A prefix
   * search over a padded sequence is close to useless ("ORD-0001" matches ten
   * thousand orders), and `parseOrderNumber` is already forgiving about how the
   * number is typed: `142`, `ord-142` and `ORD-000142` all arrive here as the
   * same string. If it does not look like an order number at all, the filter is
   * one nothing matches — an empty result is the honest answer to a search for
   * something that cannot exist, and is much clearer than silently ignoring the
   * parameter and returning every order.
   */
  if (search !== undefined && String(search).trim() !== '') {
    filter.orderNumber = parseOrderNumber(search) ?? NO_SUCH_ORDER_NUMBER;
  }

  const createdAt = getDateRange(from, to);
  if (createdAt) filter.createdAt = createdAt;

  const sort = getSort(req.query, SORTABLE_FIELDS);

  const withRelations = (query) =>
    query
      .populate('customer', CUSTOMER_FIELDS_ON_ORDER)
      .populate('createdBy', 'name email role')
      .populate('assignedTo', 'name email role')
      .populate('items.product', 'name sku price');

  /*
   * Two paging modes on one endpoint, chosen by whether `?cursor=` is present.
   * See the trade-off note in utils/queryHelpers.js.
   */
  if (req.query.cursor !== undefined) {
    const data = await withRelations(
      Order.find(applyCursor(filter, req.query.cursor, sort))
    )
      .sort(sort)
      .limit(limit + 1);

    return res.json(cursorResponse({ data, limit, sort }));
  }

  const [data, total] = await Promise.all([
    withRelations(Order.find(filter)).sort(sort).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);

  return res.json(paginatedResponse({ data, total, page, limit }));
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

  /*
   * A MANAGER'S ORDER WAITS FOR AN ADMIN.
   *
   * The customer is checked first even though nothing is being written yet:
   * queueing a request against a customer that does not exist, or that the
   * proposer cannot see, would put a request in the admin's queue that can only
   * ever be rejected. Better to refuse it at the point somebody can still fix
   * the input.
   *
   * Stock is deliberately NOT touched or reserved here. Nothing moves until an
   * order exists, and no order exists until approval — so two pending requests
   * for the last item in stock both queue happily, and whichever is approved
   * second fails the atomic decrement on completion. That is the same guard
   * that already protects two people completing two orders at once, so there is
   * no new race to reason about.
   */
  if (!canWriteOrders(req.user) || !isAdmin(req.user)) {
    const customer = await Customer.findById(customerId);
    if (!customer) throw ApiError.notFound('Customer not found');

    const request = await changeRequestService.submit(
      {
        entity: 'order',
        action: 'create',
        payload: {
          customer: customerId,
          items: rawItems,
          status: status || ORDER_STATUS.PENDING,
          createdBy: req.user._id,
        },
        label: `New order for ${customer.name}`,
      },
      req.user
    );

    return res.status(202).json({
      success: true,
      message: 'Sent to an administrator for approval. The order is not placed yet.',
      data: request,
    });
  }

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
  const order = await withTransaction((session) =>
    placeOrder(
      { customerId, rawItems, status, actorId: req.user._id, actor: req.user },
      session
    )
  );

  /*
   * Audited AFTER the transaction commits, not inside it.
   *
   * Inside, a rollback would erase the audit entry along with the order — which
   * is the correct outcome for a failed write (nothing happened, so nothing
   * should be logged) but means the audit write can also cause a write conflict
   * and retry the whole order. Outside, the trail records what actually
   * happened, which is what it is for.
   */
  await recordAudit(req, {
    action: 'create',
    entity: 'order',
    entityId: order._id,
    label: `Order ${order._id}`,
    after: order,
  });

  await order.populate([
    { path: 'customer', select: CUSTOMER_FIELDS_ON_ORDER },
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
  const { order, before: auditBefore } = await withTransaction(async (session) => {
    // The customer is populated because the ownership check may need to read
    // its `assignedTo` — a sales rep can edit an order they did not create if
    // it belongs to a customer assigned to them.
    const found = await Order.findById(req.params.id).populate('customer').session(session);
    if (!found) throw ApiError.notFound('Order not found');

    if (!canAccessOrderDocument(req.user, found)) {
      throw ApiError.forbidden('You do not have access to this order');
    }

    // Snapshotted before the status transition, so the trail shows what the
    // order moved FROM — the part a reviewer actually needs.
    const before = found.toObject({ depopulate: true });

    /*
     * A SALES REP MAY MOVE AN ORDER, NOT REWRITE IT.
     *
     * Completing or cancelling is the step the assignment exists to let them
     * take. Changing what was sold is a different act — it alters the price and
     * the stock that will move — and it belongs to whoever agreed the deal.
     *
     * Refused explicitly rather than by silently dropping `items`: a rep who
     * edited quantities and got a 200 back would reasonably believe it had
     * worked, and would find out otherwise from the customer.
     */
    if (rawItems !== undefined && !canWriteOrders(req.user)) {
      throw ApiError.forbidden(
        'You can complete or cancel an order assigned to you, but not change what is on it. ' +
          'Ask a manager to amend the items.'
      );
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
    return { order: found, before };
  });

  await recordAudit(req, {
    action: 'update',
    entity: 'order',
    entityId: order._id,
    label: `Order ${order._id}`,
    before: auditBefore,
    after: order,
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
  const deleted = await withTransaction(async (session) => {
    // Populated for the same reason as in updateOrder — see the note there.
    const order = await Order.findById(req.params.id).populate('customer').session(session);
    if (!order) throw ApiError.notFound('Order not found');

    if (!canAccessOrderDocument(req.user, order)) {
      throw ApiError.forbidden('You do not have access to this order');
    }

    if (order.completedAt) await restoreStock(order.items, session);

    const before = order.toObject({ depopulate: true });
    await order.deleteOne({ session });
    return before;
  });

  await recordAudit(req, {
    action: 'delete',
    entity: 'order',
    entityId: deleted._id,
    label: `Order ${deleted._id}`,
    before: deleted,
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

  const idOf = (value) => (value && typeof value === 'object' ? value._id : value);

  /*
   * An explicit assignment decides the question on its own, in both
   * directions. This mirrors `orderScopeFilter` exactly, and the two MUST agree
   * — if the list showed an order the detail endpoint then refused, a rep
   * would see a row they could not open, which is a worse experience than
   * either rule alone.
   */
  const assignedTo = idOf(order.assignedTo);

  if (assignedTo) return String(assignedTo) === String(user._id);

  // Unassigned: fall back to the inherited rule.
  const createdBy = idOf(order.createdBy);
  if (createdBy && String(createdBy) === String(user._id)) return true;

  // When the customer is populated we can check assignment directly.
  const customer = order.customer;
  if (customer && customer.assignedTo !== undefined) {
    return canAccessCustomer(user, customer);
  }

  return false;
}

/**
 * Write one order, priced and numbered, inside a caller-supplied transaction.
 *
 * WHY THIS IS A FUNCTION AND NOT JUST THE BODY OF createOrder.
 *
 * Two paths produce an order: a direct creation by an admin, and a manager's
 * proposal being approved. They must produce the SAME thing — same pricing,
 * same atomic number, same stock behaviour — and the way to guarantee that is
 * for there to be one definition of it. The first attempt at the approval path
 * inserted the proposed payload directly and got a 400 from the schema, because
 * a proposal holds `{ product, quantity }` and an order needs each line priced
 * at the price of the day and a total computed from those lines.
 *
 * `actor` is optional and only used for the access check. The approval path
 * passes none, because the check was already made when the request was accepted
 * and the approver is an admin who can reach every customer anyway.
 *
 * The session is REQUIRED rather than defaulted. Every step here — pricing,
 * numbering, writing, moving stock — has to be in one transaction or the
 * guarantees are decoration; making the caller supply it means they cannot
 * forget to open one.
 */
async function placeOrder({ customerId, rawItems, status, actorId, actor = null }, session) {
  const customer = await Customer.findById(customerId).session(session);
  if (!customer) throw ApiError.notFound('Customer not found');

  if (actor && !canAccessCustomer(actor, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  const completing = status === ORDER_STATUS.COMPLETED;

  const { items, total } = await buildOrderItems(rawItems, session);

  /*
   * The human-readable number, allocated atomically.
   *
   * Inside the transaction, so an order that is never written does not burn a
   * number — an abort rolls the counter back with everything else, and the
   * sequence stays dense.
   *
   * Deliberately NOT `countDocuments() + 1`: two orders created in the same
   * moment would both read the same count and both claim the same number. See
   * models/Counter.js — it is the same shape of race as the stock decrement
   * below, and it is closed the same way, by making the read and the write a
   * single operation.
   */
  const orderNumber = await nextOrderNumber(session);

  // Order.create with a session takes an array — the single-document form does
  // not accept options.
  const [created] = await Order.create(
    [
      {
        orderNumber,
        customer: customer._id,
        items,
        total,
        status: completing ? ORDER_STATUS.COMPLETED : ORDER_STATUS.PENDING,
        completedAt: completing ? new Date() : null,
        createdBy: actorId,
        /*
         * Left null on creation: null means "follows the customer", which is
         * what an order should do unless somebody says otherwise. Writing the
         * creator here instead would freeze an assignment nobody asked for onto
         * every order, and make moving a customer stop moving their orders.
         */
        assignedTo: null,
      },
    ],
    { session }
  );

  // Stock moves last. If it fails, throwing here aborts the transaction and the
  // order above is never written — no compensation to remember.
  if (completing) await decrementStock(items, session);

  return created;
}

/**
 * PATCH /api/orders/:id/assign — manager and admin only.
 *
 * Body: { "assignedTo": "<user id>" } or { "assignedTo": null } to clear it.
 *
 * A SEPARATE ENDPOINT FROM PATCH /api/orders/:id, DELIBERATELY.
 *
 * Reassignment is a different KIND of change from editing an order. Editing
 * alters what was sold; reassigning alters who is accountable for it, which is
 * attached to commission and to who gets the call when something goes wrong.
 * The two also have different permissions — a rep may edit their own order and
 * may not hand it to someone else, and expressing that inside one handler means
 * a field-by-field permission check, which is where this kind of rule goes
 * wrong quietly.
 *
 * It also keeps the audit trail legible: "assigned: Ayesha -> Bilal" rather
 * than a general update that happens to contain an id.
 *
 * Clearing the assignment (null) is a real operation, not a mistake to guard
 * against: it returns the order to following its customer, which is the right
 * move once a temporary hand-off is over.
 */
const assignOrder = asyncHandler(async (req, res) => {
  const { assignedTo } = req.body;

  if (assignedTo !== null && !mongoose.isValidObjectId(assignedTo)) {
    throw ApiError.badRequest('assignedTo must be a user id, or null to clear the assignment');
  }

  const order = await Order.findById(req.params.id).populate('customer');
  if (!order) throw ApiError.notFound('Order not found');

  let assignee = null;

  if (assignedTo !== null) {
    assignee = await User.findById(assignedTo);
    if (!assignee) throw ApiError.badRequest('That user does not exist');

    /*
     * A deactivated account must not be handed work. It cannot sign in, so the
     * order would land in a list nobody opens — which looks exactly like the
     * order being handled and is the opposite.
     */
    if (assignee.status !== USER_STATUS.ACTIVE) {
      throw ApiError.badRequest('That account is not active, so it cannot be assigned work');
    }
  }

  // Captured before the write, so the audit entry can name both ends.
  const before = order.toObject({ depopulate: true });
  const previous = order.assignedTo;

  order.assignedTo = assignedTo;
  await order.save();

  await order.populate('assignedTo', 'name email role');

  /*
   * Audited with both names rather than both ids. "assigned: Ayesha -> Bilal"
   * is readable a year later; two ObjectIds require two lookups against a users
   * collection that may no longer contain either of them.
   */
  const previousUser = previous ? await User.findById(previous).select('name') : null;

  await recordAudit(req, {
    action: 'update',
    entity: 'order',
    entityId: order._id,
    label: order.orderNumber || String(order._id),
    before,
    after: order.toObject({ depopulate: true }),
    note: `assigned: ${previousUser?.name || 'follows customer'} → ${
      assignee?.name || 'follows customer'
    }`,
  });

  res.json({ success: true, data: order });
});

module.exports = {
  listOrders,
  placeOrder,
  getOrder,
  createOrder,
  updateOrder,
  assignOrder,
  deleteOrder,
  orderScopeFilter,
};
