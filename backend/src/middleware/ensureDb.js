const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
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
 *
 * A failure here is not silent: the 503 below is a 5xx, and the central error
 * handler logs every 5xx in full — name, message, code, stack, cause, and the
 * request that triggered it. That is where the connection error surfaces.
 */
module.exports = async function ensureDb(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();

  try {
    await connectDB();
    return next();
  } catch (err) {
    // A database that is unreachable is a server-side failure, not the
    // client's fault. The message stays specific even in production because
    // "Database unavailable" reveals nothing sensitive and saves a support
    // round trip.
    return next(new ApiError(503, `Database unavailable: ${err.message}`));
  }
};
