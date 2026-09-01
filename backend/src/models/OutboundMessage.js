const mongoose = require('mongoose');
const {
  CONTACT_CHANNEL_VALUES,
  OUTBOUND_KIND,
  OUTBOUND_KIND_VALUES,
  RECIPIENT_STATUS,
  RECIPIENT_STATUS_VALUES,
} = require('../config/marketing');

/**
 * One record per person per message: who we messaged, on what, and what
 * happened.
 *
 * WHY THIS IS ONE MODEL AND NOT TWO
 *
 * The brief asks for a `CampaignRecipient` join record per contact per
 * campaign, and separately for every transport call to be logged so that "did
 * the reorder reminder actually go out this week" has a real answer. Those are
 * the same record. A campaign recipient row IS a logged transport call that
 * happens to carry a campaign id; splitting them would mean two tables with
 * the same six columns, two places to write on every send, and — the part that
 * actually bites — two different answers to "has this person been messaged
 * recently", depending on which one you happened to query.
 *
 * So: `campaign` is set on a bulk send and null on everything else, and `kind`
 * says which kind of thing this was. Filtering by campaign gives the recipient
 * list; filtering by kind gives the automation log.
 *
 * WHY A SKIPPED CONTACT STILL GETS A ROW
 *
 * `skipped_no_consent` is the most important status in this model. A contact
 * who matched the audience and had not opted in leaves a row saying exactly
 * that. Filtered out silently instead, a campaign reports "sent to 40" against
 * an audience of 60 and nobody — not the sender, not an auditor, not the
 * person debugging it — can tell whether the missing 20 were unconsented,
 * unreachable, or a bug in the query. One of those is the system working
 * correctly and the other two are incidents, and they must not look alike.
 *
 * WHY THE RECIPIENT IS SNAPSHOTTED
 *
 * `email` and `name` are copied in rather than resolved through the reference
 * on read, for the same reason `AuditLog` snapshots its actor: this is a
 * record of something that HAPPENED, and it has to stay true after the
 * customer is renamed, merged or deleted. "We emailed this address on this
 * date" is the fact; a dangling reference cannot express it.
 */
const outboundMessageSchema = new mongoose.Schema({
  kind: {
    type: String,
    enum: {
      values: OUTBOUND_KIND_VALUES,
      message: `Kind must be one of: ${OUTBOUND_KIND_VALUES.join(', ')}`,
    },
    required: true,
  },

  channel: {
    type: String,
    enum: {
      values: CONTACT_CHANNEL_VALUES,
      message: `Channel must be one of: ${CONTACT_CHANNEL_VALUES.join(', ')}`,
    },
    required: true,
  },

  /** Set for a bulk send; null for a direct message or an automation. */
  campaign: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    default: null,
  },

  /**
   * Both references are kept where both exist.
   *
   * A contact is a merged view of up to two records, and which one a message
   * was addressed through matters later: an unsubscribe has to reach BOTH, and
   * a support question about "why did I get this" is answered by knowing which
   * record put them in the audience.
   */
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    default: null,
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    default: null,
  },

  /** Snapshotted — see the note above on why this is not resolved on read. */
  toAddress: {
    type: String,
    required: true,
    trim: true,
    maxlength: 320,
  },
  toName: {
    type: String,
    default: '',
    trim: true,
    maxlength: 120,
  },

  /**
   * The order that triggered this, for the two post-sale automations.
   *
   * Null for campaigns and direct messages. Present, it is what lets the
   * automation log say "review request for ORD-1042" rather than leaving
   * somebody to work out which purchase a message was about.
   */
  order: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null,
  },

  status: {
    type: String,
    enum: {
      values: RECIPIENT_STATUS_VALUES,
      message: `Status must be one of: ${RECIPIENT_STATUS_VALUES.join(', ')}`,
    },
    default: RECIPIENT_STATUS.PENDING,
  },

  /** Email only; empty for SMS and WhatsApp, which have no subject line. */
  subject: {
    type: String,
    default: '',
    trim: true,
    maxlength: 200,
  },

  /**
   * The first part of what was actually sent.
   *
   * TRUNCATED ON PURPOSE, and it is a storage decision worth stating: a
   * campaign to five thousand people would otherwise store five thousand
   * copies of an identical body. The full text of a campaign lives once, on
   * the `Campaign`. What is kept here is enough to recognise the message in a
   * log — which is what this field is for — without turning the collection
   * into a mail archive.
   */
  preview: {
    type: String,
    default: '',
    maxlength: 300,
  },

  /** console | webhook | twilio | meta — which transport actually ran. */
  transport: {
    type: String,
    default: '',
    maxlength: 40,
  },

  /** Why it failed, when it did. Empty otherwise. */
  error: {
    type: String,
    default: '',
    maxlength: 500,
  },

  /**
   * The staff member who caused this, or null for an automation.
   *
   * Null is meaningful rather than missing: it is how the log distinguishes
   * "a person pressed send" from "the scheduled job ran", which is the first
   * thing anyone wants to know when an unexpected message goes out.
   */
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/* ---------------------------------------------------------------------------
 * INDEXES — one per query that runs. See models/Customer.js for why each ends
 * with `_id` in the sort direction.
 * -------------------------------------------------------------------------*/

/** A campaign's recipient list, and its per-status counts. */
outboundMessageSchema.index({ campaign: 1, status: 1, createdAt: -1 });

/** The automation log: "what has the scheduler been doing", newest first. */
outboundMessageSchema.index({ kind: 1, createdAt: -1, _id: -1 });

/** Everything ever sent to one contact — the per-contact message history. */
outboundMessageSchema.index({ customer: 1, createdAt: -1, _id: -1 });

/** The unfiltered log, newest first. */
outboundMessageSchema.index({ createdAt: -1, _id: -1 });

/**
 * THE DOUBLE-SEND GUARD, and the reason it is a partial unique index rather
 * than a check in application code.
 *
 * A post-sale automation must never send the same message twice for the same
 * order. `postSaleService` already claims each order with a conditional update
 * before sending, which is the primary defence and handles the ordinary case.
 * This is the second one, and it is the one that holds when the first is
 * bypassed — a retried job, a manual re-run, a future caller that forgets.
 *
 * Partial, so it constrains ONLY the automation rows: campaigns and direct
 * messages legitimately send many messages about no order at all, and a plain
 * unique index would collide every one of them on `null`.
 *
 * AND PARTIAL ON STATUS TOO, which is the subtler half. A row that FAILED must
 * not occupy the slot, or one transient transport error would permanently
 * consume that order's only chance at a review request — turning "never send
 * twice" into "sometimes never send at all". Constraining only the SETTLED
 * outcomes lets tomorrow's run retry a failure while still making a duplicate
 * success impossible. `$in` is used rather than `$ne` because
 * `partialFilterExpression` does not support `$ne`.
 */
outboundMessageSchema.index(
  { order: 1, kind: 1 },
  {
    unique: true,
    partialFilterExpression: {
      kind: { $in: [OUTBOUND_KIND.REVIEW_REQUEST, OUTBOUND_KIND.REORDER_REMINDER] },
      status: { $in: [RECIPIENT_STATUS.SENT, RECIPIENT_STATUS.SKIPPED_NO_CONSENT] },
    },
  }
);

module.exports = mongoose.model('OutboundMessage', outboundMessageSchema);
