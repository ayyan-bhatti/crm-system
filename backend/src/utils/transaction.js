const mongoose = require('mongoose');
const { componentLogger } = require('../config/logger');

const log = componentLogger('db');

/**
 * Run a unit of work inside a MongoDB transaction.
 *
 * WHY ORDER CREATION NEEDS ONE
 *
 * Creating an order touches two collections: it writes an Order and decrements
 * stock on several Products. Without a transaction those are separate writes
 * with gaps between them, and a crash, a timeout, or a serverless function
 * being frozen mid-request leaves the database in a state that is not merely
 * stale but *wrong*:
 *
 *   - stock taken, order never written  -> inventory has vanished into nothing
 *   - order written, stock not taken    -> the same unit is sold twice
 *
 * The previous code compensated by hand: it decremented, and on failure looped
 * back over the products it had already touched and added the stock back. That
 * works right up until the process dies between the failure and the
 * compensation — at which point nothing runs the undo, and there is no record
 * that it was owed. A transaction moves that guarantee from "our code
 * remembers to clean up" to "the database will not show anyone a partial
 * result", which is a much stronger promise and a much shorter piece of code.
 *
 * WHY session.withTransaction RATHER THAN start/commit/abort BY HAND
 *
 * It retries automatically on the two errors a correct transaction still has to
 * expect:
 *
 *   TransientTransactionError    two transactions touched the same document and
 *                                one lost the write conflict. Retrying is the
 *                                prescribed response, and it is exactly what
 *                                happens when two people buy the last unit at
 *                                once — the case Phase 1.6 is about.
 *   UnknownTransactionCommitResult  the commit may or may not have landed
 *                                (network blip). Retrying is safe because a
 *                                committed transaction commits idempotently.
 *
 * Hand-rolled start/commit/abort silently drops both, which means the code
 * looks correct and fails only under the concurrency it was written for.
 */

/**
 * Whether this deployment supports transactions.
 *
 * MongoDB requires a replica set or a sharded cluster; a plain standalone
 * `mongod` does not qualify. That matters in practice:
 *
 *   MongoDB Atlas (including the free tier)  replica set  -> supported
 *   `mongod` installed locally for dev        standalone   -> NOT supported
 *   the test suite                            single-node replica set (see
 *                                             tests/setup.js) -> supported
 *
 * So a developer running a local standalone would otherwise find every order
 * creation failing with an obscure "Transaction numbers are only allowed on a
 * replica set member" error. Rather than demand everyone reconfigure their
 * local MongoDB, this degrades: it runs the same work without a transaction and
 * says so, loudly, once.
 *
 * Detected at first use rather than assumed from configuration, because the
 * connection string does not reliably tell you.
 */
let transactionsSupported = null;

/** Error codes MongoDB returns when transactions are not available. */
const UNSUPPORTED_CODES = new Set([
  20, // IllegalOperation — "Transaction numbers are only allowed on a replica set member or mongos"
  263, // OperationNotSupportedInTransaction
]);

function isUnsupportedError(err) {
  if (!err) return false;
  if (UNSUPPORTED_CODES.has(err.code)) return true;
  return /transaction numbers are only allowed|transactions are not supported/i.test(
    err.message || ''
  );
}

/**
 * Execute `work` inside a transaction, passing it the session.
 *
 * Every query inside `work` MUST be given `{ session }`, or it runs outside the
 * transaction and is neither isolated nor rolled back — the classic way a
 * transaction ends up being decorative. The callers in the order controller
 * thread it through explicitly for that reason.
 *
 * @param {(session: import('mongoose').ClientSession | null) => Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
async function withTransaction(work) {
  if (transactionsSupported === false) {
    return work(null);
  }

  const session = await mongoose.startSession();

  try {
    let result;

    // The callback's return value is not forwarded by withTransaction in all
    // driver versions, so it is captured here instead.
    await session.withTransaction(async () => {
      result = await work(session);
    });

    transactionsSupported = true;
    return result;
  } catch (err) {
    if (isUnsupportedError(err)) {
      if (transactionsSupported === null) {
        log.warn(
          'this MongoDB deployment does not support transactions (standalone, not a ' +
            'replica set). Order creation still works, but a crash mid-write could leave ' +
            'stock and orders out of step. Use MongoDB Atlas, or a local replica set, ' +
            'for the guarantee.'
        );
      }
      transactionsSupported = false;
      return work(null);
    }

    throw err;
  } finally {
    await session.endSession();
  }
}

/** Test seam — lets a test force the fallback path without a second database. */
function _setTransactionsSupported(value) {
  transactionsSupported = value;
}

module.exports = { withTransaction, _setTransactionsSupported };
