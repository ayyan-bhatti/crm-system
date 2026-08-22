const mongoose = require('mongoose');

/**
 * An immutable record of one write to the system.
 *
 * WHAT IT IS FOR
 *
 * Three questions this collection exists to answer, none of which the data
 * itself can:
 *
 *   "Who deleted this customer?"            — accountability
 *   "What did this record look like before  — recovery
 *    someone changed it?"
 *   "Did anyone touch these orders last     — investigation
 *    Tuesday?"
 *
 * Ordinary documents only hold their current state. The moment a field is
 * overwritten, what was there before is gone, and with it any way to tell an
 * honest correction from a mistake or from someone covering their tracks.
 *
 * THE ACTOR IS DENORMALISED ON PURPOSE
 *
 * `actor` stores the user's id AND a snapshot of their name, email and role at
 * the time of the action, rather than only a reference. This looks like
 * duplication and is deliberate: an audit trail whose contents change when
 * someone is renamed, demoted or deleted is not an audit trail. "Ayesha
 * (manager) deleted this" must still read that way a year later, even if Ayesha
 * has since left and her account is gone.
 *
 * NO TTL INDEX — A DELIBERATE OMISSION
 *
 * Other collections in this project expire their rows automatically. This one
 * does not, and that is the point: audit logs that quietly delete themselves
 * are exactly as useful as no audit logs on the day you need them. The
 * collection will grow, and pruning it is a retention decision for whoever runs
 * the system — a conscious policy, not a default.
 */

const actorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Snapshots — see the note above.
    name: String,
    email: String,
    role: String,
  },
  { _id: false }
);

const auditLogSchema = new mongoose.Schema({
  actor: {
    type: actorSchema,
    required: true,
  },
  action: {
    type: String,
    enum: ['create', 'update', 'delete'],
    required: true,
  },
  /** Which collection was written to: customer, product, order, user. */
  entity: {
    type: String,
    required: true,
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  /**
   * A human-readable name for the record, captured at the time.
   *
   * Without it, the log for a deleted customer reads "customer 652f8a…", which
   * is exactly the case where the name matters most — the record is gone, so
   * nothing can look it up any more.
   */
  entityLabel: {
    type: String,
    default: '',
  },

  /** The document before and after. Null on create and delete respectively. */
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },

  /**
   * Just the fields that actually changed, precomputed.
   *
   * Derived from before/after, so strictly redundant — but a reviewer reading
   * an audit screen wants "status: lead -> active", not two whole documents to
   * diff by eye. Computing it once at write time also means the list endpoint
   * does not have to do it for every row on every request.
   */
  changes: {
    type: [
      {
        field: String,
        from: mongoose.Schema.Types.Mixed,
        to: mongoose.Schema.Types.Mixed,
        _id: false,
      },
    ],
    default: [],
  },

  /**
   * A short human sentence about what happened, when the diff alone does not
   * say it.
   *
   * The `changes` array above is generated and complete, and for most writes it
   * is enough — "status: pending → completed" reads fine. It is not enough when
   * the changed value is an id: "assignedTo: 65f3a9… → 68b1c4…" is technically
   * the whole truth and tells a reader nothing, and resolving those ids a year
   * later means looking up two users who may since have been deleted.
   *
   * So a caller that knows something the diff cannot express writes it down at
   * the time. Optional, and never a substitute for the diff — it sits beside it.
   */
  note: { type: String, default: '', maxlength: 500 },

  /** Request metadata — where the action came from. */
  ip: { type: String, default: '' },
  userAgent: { type: String, default: '' },
  method: { type: String, default: '' },
  path: { type: String, default: '' },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/*
 * Indexes for the three ways the audit screen is read. Each one matches a
 * filter the endpoint actually offers — an index for a query nobody makes just
 * slows every write down.
 */
// The default view: newest first, optionally narrowed by entity type.
/*
 * WHY EVERY SORTING INDEX ENDS WITH `_id`
 *
 * `getSort` appends `_id` to every sort so the ordering is total (see the long
 * note in utils/queryHelpers.js — without it, tied documents can appear on two
 * pages at once). That fix has a consequence that is easy to miss and was
 * caught here by an explain() test rather than by reading the code:
 *
 *   an index on { createdAt: -1 } does NOT satisfy a sort of
 *   { createdAt: -1, _id: -1 }
 *
 * MongoDB falls back to fetching every matching document and sorting them in
 * memory. The index still exists, the query still returns the right answer, and
 * the only symptom is that it got slower — which is precisely the kind of
 * regression that goes unnoticed until the collection is large.
 *
 * So each index below carries `_id` in the same direction as its sort field.
 */

auditLogSchema.index({ createdAt: -1, _id: -1 });
auditLogSchema.index({ entity: 1, createdAt: -1, _id: -1 });
// "What has this person been doing?" and "what happened to this record?"
auditLogSchema.index({ 'actor.user': 1, createdAt: -1, _id: -1 });
auditLogSchema.index({ entityId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
