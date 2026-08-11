const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');

/**
 * Guarantees a database connection before a request touches a model.
 *
 * On a long-running server this is a no-op: server.js connects at boot, so
 * every request finds `readyState === 1` and passes straight through. Same in
 * tests, where the in-memory database is connected before any request runs.
 *
 * It earns its place on serverless, where there is no boot step. The first
 * request into a cold instance opens the connection here; the rest reuse it.
 * Without this, a handler would reach for a model before Mongoose was ready and
 * either buffer until it timed out or fail outright.
 */
module.exports = async function ensureDb(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();

  try {
    await connectDB();
    return next();
  } catch (err) {
    // ===================================================================
    // TEMPORARY DEBUG LOGGING — REMOVE BEFORE FINAL SUBMISSION
    //
    // Added to diagnose a production 500/503 on Vercel. This prints the raw
    // driver error, which is what actually names the cause: bad credentials,
    // DNS failure on the cluster host, or an IP allow-list rejection.
    //
    // It deliberately prints a REDACTED form of MONGO_URI. Never log the URI
    // itself — it contains the database password, and function logs are not a
    // safe place for it.
    //
    // To remove: delete this block, keep the `return next(...)` below.
    // ===================================================================
    if (!env.isTest) {
      const redactedUri = String(env.mongoUri).replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');

      // eslint-disable-next-line no-console
      console.error(
        [
          '',
          '*'.repeat(72),
          '*** TEMPORARY DEBUG (remove before final submission) ***',
          '[db-debug] MongoDB connection FAILED',
          `  error name    : ${err.name}`,
          `  error message : ${err.message}`,
          err.code ? `  error code    : ${err.code}` : null,
          `  mongo uri     : ${redactedUri || '(empty — MONGO_URI is not set)'}`,
          `  readyState    : ${mongoose.connection.readyState} (0=disconnected 1=connected 2=connecting)`,
          `  serverless    : ${env.isServerless}`,
          '',
          '  Most common causes, in order:',
          '    1. MONGO_URI not set in the deployment environment',
          "    2. Atlas Network Access does not allow the platform's egress IPs",
          '    3. Wrong username/password in the connection string',
          '    4. Cluster hostname typo (check for a DNS/ENOTFOUND error above)',
          '',
          '  raw error:',
          String(err.stack || err)
            .split('\n')
            .map((line) => `    ${line.trim()}`)
            .join('\n'),
          '*'.repeat(72),
          '',
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
    // =============== END TEMPORARY DEBUG LOGGING =======================

    // A database that is unreachable is a server-side failure, not the
    // client's fault. The message is kept specific even in production because
    // "Database unavailable" reveals nothing sensitive and saves a support round trip.
    return next(new ApiError(503, `Database unavailable: ${err.message}`));
  }
};
