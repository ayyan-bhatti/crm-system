const mongoose = require('mongoose');

/**
 * A record of one idempotency key, and the response it produced.
 *
 * THE PROBLEM THIS SOLVES
 *
 * "Create order" is not naturally repeatable. If the response is lost — the
 * user's connection drops, a mobile network stalls, the tab is refreshed
 * mid-request, or the user simply double-clicks Submit — the client has no way
 * to know whether the order was created. Retrying risks a duplicate; not
 * retrying risks losing the sale. Disabling the button on the frontend helps
 * with the double-click and does nothing at all for the dropped response,
 * because the second request comes from a *new page load*.
 *
 * With an idempotency key the client picks a random id, sends it with the
 * request, and reuses the same id on every retry. The server executes at most
 * once per key and replays the stored response afterwards, so retrying is
 * always safe — the client no longer has to know whether the first attempt
 * landed.
 *
 * WHY THE RESPONSE IS STORED, NOT JUST THE KEY
 *
 * Recording only "this key was used" would let the server reject the retry,
 * which leaves the client in the same position it started in: it still does not
 * know the order id. Replaying the original response answers the actual
 * question.
 *
 * THE FINGERPRINT
 *
 * A hash of the request. If the same key arrives with a *different* body, that
 * is a client bug (a reused key), not a retry — and silently replaying the old
 * response would return an unrelated order. It is refused instead.
 */
const idempotencyKeySchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
  },
  /**
   * Keys are scoped per user, so two users independently generating the same
   * id cannot collide — and one user cannot probe another's keys to read their
   * stored responses.
   */
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  /** SHA-256 of method + path + body. See the note above. */
  fingerprint: {
    type: String,
    required: true,
  },
  /**
   * `in_progress` while the original request is still running. A second request
   * arriving in that window is a genuine concurrent retry, and is told to wait
   * rather than being allowed to execute in parallel.
   */
  status: {
    type: String,
    enum: ['in_progress', 'completed'],
    default: 'in_progress',
  },
  responseStatus: { type: Number, default: null },
  responseBody: { type: mongoose.Schema.Types.Mixed, default: null },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/**
 * The unique index is the whole mechanism, not a constraint bolted on top.
 *
 * Two simultaneous retries both try to insert the reservation; MongoDB lets
 * exactly one succeed and fails the other with a duplicate-key error. That is
 * what makes "execute at most once" true even when the two requests arrive at
 * the same millisecond on different server instances — a check-then-insert in
 * application code could not, because both would read "no key yet".
 */
idempotencyKeySchema.index({ key: 1, user: 1 }, { unique: true });

/**
 * Keys expire after 24 hours.
 *
 * Long enough to cover any realistic retry (including a user reopening a laptop
 * the next morning), short enough that the collection does not grow without
 * bound. The value is a trade-off rather than a fact: a longer window protects
 * against more duplicates and stores more data.
 */
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

module.exports = mongoose.model('IdempotencyKey', idempotencyKeySchema);
