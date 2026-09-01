const ChangeRequest = require('../models/ChangeRequest');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const ApiError = require('../utils/ApiError');
const { withTransaction } = require('../utils/transaction');
const { CHANGE_REQUEST_STATUS } = require('../config/constants');
const { componentLogger } = require('../config/logger');
const mailer = require('./mailer');

const log = componentLogger('change-requests');

/**
 * Proposing a change, and an administrator agreeing to it.
 *
 * WHAT THIS IS FOR
 *
 * A manager runs the business day to day but does not own the record. They may
 * propose any change to a customer or an order; an administrator decides
 * whether it happens. An administrator's own changes apply immediately —
 * requiring them to approve themselves would be theatre, and a queue that fills
 * with your own requests is a queue you stop reading.
 *
 * WHAT IS DELIBERATELY OUTSIDE IT
 *
 * A sales rep completing or cancelling an order assigned to them. That is the
 * step the assignment exists to let them take, it is a status transition rather
 * than a change to what was sold, and gating it would leave a rep able to see
 * work and unable to do it. See canAdvanceOrder in middleware/roles.
 *
 * Placing an order is outside it too. That used to queue and it was the wrong
 * call: it put the approver in the critical path of SELLING, so nothing a
 * manager agreed became real until somebody else acted. What needs approval is
 * changing or destroying a record that already exists.
 *
 * WHO ASKS FOR WHAT
 *
 *   manager  a customer write, an edit to an order's items, a deletion
 *   rep      a transfer of an order they hold to a colleague
 *
 * THE ORDER OF OPERATIONS MATTERS
 *
 * Nothing is written to the real collections when a request is made. The
 * intended change sits in the request and is applied on approval, inside a
 * transaction, validated by the real model. The alternative — write now, undo
 * on rejection — is simpler and wrong: between the write and the rejection the
 * record is live, and a live order can be completed and move stock.
 */

/** The models a request can target, by entity name. */
const MODELS = { customer: Customer, order: Order, campaign: require('../models/Campaign') };

/**
 * Record a proposed change.
 *
 * @returns {Promise<object>} the saved request
 */
async function submit({ entity, entityId = null, action, payload = {}, label = '' }, actor) {
  if (!MODELS[entity]) {
    throw ApiError.badRequest(`Changes cannot be requested for "${entity}"`);
  }

  /*
   * One outstanding request per record.
   *
   * Without this, two managers can queue conflicting edits to the same order
   * and an admin can approve both — the second silently overwriting the first,
   * having been written against a version that no longer exists. Refusing the
   * second submission puts that conflict in front of the person who can
   * actually resolve it, at the moment they are making it.
   *
   * Creations are exempt: they have no `entityId`, so there is nothing to
   * conflict over.
   */
  if (entityId) {
    const outstanding = await ChangeRequest.findOne({
      entity,
      entityId,
      status: CHANGE_REQUEST_STATUS.PENDING,
    });

    if (outstanding) {
      throw ApiError.conflict(
        'There is already a change waiting for approval on this record. It has to be ' +
          'approved or rejected before another can be requested.'
      );
    }
  }

  /*
   * A buyer requesting their own order's cancellation is not a `User` — see
   * `models/ChangeRequest.js` for why `requestedBy` is polymorphic. Read off
   * the actor's own model name rather than a caller-supplied flag, so it is
   * impossible for a caller to mislabel who is asking: staff callers pass
   * `req.user` (a `User` document), the buyer routes pass `req.buyer` (a
   * `Buyer` document), and each names itself.
   */
  const requestedByModel = actor.constructor.modelName === 'Buyer' ? 'Buyer' : 'User';

  const request = await ChangeRequest.create({
    entity,
    entityId,
    action,
    payload,
    label,
    requestedBy: actor._id,
    requestedByModel,
  });

  log.info(
    { requestId: request._id, entity, action, entityId, requestedBy: actor._id },
    'change requested'
  );

  return request;
}

/** Pending requests, oldest first — a queue is worked from the front. */
async function listPending() {
  return ChangeRequest.find({ status: CHANGE_REQUEST_STATUS.PENDING })
    .populate('requestedBy', 'name email role')
    .sort({ createdAt: 1, _id: 1 });
}

/**
 * Apply an approved change.
 *
 * Runs inside the caller's transaction so that marking the request approved and
 * making the change it describes are one atomic act. A partial outcome here is
 * the worst of the available failures: a request marked approved whose change
 * never landed looks, to everyone afterwards, exactly like a change that was
 * made and then mysteriously reverted.
 */
async function applyChange(request, session) {
  const Model = MODELS[request.entity];

  if (request.action === 'create') {
    /*
     * AN ORDER IS NOT A DOCUMENT YOU CAN JUST INSERT.
     *
     * The payload holds what was PROPOSED — a customer and a list of
     * `{ product, quantity }`. A real order also needs each line priced at the
     * price of the day, a total computed from those lines, a human-readable
     * number allocated atomically, and stock decremented if it is being
     * completed. `Model.create(payload)` produced a 400 from the schema, which
     * was the right answer to the wrong question.
     *
     * So an approved order goes through the same function a directly-created
     * one does. Anything else would mean two definitions of what an order is,
     * and the approved kind would be the one nobody tested.
     */
    if (request.entity === 'order') {
      const { placeOrder } = require('../controllers/orderController');

      return placeOrder(
        {
          customerId: request.payload.customer,
          rawItems: request.payload.items,
          status: request.payload.status,
          actorId: request.payload.createdBy,
        },
        session
      );
    }

    // `create` with a session takes an array; the single-document form does
    // not accept options.
    const [created] = await Model.create([request.payload], { session });
    return created;
  }

  const doc = await Model.findById(request.entityId).session(session);

  /*
   * The record may have been deleted since the request was made. That is not
   * an error in the request, and it must not be reported as one — it is a
   * request that has been overtaken by events, and saying so is the only honest
   * answer available.
   */
  if (!doc) {
    throw ApiError.conflict(
      `The ${request.entity} this change refers to no longer exists, so the change cannot ` +
        'be applied. Reject the request instead.'
    );
  }

  if (request.action === 'delete') {
    await doc.deleteOne({ session });
    return doc;
  }

  /*
   * A CAMPAIGN SEND WRITES NOTHING HERE, AND THAT IS THE POINT.
   *
   * Approving a campaign dispatches messages to real people. That cannot go
   * inside this transaction, for the same two reasons the refund path stays
   * outside it and states at length: a MongoDB transaction can be retried
   * automatically on a write conflict, and a retried dispatch is a list
   * messaged twice; and an email, once sent, cannot be rolled back by
   * aborting anything.
   *
   * So the transaction does the part that IS transactional — marking the
   * request approved — and `approve()` dispatches afterwards, once the commit
   * has actually happened. The ordering is the opposite of the refund's
   * (money moves first, because a failed refund should leave nothing changed)
   * and for a symmetrical reason: an approval that commits and then fails to
   * send leaves a campaign an admin can retry, whereas a send that succeeds
   * against an aborted approval leaves messages nobody authorised.
   */
  if (request.action === 'send') {
    return doc;
  }

  /*
   * A buyer's cancellation, unlike a manager's delete, leaves the document
   * standing — their own order history has to keep showing an order they
   * cancelled, not lose it. Only ever proposed against a `pending` order
   * (enforced where the request is submitted), so in practice there is
   * nothing to restore — but the restore runs unconditionally, off
   * `completedAt`, for the same reason `updateOrder`'s status transition
   * does: the rule is "restore stock if it was taken", not "restore stock if
   * we happen to know it wasn't", and stating that once here rather than
   * trusting the caller to have enforced it is what makes it still correct
   * if that enforcement ever changes.
   */
  if (request.action === 'cancel') {
    // Lazy required — see the note on the `create` branch above for why.
    const { restoreStock, stockIsTaken } = require('../controllers/orderController');
    const { FULFILMENT_STATUS } = require('../config/constants');

    /*
     * By the time execution reaches here the refund has ALREADY been issued, in
     * `approve()`, before this transaction was opened. See the long note there
     * and in services/refundService.js for why the money moves first and why
     * the Stripe call cannot be inside a transaction.
     *
     * The guard is `stockIsTaken` rather than `completedAt` because those are
     * now two different facts: a card-paid order has had its stock taken while
     * still sitting as `pending`, and cancelling it must put those units back.
     * Reading `completedAt` alone would silently keep the stock of every
     * refunded card order out of inventory.
     */
    if (stockIsTaken(doc)) await restoreStock(doc.items, session);

    doc.status = 'cancelled';
    doc.completedAt = null;
    doc.stockTakenAt = null;
    doc.fulfilment = FULFILMENT_STATUS.CANCELLED;
    await doc.save({ session });
    return doc;
  }

  /*
   * A transfer writes one field, and writes it from the payload rather than
   * from whatever the requester happens to be able to see now. The rep asked
   * for a specific colleague; approving means that colleague, not "whoever is
   * free today".
   */
  if (request.action === 'transfer') {
    doc.assignedTo = request.payload.assignedTo ?? null;
    await doc.save({ session });
    return doc;
  }

  const payload = { ...request.payload };

  /*
   * AN APPROVED EDIT TO AN ORDER'S ITEMS HAS TO BE PRICED, EXACTLY AS A DIRECT
   * ONE IS.
   *
   * The payload holds what was proposed — `{ product, quantity }` — and an order
   * line needs `priceAtOrder`, with a total recomputed from the lines. Assigning
   * the raw payload produced a 400 from the schema, which is the same mistake
   * the CREATE path made and for the same reason: a proposal is not a record.
   *
   * Priced at approval time rather than at proposal time, deliberately. The
   * price of the day is the day the order actually changes; freezing the price
   * when somebody asked would let a request sit in the queue over a price rise
   * and then apply the old one.
   */
  if (request.entity === 'order' && Array.isArray(payload.items)) {
    const { buildOrderItems } = require('../controllers/orderController');
    const { items, total } = await buildOrderItems(payload.items, session);

    payload.items = items;
    payload.total = total;
  }

  /*
   * Assigned field by field rather than with `findByIdAndUpdate`, so the
   * schema's validators and pre-save hooks run. That is not a detail: it is
   * what stops an approved payload writing a value the model would have
   * refused when it was proposed.
   */
  Object.assign(doc, payload);
  await doc.save({ session });

  return doc;
}

/**
 * Approve a request and make the change.
 *
 * @returns {Promise<{ request: object, result: object }>}
 */
async function approve(requestId, actor) {
  // Populated because the audit note names the person who asked, and resolving
  // it afterwards would mean a second lookup for a value we are already here
  // for.
  const request = await ChangeRequest.findById(requestId).populate('requestedBy', 'name email');

  if (!request) throw ApiError.notFound('Change request not found');

  if (request.status !== CHANGE_REQUEST_STATUS.PENDING) {
    throw ApiError.badRequest(`This request was already ${request.status}`);
  }

  /*
   * MONEY GOES BACK BEFORE ANYTHING ELSE HAPPENS.
   *
   * Deliberately outside — and before — the transaction below. Two reasons,
   * both spelled out at length in services/refundService.js: a MongoDB
   * transaction can be retried automatically on a write conflict, which would
   * re-issue the refund; and if the refund fails, nothing at all should have
   * changed, which is exactly what "throw before opening the transaction"
   * gives us.
   *
   * `refundOrderIfPaid` returns null for the common case of an order nobody
   * ever paid for, so this line is a no-op for every cancellation that predates
   * card payment.
   */
  if (request.action === 'cancel' && request.entity === 'order') {
    const { refundOrderIfPaid } = require('./refundService');
    await refundOrderIfPaid(request.entityId);
  }

  const result = await withTransaction(async (session) => {
    const applied = await applyChange(request, session);

    request.status = CHANGE_REQUEST_STATUS.APPROVED;
    request.reviewedBy = actor._id;
    request.reviewedAt = new Date();
    await request.save({ session });

    return applied;
  });

  log.info(
    { requestId: request._id, entity: request.entity, action: request.action, by: actor._id },
    'change approved and applied'
  );

  /*
   * The dispatch, deliberately after the commit — see the `send` branch in
   * `applyChange` for why it cannot be inside the transaction.
   *
   * A failure here does NOT un-approve the request. The approval is a real
   * decision that was really made, and reverting it would hide the fact that
   * an administrator agreed; the campaign is left marked `failed` with its
   * reason attached, which is a state an admin can see and retry from.
   */
  if (request.action === 'send' && request.entity === 'campaign') {
    const campaignService = require('./campaignService');
    const campaign = await campaignService.dispatchApproved(request.entityId, actor);

    return { request, result: campaign };
  }

  await notifyBuyerOfOutcome(request, 'approved');

  return { request, result };
}

/**
 * Reject a request. The underlying record is untouched, because nothing was
 * ever written to it.
 */
async function reject(requestId, actor, note = '') {
  const request = await ChangeRequest.findById(requestId).populate('requestedBy', 'name email');

  if (!request) throw ApiError.notFound('Change request not found');

  if (request.status !== CHANGE_REQUEST_STATUS.PENDING) {
    throw ApiError.badRequest(`This request was already ${request.status}`);
  }

  request.status = CHANGE_REQUEST_STATUS.REJECTED;
  request.reviewedBy = actor._id;
  request.reviewedAt = new Date();
  request.reviewNote = String(note || '').slice(0, 500);
  await request.save();

  log.info({ requestId: request._id, by: actor._id }, 'change rejected');

  /*
   * A rejected campaign goes back to `draft` rather than staying stuck in
   * `pending_approval`. Nothing was sent, so there is nothing to undo — but
   * leaving it in the approval state would make it unsendable AND uneditable,
   * which is a dead record rather than a rejected proposal. The author can
   * narrow the audience and ask again, which is the outcome a rejection is
   * usually reaching for.
   */
  if (request.action === 'send' && request.entity === 'campaign') {
    const campaignService = require('./campaignService');
    await campaignService.markRejected(request.entityId);
  }

  await notifyBuyerOfOutcome(request, 'rejected');

  return request;
}

/**
 * Tell a buyer what happened to a request they made — best-effort, exactly
 * like `notifyAdminsOfRequest` in `authController.js` is for a staff sign-up
 * request. A mail outage must not roll back an approval that has already
 * been applied inside its own transaction, so this runs after, outside it,
 * and a failure here is logged rather than surfaced to the approver.
 *
 * Staff-initiated requests get no such email — the requester is signed in
 * to the CRM and can just look at the record, and a manager whose customer
 * edit was rejected does not need an inbox notification to find out.
 */
async function notifyBuyerOfOutcome(request, outcome) {
  if (request.requestedByModel !== 'Buyer') return;

  try {
    const buyer = request.requestedBy?.email
      ? request.requestedBy
      : await require('../models/Buyer').findById(request.requestedBy).select('name email');

    if (!buyer?.email) return;

    const what = { cancel: 'cancellation', update: 'edit', delete: 'cancellation' }[
      request.action
    ] || 'change';

    const body =
      outcome === 'approved'
        ? `Your ${what} request for order ${request.label} has been approved and applied.`
        : `Your ${what} request for order ${request.label} was not approved.` +
          (request.reviewNote ? ` Note from the team: ${request.reviewNote}` : '');

    await mailer.sendMail({
      to: buyer.email,
      subject: `Update on your order ${request.label}`,
      text: body,
    });
  } catch (err) {
    log.warn({ err, requestId: request._id }, 'could not notify a buyer of a request outcome');
  }
}

/** How many are waiting. Used for the badge on the admin's screen. */
async function pendingCount() {
  return ChangeRequest.countDocuments({ status: CHANGE_REQUEST_STATUS.PENDING });
}

module.exports = { submit, listPending, approve, reject, pendingCount };
