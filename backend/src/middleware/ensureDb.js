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
 */
module.exports = async function ensureDb(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();

  try {
    await connectDB();
    return next();
  } catch (err) {
    // A database that is unreachable is a server-side failure, not the
    // client's fault — and the message stays generic in production.
    return next(
      new ApiError(503, `Database unavailable: ${err.message}`)
    );
  }
};
