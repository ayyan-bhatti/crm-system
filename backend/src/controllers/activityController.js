const Activity = require('../models/Activity');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { canAccessCustomer, canAccessOrder } = require('../middleware/roles');

/**
 * The notes timeline on a customer or an order.
 *
 * THE TIMELINE BORROWS THE RECORD'S PERMISSIONS. IT DOES NOT INVENT ANY.
 *
 * Whether you may read or write notes on something is exactly whether you may
 * read that thing — resolved by loading the record and asking the same helper
 * the record's own endpoints ask. A separate rule here would be a second
 * definition of "your customers" to keep in step with the first, and the notes
 * on an account are often more revealing than its fields.
 *
 * That gives the answers you would want without stating them separately: a
 * sales rep can read and add notes on an order assigned to them, cannot touch
 * one assigned to a colleague, and cannot reach customer notes at all, because
 * a rep has no access to the customer book.
 */

/**
 * Load the record a note hangs off, and refuse early if the caller cannot see
 * it.
 *
 * The 404 for a missing record comes BEFORE the 403, and the 403 is the same
 * whether or not the record exists — so this endpoint cannot be used to find
 * out which customer ids are real by comparing responses.
 */
async function loadSubject(entity, id, user) {
  if (entity === 'customer') {
    const customer = await Customer.findById(id);
    if (!customer) throw ApiError.notFound('Customer not found');
    if (!canAccessCustomer(user, customer)) {
      throw ApiError.forbidden('You do not have access to this customer');
    }
    return customer;
  }

  const order = await Order.findById(id);
  if (!order) throw ApiError.notFound('Order not found');
  if (!canAccessOrder(user, order)) {
    throw ApiError.forbidden('You do not have access to this order');
  }
  return order;
}

/**
 * GET /api/customers/:id/activity
 * GET /api/orders/:id/activity
 *
 * Newest first, because the reason to open a timeline is almost always "what
 * happened last", and capped so one chatty account cannot return a document
 * that takes a second to render.
 */
const listActivity = (entity) =>
  asyncHandler(async (req, res) => {
    await loadSubject(entity, req.params.id, req.user);

    const limit = Math.min(Number(req.query.limit) || 50, 200);

    /*
     * `_id` breaks the tie, and is not decoration.
     *
     * `createdAt` has millisecond resolution, and two notes written in the same
     * millisecond — a fast double-submit, a seeded fixture, an import — would
     * otherwise come back in whatever order the storage engine felt like, which
     * can differ between two reads of the same data. An ObjectId embeds a
     * counter that increases within a process, so it settles the order the same
     * way every time.
     */
    const notes = await Activity.find({ entity, entityId: req.params.id })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    res.json({ success: true, count: notes.length, data: notes });
  });

/**
 * POST /api/customers/:id/activity
 * POST /api/orders/:id/activity
 *
 * WHY A MANAGER'S NOTE IS NOT A CHANGE REQUEST.
 *
 * A manager editing a customer queues for approval, and adding a note does not.
 * That is not an inconsistency: the approval workflow exists because changing a
 * customer's fields overwrites what was there, and an overwrite needs a second
 * pair of eyes. A note overwrites nothing. It is additive, attributed and
 * immutable, so the worst a bad one can do is be wrong in public with someone's
 * name against it.
 *
 * Queueing them would also make the feature pointless. The moment to write down
 * what a customer said is straight after the call; a note that appears once an
 * administrator gets round to it is a note nobody will bother writing.
 */
const addActivity = (entity) =>
  asyncHandler(async (req, res) => {
    await loadSubject(entity, req.params.id, req.user);

    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) throw ApiError.badRequest('A note cannot be empty');

    const note = await Activity.create({
      entity,
      entityId: req.params.id,
      body,
      // Snapshotted, not referenced — see models/Activity.
      author: {
        user: req.user._id,
        name: req.user.name,
        role: req.user.role,
      },
    });

    res.status(201).json({ success: true, data: note });
  });

/**
 * GET /api/customers/:id/activity/summary
 * GET /api/orders/:id/activity/summary
 *
 * One AI-written paragraph over the same timeline `listActivity` returns —
 * same access rule, same data, borrowed the same way. See
 * services/noteSummaryService.js for what the model may and may not do with it.
 */
const summarizeActivity = (entity) =>
  asyncHandler(async (req, res) => {
    await loadSubject(entity, req.params.id, req.user);

    const notes = await Activity.find({ entity, entityId: req.params.id })
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    const { summarize } = require('../services/noteSummaryService');
    const result = await summarize(notes);

    res.json({ success: true, mode: result.mode, data: { summary: result.summary } });
  });

module.exports = {
  listCustomerActivity: listActivity('customer'),
  addCustomerActivity: addActivity('customer'),
  listOrderActivity: listActivity('order'),
  addOrderActivity: addActivity('order'),
  summarizeCustomerActivity: summarizeActivity('customer'),
  summarizeOrderActivity: summarizeActivity('order'),
};
