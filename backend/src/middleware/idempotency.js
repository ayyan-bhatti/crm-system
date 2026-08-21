const crypto = require('crypto');
const IdempotencyKey = require('../models/IdempotencyKey');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { componentLogger } = require('../config/logger');

const log = componentLogger('idempotency');

/**
 * Make a write endpoint safe to retry.
 *
 * The client sends `Idempotency-Key: <random id>` and reuses the same value on
 * every retry of that one logical request. This middleware guarantees the
 * handler runs at most once per key, and replays the stored response for later
 * attempts. See models/IdempotencyKey for why the problem is real and why
 * disabling the submit button does not solve it.
 *
 * THE FOUR CASES
 *
 *   no key                  pass straight through. Optional rather than
 *                           required — see the trade-off below.
 *   key never seen          reserve it, run the handler, store the response.
 *   key seen, completed     replay the stored response. The client learns the
 *                           order id it lost, and nothing runs twice.
 *   key seen, in progress   409. The original is still running; executing a
 *                           second copy in parallel is exactly what we are
 *                           preventing.
 *
 * WHY THE KEY IS OPTIONAL
 *
 * Requiring it would be stricter, and would break every existing client and
 * every curl command on the day it shipped. Optional keeps the API backwards
 * compatible while the frontend sends one on every order — so the path users
 * actually take is protected. The honest cost: a client that forgets the header
 * gets no protection, and nothing tells it so.
 *
 * WHY THE RESERVATION IS AN INSERT, NOT A CHECK-THEN-INSERT
 *
 * Two retries can arrive at the same millisecond, possibly on different
 * serverless instances. Both would read "no key yet" and both would proceed.
 * Inserting into a unique index pushes the decision into the database, which is
 * the only place that can arbitrate: exactly one insert wins, the other gets a
 * duplicate-key error. That is the whole mechanism.
 */

/** Reasonable bounds for a client-generated key (a UUID is 36 characters). */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 200;

/**
 * Hash the request so a reused key carrying different content is caught.
 *
 * Retrying sends the same body; a *reused* key with a new body is a client bug,
 * and replaying the old response for it would hand back an unrelated order.
 */
function fingerprint(req) {
  return crypto
    .createHash('sha256')
    .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`)
    .digest('hex');
}

const idempotency = asyncHandler(async (req, res, next) => {
  const key = req.get('Idempotency-Key');
  if (!key) return next();

  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    throw ApiError.badRequest(
      `Idempotency-Key must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters. ` +
        'A UUID is a good choice.'
    );
  }

  const scope = { key, user: req.user._id };
  const requestFingerprint = fingerprint(req);

  let reservation;
  try {
    reservation = await IdempotencyKey.create({ ...scope, fingerprint: requestFingerprint });
  } catch (err) {
    if (err.code !== 11000) throw err;

    // Someone got here first: either this same request retrying, or the
    // original still in flight.
    const existing = await IdempotencyKey.findOne(scope);

    // Vanishingly rare: the record expired between the failed insert and this
    // read. Treating it as a fresh request is the safe answer.
    if (!existing) return next();

    if (existing.fingerprint !== requestFingerprint) {
      throw ApiError.conflict(
        'This Idempotency-Key was already used for a different request. ' +
          'Generate a new key for each distinct operation.'
      );
    }

    if (existing.status === 'in_progress') {
      throw ApiError.conflict(
        'A request with this Idempotency-Key is still being processed. Retry in a moment.'
      );
    }

    // Replay. The client gets exactly what the original request returned.
    res.set('Idempotent-Replay', 'true');
    return res.status(existing.responseStatus).json(existing.responseBody);
  }

  /*
   * Capture the response so a later retry can be replayed.
   *
   * res.json is wrapped rather than the work being done in a 'finish' handler
   * alone, because 'finish' cannot see the body. The persistence itself happens
   * on 'finish' — after the response has gone out — so a slow write here can
   * never delay the client.
   *
   * The consequence, worth being explicit about: if that write fails, the
   * reservation is left `in_progress` and a retry within 24 hours gets a 409
   * rather than a replay. The client is told to retry shortly and the record
   * expires. Losing the response is a strictly better failure than executing
   * the order twice.
   */
  const originalJson = res.json.bind(res);
  let capturedBody;

  res.json = (body) => {
    capturedBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    const succeeded = res.statusCode < 400;

    const persist = succeeded
      ? IdempotencyKey.updateOne(
          { _id: reservation._id },
          { status: 'completed', responseStatus: res.statusCode, responseBody: capturedBody }
        )
      : // A failed request created nothing, so there is nothing to protect from
        // a repeat. Releasing the key lets the client fix the problem and retry
        // with the same one — holding it would force them to invent a new key
        // to correct a typo, which is a confusing rule to explain.
        IdempotencyKey.deleteOne({ _id: reservation._id });

    persist.catch((err) => {
      log.error({ err, key }, 'could not record the outcome of an idempotent request');
    });
  });

  return next();
});

module.exports = { idempotency };
