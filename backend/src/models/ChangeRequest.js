const mongoose = require('mongoose');

const { CHANGE_REQUEST_STATUS, CHANGE_REQUEST_STATUS_VALUES } = require('../config/constants');

/**
 * A change somebody wants to make, waiting for an administrator to agree.
 *
 * WHY THE CHANGE IS STORED RATHER THAN APPLIED-THEN-REVERTED.
 *
 * The alternative is to write the change immediately and undo it if it is
 * rejected. That is much simpler and it is wrong in a way that matters: between
 * the write and the rejection the record is live. An order would be visible to
 * the assigned rep, who might complete it and move stock; a customer's address
 * would be the one a delivery goes to. "Approved" has to mean "took effect",
 * which means nothing can take effect first.
 *
 * So the intended change is held here as a payload and applied only on
 * approval. The real collections never see it until somebody says yes.
 *
 * WHY THE PAYLOAD IS NOT A SCHEMA.
 *
 * `Mixed`, deliberately. This holds a partial update to one of two different
 * models, and the fields differ by entity and by action. Modelling that
 * properly would mean a discriminator per entity per action, all of which would
 * have to be kept in step with the models they shadow — a second definition of
 * every field, drifting from the first.
 *
 * The safety this gives up is recovered where it belongs: the payload is
 * validated by the REAL model at apply time, inside a transaction. A payload
 * that would not have been a legal write when it was proposed is still not one
 * when it is approved, and the approval fails rather than writing rubbish.
 * Storing it loosely and validating it strictly is the right way round.
 */
const changeRequestSchema = new mongoose.Schema({
  /** Which collection this touches. */
  entity: {
    type: String,
    required: true,
    enum: {
      values: ['customer', 'order', 'campaign'],
      message: 'A change request must be for a customer, an order or a campaign',
    },
  },

  /**
   * The record being changed, or null for a creation.
   *
   * Null is meaningful rather than missing: it is what distinguishes "make this
   * new thing" from "change that existing thing", and the apply step branches
   * on it.
   */
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null,
  },

  /**
   * `transfer` is a fourth action rather than an `update` carrying an
   * `assignedTo`.
   *
   * Mechanically it is the same write. It is separated because the two are
   * asked by different people for different reasons and read completely
   * differently in a queue: an update is "a manager wants to change what was
   * sold", a transfer is "the rep holding this cannot do it". An admin skimming
   * a list of "update order ORD-000142" rows would have to open each one to
   * tell those apart.
   */
  /**
   * `cancel` is a fifth action, separate from `delete`, for the same reason
   * `transfer` is separate from `update`: it is a different write asked by a
   * different kind of requester. A manager's `delete` removes the order
   * document outright. A buyer's `cancel` — the only change a buyer can ever
   * request — moves a still-`pending` order to `cancelled` and leaves the
   * document in place, because a buyer's order history has to keep showing
   * the order they cancelled, not lose it.
   */
  /**
   * `send` is a sixth action, and the only one that does not write a record.
   *
   * Approving it DISPATCHES A CAMPAIGN — it puts messages in front of real
   * people — which makes it the least reversible thing in this queue. Every
   * other action can be undone by another edit; a sent email cannot be
   * unsent. It is a separate action rather than an `update` for exactly the
   * reason `transfer` and `cancel` are: an admin skimming the queue has to be
   * able to see, without opening it, that this row is different in kind.
   */
  action: {
    type: String,
    required: true,
    enum: {
      values: ['create', 'update', 'delete', 'transfer', 'cancel', 'send'],
      message:
        'A change request must be a create, an update, a delete, a transfer, a cancel or a send',
    },
  },

  /** The fields to write. Empty for a delete, which has nothing to say. */
  payload: {
    type: mongoose.Schema.Types.Mixed,
    default: () => ({}),
  },

  /**
   * A human label for the thing being changed, captured when the request is
   * made.
   *
   * Snapshotted rather than looked up on read, for the same reason the audit
   * log snapshots names: a rejected request for a customer who is later deleted
   * still has to be readable, and resolving a dangling reference at display
   * time gives you "unknown" exactly when you most want to know.
   */
  label: {
    type: String,
    default: '',
  },

  status: {
    type: String,
    enum: {
      values: CHANGE_REQUEST_STATUS_VALUES,
      message: `Status must be one of: ${CHANGE_REQUEST_STATUS_VALUES.join(', ')}`,
    },
    default: CHANGE_REQUEST_STATUS.PENDING,
  },

  /**
   * Which collection `requestedBy` points into.
   *
   * Every request used to come from staff, so `requestedBy` was a plain
   * `ref: 'User'`. A buyer requesting their own order's cancellation is not a
   * `User` — buyers are intentionally a separate collection with no access to
   * the staff role table (see the buyer-auth build-log entry) — so the
   * reference now needs to say which model to follow. `refPath` rather than a
   * second `requestedByBuyer` field, because a request has exactly one
   * requester and modelling that as two mutually-exclusive optional fields
   * would let both be set, or neither, which a single polymorphic reference
   * cannot do.
   *
   * Defaulting to `'User'` is what keeps this backward compatible: every
   * change request written before this field existed has no value stored
   * here, and Mongoose applies the schema default when hydrating a document
   * that is missing it — so an old request still `populate()`s its requester
   * as a `User`, correctly, with no migration.
   */
  requestedByModel: {
    type: String,
    enum: {
      values: ['User', 'Buyer'],
      message: 'requestedByModel must be User or Buyer',
    },
    default: 'User',
  },

  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'requestedByModel',
    required: true,
  },

  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  reviewedAt: {
    type: Date,
    default: null,
  },

  /**
   * Why it was rejected, when the admin says.
   *
   * Optional, because forcing a reason produces "no" and "asdf" in equal
   * measure. Offered, because "your change was rejected" with no explanation is
   * how the same request gets submitted again next week.
   */
  reviewNote: {
    type: String,
    default: '',
    maxlength: 500,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/*
 * The approvals queue: pending requests, oldest first.
 *
 * A queue is worked from the front, so the sort is ASCENDING here where every
 * other list in this app is newest-first. `_id` rides along to make the order
 * total — see the note in utils/queryHelpers about tied documents appearing on
 * two pages at once.
 */
changeRequestSchema.index({ status: 1, createdAt: 1, _id: 1 });

/*
 * "Is there already a request outstanding against this record?" — asked before
 * accepting a new one, so two people cannot queue conflicting edits to the same
 * order and have both approved.
 */
changeRequestSchema.index({ entity: 1, entityId: 1, status: 1 });

module.exports = mongoose.model('ChangeRequest', changeRequestSchema);
