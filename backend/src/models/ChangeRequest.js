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
      values: ['customer', 'order'],
      message: 'A change request must be for a customer or an order',
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

  action: {
    type: String,
    required: true,
    enum: {
      values: ['create', 'update', 'delete'],
      message: 'A change request must be a create, an update or a delete',
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

  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
