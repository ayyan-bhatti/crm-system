const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const {
  ORDER_STATUS,
  USER_STATUS,
  FULFILMENT_STATUS,
  FULFILMENT_SEQUENCE,
  FULFILMENT_LABELS,
  DELIVERY_SPEED,
  estimatedDeliveryFor,
  COURIER_VALUES,
  COURIER_LABELS,
} = require('../config/constants');
const courierService = require('../services/courierService');
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
const { refundOrderIfPaid } = require('../services/refundService');

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
 * WHAT AN ORDER LOOKS LIKE WHEN IT LEAVES THE API. ONE SPEC, USED EVERYWHERE.
 *
 * This was four hand-written populate lists that had drifted apart, and the
 * drift was visible on screen: the detail response never populated
 * `assignedTo`, so `order.assignedTo` arrived as a bare id. The assignment
 * panel then took its "somebody holds this" branch — an id is truthy — and
 * rendered `assignedTo.name`, which is `undefined`. The result was a heading
 * reading "ASSIGNED TO" above nothing at all, on the one screen whose job is
 * to say who has the order. The list endpoint had always populated it, so the
 * name showed in the table and vanished when you clicked the row.
 *
 * The edit form had the same fault from the same cause: it seeds its assignee
 * picker from the detail response, so the picker opened blank on an order that
 * was in fact assigned.
 *
 * Naming the shape once is the actual fix. Four copies of a projection are
 * four chances to forget one, and forgetting one fails silently — a missing
 * populate is not an error, it is a field that renders as nothing.
 *
 * NO EMAIL ON THE PEOPLE.
 *
 * `name` and `role` are what the screens display; nothing reads an address off
 * an order. Handing one out anyway would reintroduce, one record at a time,
 * exactly what narrowing /users/assignable fixed — a sales rep collecting
 * colleagues' email addresses from records they are entitled to open. See
 * ROLE_AUDIT.md, F1.
 */
const ORDER_POPULATE = [
  { path: 'customer', select: CUSTOMER_FIELDS_ON_ORDER },
  { path: 'createdBy', select: 'name role' },
  { path: 'assignedTo', select: 'name role' },
  /*
   * `stockQty` is load-bearing, not padding. The edit form warns you as you
   * type that a line exceeds stock, and it reads that number off the order's
   * own populated items. Only the detail response used to carry it, so
   * unifying on the shorter list would have turned that warning off silently
   * — the server still refuses to oversell, but you would find out on submit
   * instead of while typing. Exactly the class of quiet breakage this shared
   * spec exists to stop, met while writing it.
   */
  { path: 'items.product', select: 'name sku price stockQty' },
];

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

  /*
   * Merge duplicate lines first. Otherwise two lines of 6 against a stock of 10
   * would each pass the check individually and oversell.
   *
   * THE KEY IS PRODUCT **AND** VARIANT, which is the whole change here. Keying
   * on the product alone would merge a medium blue and a large red into one
   * line of two, check that combined quantity against one of the two variants'
   * stock, and write a single line that has lost half of what was ordered. Two
   * colours of the same shirt are two independent things to count.
   */
  const merged = new Map();
  for (const line of rawItems) {
    const productId = line.product;
    const quantity = Number(line.quantity);
    const variantId = line.variantId || line.variant?.variantId || null;

    if (!mongoose.isValidObjectId(productId)) {
      throw ApiError.badRequest(`Invalid product id: ${productId}`);
    }
    if (variantId && !mongoose.isValidObjectId(variantId)) {
      throw ApiError.badRequest(`Invalid variant id: ${variantId}`);
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw ApiError.badRequest('Each item needs an integer quantity of at least 1');
    }

    const key = `${productId}::${variantId || ''}`;
    const existing = merged.get(key);

    if (existing) {
      existing.quantity += quantity;
    } else {
      merged.set(key, { productId: String(productId), variantId, quantity });
    }
  }

  const lines = [...merged.values()];
  const productIds = [...new Set(lines.map((line) => line.productId))];
  const products = await Product.find({ _id: { $in: productIds } }).session(session);

  if (products.length !== productIds.length) {
    const found = new Set(products.map((p) => String(p._id)));
    const missing = productIds.filter((id) => !found.has(id));
    throw ApiError.badRequest(`Unknown product id(s): ${missing.join(', ')}`);
  }

  const byId = new Map(products.map((p) => [String(p._id), p]));

  const items = [];
  let total = 0;

  for (const line of lines) {
    const product = byId.get(line.productId);
    const hasVariants = product.variants && product.variants.length > 0;

    /*
     * A PRODUCT WITH VARIANTS CANNOT BE ORDERED WITHOUT NAMING ONE.
     *
     * Refused loudly rather than defaulted to the first variant. "Defaulting"
     * here would mean silently choosing a colour on the customer's behalf and
     * shipping it — a mistake that is only discovered when the parcel is
     * opened, by which point it has cost a return. The storefront disables
     * Add to Cart until a variant is chosen; this is the server-side half of
     * the same rule, for anything that reaches the API another way.
     */
    if (hasVariants && !line.variantId) {
      throw ApiError.badRequest(
        `"${product.name}" is sold in specific colours — choose one before ordering.`
      );
    }

    /*
     * The converse, and it matters just as much: a variant id against a product
     * that has none means the caller and the catalogue disagree about what is
     * being sold. Accepting it would write a snapshot referring to a variant
     * that does not exist.
     */
    if (!hasVariants && line.variantId) {
      throw ApiError.badRequest(`"${product.name}" is not sold in variants.`);
    }

    const variant = hasVariants ? product.variants.id(line.variantId) : null;

    if (hasVariants && !variant) {
      throw ApiError.badRequest(`That colour is no longer available for "${product.name}".`);
    }

    // The price of the variant if it overrides, else the product's own.
    const price = variant?.priceOverride ?? product.price;
    const available = variant ? variant.stockQty : product.stockQty;
    const describe = variant
      ? `"${product.name}" (${[variant.color.name, variant.size].filter(Boolean).join(' / ')})`
      : `"${product.name}" (${product.sku})`;

    // Advisory — see the note above. decrementStock is what actually enforces it.
    if (line.quantity > available) {
      throw ApiError.badRequest(
        `Insufficient stock for ${describe}: requested ${line.quantity}, available ${available}`
      );
    }

    items.push({
      product: product._id,
      quantity: line.quantity,
      priceAtOrder: price,
      variant: variant
        ? {
            variantId: variant._id,
            colorName: variant.color.name,
            colorHex: variant.color.hex,
            size: variant.size || '',
          }
        : null,
    });

    total += line.quantity * price;
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
    const variantId = item.variant?.variantId || null;

    /*
     * TWO SHAPES OF THE SAME ATOMIC GUARANTEE.
     *
     * For a plain product it is the original: match only if the document still
     * has enough, and decrement in the same operation.
     *
     * For a variant it is `$elemMatch` plus the positional `$`. The filter says
     * "this product, AND it contains an array element with this id that has at
     * least this much stock"; `variants.$` then addresses precisely the element
     * that matched. Both halves are needed and the reason is easy to get wrong:
     * writing `{ 'variants._id': v, 'variants.stockQty': { $gte: q } }` would
     * match a product where ONE variant has the id and a DIFFERENT variant has
     * the stock — Mongo evaluates dotted conditions independently across the
     * array unless they are wrapped in `$elemMatch`. That version passes every
     * single-variant test and oversells the moment a product has two colours.
     *
     * The parent `stockQty` is decremented in the SAME update, which is what
     * keeps the denormalised total (see the pre-save hook on Product) honest
     * without a second, raceable write.
     */
    const filter = variantId
      ? {
          _id: item.product,
          variants: { $elemMatch: { _id: variantId, stockQty: { $gte: item.quantity } } },
        }
      : { _id: item.product, stockQty: { $gte: item.quantity } };

    const update = variantId
      ? { $inc: { 'variants.$.stockQty': -item.quantity, stockQty: -item.quantity } }
      : { $inc: { stockQty: -item.quantity } };

    const result = await Product.updateOne(filter, update, { session });

    if (result.modifiedCount !== 1) {
      // Without a transaction, put back whatever we already took. With one, the
      // abort does it — and doing both would double-credit the stock.
      if (!session) await restoreStock(applied, null);

      const product = await Product.findById(item.product).session(session);
      const label = product ? product.name : item.product;
      const variantLabel = item.variant?.colorName
        ? ` (${[item.variant.colorName, item.variant.size].filter(Boolean).join(' / ')})`
        : '';

      throw ApiError.badRequest(
        `Insufficient stock to complete this order for "${label}"${variantLabel}`
      );
    }

    applied.push(item);
  }
}

/** Add stock back — used when cancelling an order whose stock was taken, and on rollback. */
async function restoreStock(items, session = null) {
  for (const item of items) {
    const variantId = item.variant?.variantId || null;

    if (variantId) {
      /*
       * Restoring a variant is NOT symmetrical with taking it, and the
       * asymmetry is deliberate. There is no `$gte` guard because putting stock
       * back cannot oversell — but there IS a real possibility the variant has
       * since been deleted from the product, in which case `variants.$` matches
       * nothing and the update is a silent no-op.
       *
       * The parent total is therefore restored by a SEPARATE update that always
       * matches, so a cancelled order for a discontinued colour still credits
       * the product's headline stock rather than quietly losing the units. The
       * two writes are in the caller's transaction, so they land together.
       */
      await Product.updateOne(
        { _id: item.product, 'variants._id': variantId },
        { $inc: { 'variants.$.stockQty': item.quantity } },
        { session }
      );
      await Product.updateOne(
        { _id: item.product },
        { $inc: { stockQty: item.quantity } },
        { session }
      );
      continue;
    }

    await Product.updateOne(
      { _id: item.product },
      { $inc: { stockQty: item.quantity } },
      { session }
    );
  }
}

/**
 * Have this order's units actually left inventory?
 *
 * READS TWO FIELDS BECAUSE THE DATABASE HOLDS TWO GENERATIONS OF ORDER.
 *
 * `stockTakenAt` is the real answer and is set by everything written since card
 * payment arrived. Orders that predate it have it null while genuinely having
 * had their stock taken — for those, a set `completedAt` is the proof, because
 * under the old rules completion was the only thing that ever moved stock.
 *
 * Consulting both is what let this change ship without a data migration. See
 * the long note on `stockTakenAt` in models/Order.js.
 */
function stockIsTaken(order) {
  return Boolean(order.stockTakenAt || order.completedAt);
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
      .populate(ORDER_POPULATE);

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
  const order = await Order.findById(req.params.id).populate(ORDER_POPULATE);

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
  const { customer: customerId, items: rawItems, status, assignedTo } = req.body;

  if (!customerId) throw ApiError.badRequest('An order must reference a customer');

  if (status && ![ORDER_STATUS.PENDING, ORDER_STATUS.COMPLETED].includes(status)) {
    throw ApiError.badRequest('A new order must be created as pending or completed');
  }

  /*
   * WHO IS GOING TO WORK THIS ORDER, ASKED AT THE MOMENT IT IS PLACED.
   *
   * Optional, and that is deliberate. Requiring it would mean a manager taking
   * an order over the phone cannot record it until they have decided who works
   * it — so the order does not get written down, which is worse than it being
   * briefly unowned. Blank means nobody holds it yet and no rep sees it.
   *
   * Validated here rather than left to the schema so the failure names the
   * problem: "that account is not active" is actionable, where a cast error is
   * not.
   */
  const assignee = await resolveAssignee(assignedTo);

  /*
   * A manager places orders DIRECTLY.
   *
   * This used to queue for an admin, and it was the wrong call: it put the
   * approver in the critical path of SELLING, so nothing a manager agreed
   * became real — and no rep could start work — until somebody else acted.
   * Deciding what is sold and who works it is the manager's job.
   *
   * What still needs approval is changing or destroying a record after the
   * fact: editing the items, deleting the order, and any change to a customer.
   * Those are edits to the data the admin owns, and they are not on anybody's
   * critical path.
   */

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
      {
        customerId,
        rawItems,
        status,
        assignedTo: assignee?._id ?? null,
        actorId: req.user._id,
        actor: req.user,
      },
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

  await order.populate(ORDER_POPULATE);

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
/**
 * Thrown to abort the update transaction when a manager's item edit needs
 * approving instead of applying.
 *
 * A sentinel rather than a flag checked afterwards, because the decision is
 * made deep inside the transaction callback and the transaction must NOT
 * commit. Throwing is how you abort one; catching it outside is where the
 * change request can safely be written.
 */
class PendingItemEdit extends Error {
  constructor(order, items) {
    super('This edit needs approval');
    this.order = order;
    this.items = items;
  }
}

const updateOrder = asyncHandler(async (req, res) => {
  const { status, items: rawItems } = req.body;

  /*
   * A CANCELLATION REFUNDS BEFORE IT DOES ANYTHING ELSE.
   *
   * This block costs one extra read of the order, and buys the ordering
   * guarantee described in services/refundService.js: money goes back before
   * stock does, and the Stripe call happens outside the transaction so an
   * automatic write-conflict retry cannot issue a second refund.
   *
   * The access check is repeated here rather than deferred to the transaction
   * below, and that repetition is the point — without it, this endpoint would
   * issue a real refund on somebody else's order and only then discover the
   * caller was not allowed to touch it. The check inside the transaction
   * remains the authoritative one; this is the one that has to happen before
   * money moves.
   */
  if (status === ORDER_STATUS.CANCELLED) {
    const existing = await Order.findById(req.params.id).populate('customer');
    if (!existing) throw ApiError.notFound('Order not found');

    if (!canAccessOrderDocument(req.user, existing)) {
      throw ApiError.forbidden('You do not have access to this order');
    }

    // Re-cancelling an already-cancelled order must not refund again. Stripe's
    // idempotency key would catch it anyway; not asking is better than relying
    // on being told no.
    if (existing.status !== ORDER_STATUS.CANCELLED) {
      await refundOrderIfPaid(existing);
    }
  }

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
  let transaction;

  try {
    transaction = await withTransaction(async (session) => {
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

    /*
     * A MANAGER MAY PLACE AN ORDER BUT NOT REWRITE ONE.
     *
     * Placing is selling and goes through directly — keeping the approver out
     * of that path is the whole point. Editing the lines afterwards is a change
     * to a record that already exists and that somebody may have acted on: the
     * price changes, the stock that will move changes, and if it has been
     * completed the ledger has already recorded the old figures.
     *
     * Thrown from inside the transaction so nothing is half-applied. The
     * request is submitted after it aborts, in the catch below — submitting
     * here would write the change request inside a transaction that is about to
     * roll back, which would lose it.
     */
    if (rawItems !== undefined && !isAdmin(req.user)) {
      throw new PendingItemEdit(found, rawItems);
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
        /*
         * `stockIsTaken` is the guard, and it is now a genuinely different
         * question from "is this completed". A card-paid storefront order has
         * had its stock taken at the moment of payment while still sitting
         * here as `pending`; completing it must stamp the completion WITHOUT
         * decrementing a second time for the same units.
         */
        if (!stockIsTaken(found)) {
          await decrementStock(found.items, session);
          found.stockTakenAt = new Date();
        }
        found.completedAt = found.completedAt || new Date();
        found.status = ORDER_STATUS.COMPLETED;
      } else if (status === ORDER_STATUS.CANCELLED) {
        // Only give stock back if it was actually taken — which, again, is no
        // longer the same thing as "was completed".
        if (stockIsTaken(found)) {
          await restoreStock(found.items, session);
          found.stockTakenAt = null;
          found.completedAt = null;
        }
        found.status = ORDER_STATUS.CANCELLED;
        /*
         * A cancelled order has no delivery state. Leaving `fulfilment` at
         * whatever it was would show the buyer a timeline still marching
         * towards their door under a heading that says the order is cancelled.
         */
        found.fulfilment = FULFILMENT_STATUS.CANCELLED;
      } else if (status === ORDER_STATUS.PENDING) {
        throw ApiError.badRequest(`An order cannot move from ${from} back to pending`);
      } else {
        throw ApiError.badRequest(`Unknown order status: ${status}`);
      }
    }

      await found.save({ session });
      return { order: found, before };
    });
  } catch (err) {
    if (!(err instanceof PendingItemEdit)) throw err;

    const request = await changeRequestService.submit(
      {
        entity: 'order',
        entityId: err.order._id,
        action: 'update',
        payload: { items: err.items },
        label: err.order.orderNumber || String(err.order._id),
      },
      req.user
    );

    return res.status(202).json({
      success: true,
      message: 'Sent to an administrator for approval. The order has not been changed.',
      data: request,
    });
  }

  const { order, before: auditBefore } = transaction;

  await recordAudit(req, {
    action: 'update',
    entity: 'order',
    entityId: order._id,
    label: `Order ${order._id}`,
    before: auditBefore,
    after: order,
  });

  await order.populate(ORDER_POPULATE);

  res.json({ success: true, data: order });
});

/**
 * DELETE /api/orders/:id
 *
 * Deleting a completed order restores its stock, so the numbers stay honest.
 */
const deleteOrder = asyncHandler(async (req, res) => {
  /*
   * DELETING AN ORDER IS THE ADMIN'S ALONE.
   *
   * It is the most destructive act available here and the least reversible: on
   * a completed order it restores stock, so the inventory ledger is rewritten
   * along with the record, and there is no undo. A manager may ask for it; only
   * the admin does it.
   *
   * Note this is checked BEFORE the transaction. The order is loaded twice on
   * the manager path as a result, which is the right trade — the alternative is
   * writing a change request from inside a transaction that then has to abort.
   */
  if (!isAdmin(req.user)) {
    const order = await Order.findById(req.params.id);
    if (!order) throw ApiError.notFound('Order not found');

    const request = await changeRequestService.submit(
      {
        entity: 'order',
        entityId: order._id,
        action: 'delete',
        label: order.orderNumber || String(order._id),
      },
      req.user
    );

    return res.status(202).json({
      success: true,
      message: 'Sent to an administrator for approval. The order has not been deleted.',
      data: request,
    });
  }

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

    if (stockIsTaken(order)) await restoreStock(order.items, session);

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
 * Turn an `assignedTo` value from a request body into a user, or null.
 *
 * Shared by order creation and reassignment, because "who may be given work"
 * has to mean the same thing in both places — and it did not, briefly: the
 * assign endpoint checked the account was active and creation would have
 * accepted anybody at all.
 *
 * Null and undefined both mean "nobody", which is a legitimate answer rather
 * than a missing one: an order can be placed before anyone has decided who
 * works it, and an assignment can be cleared.
 */
async function resolveAssignee(assignedTo) {
  if (assignedTo === undefined || assignedTo === null || assignedTo === '') return null;

  if (!mongoose.isValidObjectId(assignedTo)) {
    throw ApiError.badRequest('assignedTo must be a user id, or null for nobody');
  }

  const user = await User.findById(assignedTo);
  if (!user) throw ApiError.badRequest('That user does not exist');

  /*
   * A deactivated or unapproved account must not be handed work. It cannot sign
   * in, so the order would land in a list nobody opens — which looks exactly
   * like the order being handled, and is the opposite.
   */
  if (user.status !== USER_STATUS.ACTIVE) {
    throw ApiError.badRequest('That account is not active, so it cannot be assigned work');
  }

  return user;
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
async function placeOrder(
  {
    customerId,
    rawItems,
    status,
    assignedTo = null,
    actorId,
    actor = null,
    source = 'internal',
    buyerId = null,
    paymentMethod = null,
    payment = null,
    /**
     * Take the stock now even though the order is not being completed.
     *
     * Exists for exactly one caller: an order built from a Stripe webhook,
     * where the money is already gone and the inventory is therefore genuinely
     * committed, but nobody has picked or posted anything so `completed` would
     * be a lie. Defaults false, so every pre-existing caller behaves precisely
     * as it did.
     */
    takeStock = false,
    /** Pre-priced lines from a pending checkout — see the note below. */
    prebuiltItems = null,
    /** Standard unless the buyer paid for next-day. */
    deliverySpeed = DELIVERY_SPEED.STANDARD,
  },
  session
) {
  const customer = await Customer.findById(customerId).session(session);
  if (!customer) throw ApiError.notFound('Customer not found');

  if (actor && !canAccessCustomer(actor, customer)) {
    throw ApiError.forbidden('You do not have access to this customer');
  }

  const completing = status === ORDER_STATUS.COMPLETED;
  const shouldTakeStock = completing || takeStock;

  /*
   * A CARD-PAID ORDER IS PRICED AT WHAT WAS CHARGED, NOT AT TODAY'S PRICE.
   *
   * Every other path re-prices from the live catalogue, deliberately, so that a
   * request sitting in an approval queue over a price rise applies the new
   * price. A paid checkout is the one case where that is wrong: Stripe has
   * already taken a specific amount, and rebuilding the lines from current
   * prices would produce an order whose total disagrees with the money in the
   * account. The snapshot on the PendingCheckout is the authority, so it is
   * passed straight through.
   */
  const { items, total } = prebuiltItems
    ? prebuiltItems
    : await buildOrderItems(rawItems, session);

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
        // See `stockTakenAt` in models/Order.js: this and `completedAt` are now
        // separate facts, and a paid-but-unfulfilled order sets only this one.
        stockTakenAt: shouldTakeStock ? new Date() : null,
        ...(payment ? { payment } : {}),
        createdBy: actorId,
        /*
         * Whoever the person placing the order named, or nobody.
         *
         * Not defaulted to the creator: a manager placing an order is not
         * thereby working it, and writing themselves in would put every order
         * in a manager's rep-scoped list and mean nothing was ever visibly
         * unassigned. A storefront order starts unassigned for the same
         * reason a directly-placed one does — see the model comment.
         */
        assignedTo,
        source,
        buyerId,
        paymentMethod,
        deliverySpeed,
        /*
         * THE PROMISE IS MADE AT CHECKOUT, NOT WHEN SOMEBODY GETS ROUND TO IT.
         *
         * The estimate used to stay null until a staff member marked the order
         * shipped and typed a date. That is too late to be useful: a buyer
         * choosing between next-day and standard is choosing a DATE, and they
         * are choosing it before they pay. Leaving it blank meant the one
         * screen where the answer matters — the confirmation page — could only
         * say "we will let you know".
         *
         * Staff can still revise it when the parcel actually ships; this is the
         * promise, not a prediction nobody may correct.
         */
        estimatedDeliveryAt: estimatedDeliveryFor(deliverySpeed),
      },
    ],
    { session }
  );

  // Stock moves last. If it fails, throwing here aborts the transaction and the
  // order above is never written — no compensation to remember.
  if (shouldTakeStock) await decrementStock(items, session);

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

  await order.populate(ORDER_POPULATE);

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

/**
 * POST /api/orders/:id/transfer-request — the assigned sales rep.
 *
 * Body: { "assignedTo": "<user id>", "reason": "why" }
 *
 * THE ONE WAY A REP CAN MOVE WORK.
 *
 * A rep cannot reassign an order — letting them would let them push a difficult
 * account onto a colleague, which is a staffing decision somebody else should
 * be making. But they are the person who knows they are on leave next week, or
 * that the customer is two hours from them and forty minutes from Sara. So they
 * ask, and an admin decides.
 *
 * Deliberately NOT the same endpoint as `assignOrder` with a different
 * permission. The two produce the same write and mean different things: one is
 * a decision, the other is a request, and the response has to be able to say
 * "nothing has happened yet".
 */
const requestOrderTransfer = asyncHandler(async (req, res) => {
  const { assignedTo, reason } = req.body;

  const order = await Order.findById(req.params.id).populate('customer');
  if (!order) throw ApiError.notFound('Order not found');

  /*
   * Only the rep HOLDING the order may ask to hand it on. Anyone else asking is
   * asking about somebody else's work, and a manager or admin can simply do it.
   */
  if (!canAccessOrderDocument(req.user, order)) {
    throw ApiError.forbidden('You do not have access to this order');
  }

  const assignee = await resolveAssignee(assignedTo);

  if (!assignee) {
    throw ApiError.badRequest('Name the colleague you would like the order transferred to');
  }

  if (String(assignee._id) === String(req.user._id)) {
    throw ApiError.badRequest('That order is already assigned to you');
  }

  const request = await changeRequestService.submit(
    {
      entity: 'order',
      entityId: order._id,
      action: 'transfer',
      payload: { assignedTo: assignee._id, reason: String(reason || '').slice(0, 500) },
      label: order.orderNumber || String(order._id),
    },
    req.user
  );

  res.status(202).json({
    success: true,
    message: `Asked for this order to be transferred to ${assignee.name}. It stays with you until an administrator agrees.`,
    data: request,
  });
});

/**
 * PATCH /api/orders/:id/fulfilment — admin, manager, or the assigned rep.
 *
 * Body: { "fulfilment": "shipped", "estimatedDeliveryAt": "2026-09-04" }
 *
 * A SEPARATE ENDPOINT FROM PATCH /api/orders/:id, for the same reason
 * `assignOrder` is one: it is a different kind of change with a different
 * permission and a different audience. `status` decides whether a sale counts
 * and whether stock moves; this decides what the customer is told about a
 * parcel. Expressing both through one handler would mean a field-by-field
 * permission check inside a shared body — which is exactly where this class of
 * rule goes wrong quietly.
 *
 * WHO MAY DO IT, AND WHY IT INCLUDES A REP
 *
 * The rep holding an order is usually the person who physically knows it went
 * out. Withholding this from them would leave the one person with the fact
 * unable to record it, and would push every shipment update through a manager
 * who is repeating what they were told. `canAccessOrderDocument` already
 * encodes "admin and manager see everything, a rep sees what is assigned to
 * them", so it is reused rather than restated.
 */
const updateFulfilment = asyncHandler(async (req, res) => {
  const { fulfilment, estimatedDeliveryAt, courier, trackingNumber } = req.body;

  if (!FULFILMENT_SEQUENCE.includes(fulfilment)) {
    throw ApiError.badRequest(
      `Fulfilment status must be one of: ${FULFILMENT_SEQUENCE.join(', ')}`
    );
  }

  /*
   * `courier` is validated even though it is optional, for the same reason the
   * fulfilment value itself is: a typo in a hand-written request body should
   * fail loudly here rather than being stored and silently producing no
   * tracking link later.
   */
  if (courier !== undefined && courier !== null && courier !== '' && !COURIER_VALUES.includes(courier)) {
    throw ApiError.badRequest(`Courier must be one of: ${COURIER_VALUES.join(', ')}`);
  }

  const order = await Order.findById(req.params.id).populate('customer');
  if (!order) throw ApiError.notFound('Order not found');

  if (!canAccessOrderDocument(req.user, order)) {
    throw ApiError.forbidden('You do not have access to this order');
  }

  /*
   * A cancelled order has no delivery state to advance. Refused explicitly:
   * silently accepting it would let somebody mark a cancelled order "shipped",
   * and the buyer's tracking page would then contradict the cancellation email
   * they already had.
   */
  if (order.status === ORDER_STATUS.CANCELLED) {
    throw ApiError.badRequest('This order was cancelled, so it has no delivery status.');
  }

  const before = order.toObject({ depopulate: true });
  const from = order.fulfilment;

  /*
   * A DELIVERY ESTIMATE IS REQUIRED THE MOMENT SOMETHING SHIPS.
   *
   * This is the one field the customer will actually look for, and "shipped,
   * arriving at some point" is barely more informative than "processing". The
   * requirement is enforced here rather than only in the form so that it holds
   * for any caller — and it applies to `shipped` and everything after it, so an
   * order dragged straight to `out_for_delivery` cannot skip past the check.
   */
  const shippedOrLater =
    FULFILMENT_SEQUENCE.indexOf(fulfilment) >= FULFILMENT_SEQUENCE.indexOf(FULFILMENT_STATUS.SHIPPED);

  if (shippedOrLater) {
    const estimate = estimatedDeliveryAt || order.estimatedDeliveryAt;

    if (!estimate) {
      throw ApiError.badRequest(
        'Set an estimated delivery date before marking this order shipped — it is shown ' +
          'to the customer on their order tracking page.'
      );
    }

    const parsed = new Date(estimate);
    if (Number.isNaN(parsed.getTime())) {
      throw ApiError.badRequest('The estimated delivery date is not a valid date');
    }

    order.estimatedDeliveryAt = parsed;
  } else if (estimatedDeliveryAt) {
    // Accepted before shipment too — a rep who knows the date early may as well
    // record it — but never demanded.
    const parsed = new Date(estimatedDeliveryAt);
    if (Number.isNaN(parsed.getTime())) {
      throw ApiError.badRequest('The estimated delivery date is not a valid date');
    }
    order.estimatedDeliveryAt = parsed;
  }

  /*
   * Timestamps are stamped once and then left alone. Re-stamping `shippedAt`
   * because somebody corrected `out_for_delivery` back to `shipped` would
   * rewrite when the parcel actually left, which is the one thing the field is
   * for.
   */
  if (fulfilment === FULFILMENT_STATUS.SHIPPED && !order.shippedAt) {
    order.shippedAt = new Date();
  }
  if (fulfilment === FULFILMENT_STATUS.DELIVERED && !order.deliveredAt) {
    order.deliveredAt = new Date();
  }

  /*
   * A TRACKING NUMBER MEANS NOTHING WITHOUT KNOWING WHOSE FORMAT IT IS IN —
   * `buildTrackingUrl` and the live DHL lookup both branch on the courier, so a
   * number recorded with no courier at all (neither here nor already on the
   * order) is a number nobody can act on. Refused rather than silently stored.
   */
  if (trackingNumber !== undefined && trackingNumber !== null && trackingNumber !== '') {
    const resolvedCourier = courier || order.courier;
    if (!resolvedCourier) {
      throw ApiError.badRequest(
        'Set which courier this is with before recording a tracking number.'
      );
    }
  }

  if (courier !== undefined) order.courier = courier || null;
  if (trackingNumber !== undefined) order.trackingNumber = trackingNumber || null;

  order.fulfilment = fulfilment;
  await order.save();
  await order.populate(ORDER_POPULATE);

  /*
   * Audited with the words rather than the enum values, and naming both ends.
   * "delivery: Processing → Shipped" is readable by whoever opens the trail a
   * year later; `out_for_delivery` on its own is not even obviously a change.
   *
   * Moving BACKWARDS is permitted rather than refused, and the trail is why
   * that is safe: people mis-click, and an order wrongly marked delivered has
   * to be correctable by the person who did it rather than by a database
   * edit. Every correction is recorded with both ends, so a suspicious pattern
   * is visible.
   */
  const courierChanged = courier !== undefined && courier !== before.courier;
  const trackingChanged = trackingNumber !== undefined && trackingNumber !== before.trackingNumber;
  const courierNote = courierChanged || trackingChanged
    ? ` (courier: ${order.courier ? COURIER_LABELS[order.courier] : 'none'}${
        order.trackingNumber ? `, tracking ${order.trackingNumber}` : ''
      })`
    : '';

  await recordAudit(req, {
    action: 'update',
    entity: 'order',
    entityId: order._id,
    label: order.orderNumber || String(order._id),
    before,
    after: order.toObject({ depopulate: true }),
    note: `delivery: ${FULFILMENT_LABELS[from]} → ${FULFILMENT_LABELS[fulfilment]}${courierNote}`,
  });

  res.json({ success: true, data: order });
});

/**
 * GET /api/orders/:id/tracking — same access as updateFulfilment.
 *
 * Two facts, always both returned: the public tracking-page link (works for
 * every courier, needs no configuration) and, only for a `dhl` shipment with
 * DHL_TRACKING_API_KEY set, a live status pulled from DHL's own API. See the
 * long note at the top of services/courierService.js for why TCS and Leopards
 * stop at the link — neither has a self-serve API this app can call.
 */
const getOrderTracking = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw ApiError.notFound('Order not found');

  if (!canAccessOrderDocument(req.user, order)) {
    throw ApiError.forbidden('You do not have access to this order');
  }

  if (!order.courier || !order.trackingNumber) {
    return res.json({
      success: true,
      data: { trackingUrl: null, live: false, reason: 'No courier or tracking number recorded yet' },
    });
  }

  const trackingUrl = courierService.buildTrackingUrl(order.courier, order.trackingNumber);

  const live =
    order.courier === 'dhl'
      ? await courierService.checkDhlStatus(order.trackingNumber)
      : {
          live: false,
          reason: `Live status is only available for DHL — ${COURIER_LABELS[order.courier]} has no self-serve tracking API.`,
        };

  res.json({ success: true, data: { trackingUrl, ...live } });
});

/**
 * GET /api/orders/deliveries
 *
 * Every order still on its way, ordered by how much trouble it is in.
 *
 * WHY THIS IS NOT `GET /api/orders?sort=urgent`.
 *
 * The priority that matters here cannot be expressed as a sort on a stored
 * field. It is a comparison between two things — the promised date and today —
 * crossed with where the parcel actually is, and Mongo has no index for
 * "overdue". Bolting it onto the general list would mean either a `$expr` sort
 * that cannot use an index, or a stored `priority` column that is wrong the
 * moment the clock passes midnight and nothing writes to the order.
 *
 * So this endpoint answers one question — *what should someone deal with
 * next?* — over the ACTIVE set only, which is small enough to rank in memory.
 * Delivered and cancelled orders are excluded at the database, so the set is
 * bounded by what is genuinely in flight rather than by the size of the order
 * book.
 *
 * SCOPED, like every other order read. A sales rep sees the deliveries on
 * their own orders and nobody else's — `orderScopeFilter` is the same gate the
 * list uses, so this cannot become the one endpoint that leaks the book.
 */
const listDeliveries = asyncHandler(async (req, res) => {
  const filter = {
    ...(await orderScopeFilter(req.user)),
    fulfilment: { $nin: [FULFILMENT_STATUS.DELIVERED, FULFILMENT_STATUS.CANCELLED] },
    status: { $ne: ORDER_STATUS.CANCELLED },
  };

  /*
   * A hard ceiling rather than paging. A delivery board that runs to page four
   * has stopped being a board — if a shop ever has more than 200 parcels in
   * flight, this needs to become a filtered queue per rep, not a longer list,
   * and pretending otherwise with a paginator would hide that.
   */
  const orders = await Order.find(filter)
    .populate(ORDER_POPULATE)
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  /**
   * Lower sorts first. The ranking is deliberate and worth stating, because
   * "urgent" is not one thing:
   *
   *   0  overdue          a promise is already broken
   *   1  out for delivery with a courier today; any problem is happening NOW
   *   2  due today or tomorrow, express first
   *   3  everything else, soonest promise first
   *
   * `out_for_delivery` outranks "due tomorrow" on purpose. A parcel already
   * with a courier is the one where an intervention still changes the outcome
   * today; an order due tomorrow can be dealt with this afternoon.
   */
  const ranked = orders.map((order) => {
    const due = order.estimatedDeliveryAt ? new Date(order.estimatedDeliveryAt) : null;
    if (due) due.setHours(0, 0, 0, 0);

    const daysLeft = due ? Math.round((due - startOfToday) / 86400000) : null;
    const express = order.deliverySpeed === DELIVERY_SPEED.EXPRESS;

    let band = 3;
    if (daysLeft !== null && daysLeft < 0) band = 0;
    else if (order.fulfilment === FULFILMENT_STATUS.OUT_FOR_DELIVERY) band = 1;
    else if (daysLeft !== null && daysLeft <= 1) band = 2;

    return { order, band, daysLeft, express };
  });

  ranked.sort((a, b) => {
    if (a.band !== b.band) return a.band - b.band;
    // Express before standard within a band: it is the tighter promise.
    if (a.express !== b.express) return a.express ? -1 : 1;
    // Then soonest promised date; orders with no date sort last.
    if (a.daysLeft === null) return 1;
    if (b.daysLeft === null) return -1;
    return a.daysLeft - b.daysLeft;
  });

  res.json({
    success: true,
    count: ranked.length,
    data: ranked.map((entry) => entry.order),
    /*
     * A count per band, so the page can lead with "3 overdue" without the
     * client re-deriving a ranking the server just computed. Recomputing it
     * there is how the two quietly disagree.
     */
    summary: {
      overdue: ranked.filter((e) => e.band === 0).length,
      outForDelivery: ranked.filter((e) => e.band === 1).length,
      dueSoon: ranked.filter((e) => e.band === 2).length,
      express: ranked.filter((e) => e.express).length,
      total: ranked.length,
    },
  });
});

module.exports = {
  listOrders,
  listDeliveries,
  requestOrderTransfer,
  placeOrder,
  buildOrderItems,
  restoreStock,
  decrementStock,
  stockIsTaken,
  updateFulfilment,
  getOrderTracking,
  getOrder,
  createOrder,
  updateOrder,
  assignOrder,
  deleteOrder,
  orderScopeFilter,
  ORDER_POPULATE,
};
