const mongoose = require('mongoose');

/**
 * One note on a customer or an order. Written once, never changed.
 *
 * WHY APPEND-ONLY
 *
 * This is the record of what people said and did about an account: "called,
 * asked for a discount", "chased the invoice, no answer", "they are unhappy
 * about the delay". Its whole value is that it reflects what was known at the
 * time. A timeline anyone can go back and quietly reword is not a history of
 * the account, it is a draft of one — and the moment a note can be edited, the
 * question "did this say something different yesterday?" has no answer.
 *
 * Editable notes also break the thing they are most used for. Somebody reads
 * back a conversation before ringing a customer; if the previous rep tidied
 * their note after the fact, what is read back is the tidy version rather than
 * the one that would explain why the customer is annoyed.
 *
 * So corrections are made the way they are made in a paper ledger: by writing
 * another line. It is slightly less convenient and considerably more honest.
 *
 * THE AUTHOR IS SNAPSHOTTED, LIKE THE AUDIT TRAIL
 *
 * `author` keeps the user's id AND their name and role as they were when the
 * note was written. Same reasoning as models/AuditLog: a history that rewrites
 * itself when someone is renamed, demoted or deleted is not a history. "Sara
 * (sales rep) said the customer would call back" must still read that way next
 * year, whether or not Sara is still a rep or still here.
 *
 * NOT THE AUDIT LOG, AND NOT A REPLACEMENT FOR IT
 *
 * The audit log records what the SYSTEM did — field-level before and after for
 * every write, written automatically, read by administrators. This records what
 * a PERSON chose to say, in their own words, and everyone working the account
 * reads it. Different authors, different audiences, different retention
 * arguments. Merging them would produce something too noisy to read and too
 * chatty to audit.
 */

const authorSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Snapshots — see the note above.
    name: String,
    role: String,
  },
  { _id: false }
);

const activitySchema = new mongoose.Schema({
  /**
   * What the note is attached to.
   *
   * A single collection rather than `customerNotes` and `orderNotes`, because
   * every rule here — immutability, authorship, ordering — is identical for
   * both, and the only thing that differs is which record it hangs off. Two
   * collections would mean maintaining that logic twice and having it drift.
   */
  entity: {
    type: String,
    enum: ['customer', 'order'],
    required: true,
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  author: {
    type: authorSchema,
    required: true,
  },
  body: {
    type: String,
    required: [true, 'A note cannot be empty'],
    trim: true,
    // Long enough for a real account of a phone call, short enough that the
    // timeline stays readable and one paste cannot bloat a document.
    maxlength: [2000, 'A note cannot be longer than 2000 characters'],
  },
  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true,
  },
});

/**
 * The only query this collection serves: one record's timeline, newest first.
 */
activitySchema.index({ entity: 1, entityId: 1, createdAt: -1 });

/*
 * APPEND-ONLY, ENFORCED HERE RATHER THAN ONLY BY THE ABSENCE OF A ROUTE.
 *
 * Not exposing an edit endpoint is how it is enforced today. That holds exactly
 * as long as nobody adds one, and "we simply won't build that" is a convention,
 * not a guarantee — a later generic admin screen or a well-meant bulk fix would
 * walk straight through it without anyone noticing the rule existed.
 *
 * These hooks make the model itself refuse. Every mutating path Mongoose
 * offers is covered, so a write attempt fails loudly at the point of the write
 * with a message saying what to do instead, rather than succeeding quietly.
 */
const IMMUTABLE = 'Notes are append-only: write a new note rather than changing an old one.';

for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
]) {
  activitySchema.pre(op, function blockMutation(next) {
    next(new Error(IMMUTABLE));
  });
}

/** `save()` on a document that already exists — the other way in. */
activitySchema.pre('save', function blockResave(next) {
  if (this.isNew) return next();
  return next(new Error(IMMUTABLE));
});

module.exports = mongoose.model('Activity', activitySchema);
