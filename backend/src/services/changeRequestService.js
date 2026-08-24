const ChangeRequest = require('../models/ChangeRequest');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const ApiError = require('../utils/ApiError');
const { withTransaction } = require('../utils/transaction');
const { CHANGE_REQUEST_STATUS } = require('../config/constants');
const { componentLogger } = require('../config/logger');

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
 * THE ORDER OF OPERATIONS MATTERS
 *
 * Nothing is written to the real collections when a request is made. The
 * intended change sits in the request and is applied on approval, inside a
 * transaction, validated by the real model. The alternative — write now, undo
 * on rejection — is simpler and wrong: between the write and the rejection the
 * record is live, and a live order can be completed and move stock.
 */

/** The models a request can target, by entity name. */
const MODELS = { customer: Customer, order: Order };

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

  const request = await ChangeRequest.create({
    entity,
    entityId,
    action,
    payload,
    label,
    requestedBy: actor._id,
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
   * Assigned field by field rather than with `findByIdAndUpdate`, so the
   * schema's validators and pre-save hooks run. That is not a detail: it is
   * what stops an approved payload writing a value the model would have
   * refused when it was proposed.
   */
  Object.assign(doc, request.payload);
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

  return { request, result };
}

/**
 * Reject a request. The underlying record is untouched, because nothing was
 * ever written to it.
 */
async function reject(requestId, actor, note = '') {
  const request = await ChangeRequest.findById(requestId);

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

  return request;
}

/** How many are waiting. Used for the badge on the admin's screen. */
async function pendingCount() {
  return ChangeRequest.countDocuments({ status: CHANGE_REQUEST_STATUS.PENDING });
}

module.exports = { submit, listPending, approve, reject, pendingCount };
