const env = require('../config/env');
const { componentLogger, currentContext } = require('../config/logger');

const log = componentLogger('error');
const ApiError = require('../utils/ApiError');

/** Catch-all for URLs that matched no route. Runs after every router. */
function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

/**
 * Central error handler. Every error in the app — thrown, rejected, or passed
 * to next() — ends up here and leaves as JSON in a single consistent shape:
 *
 *   { "success": false, "message": "...", "details": { ... } }
 *
 * Mongoose's three common failure modes are translated into the status code a
 * client actually expects, instead of a blanket 500.
 *
 * LOGGING POLICY — the important part in production.
 *
 * Every 5xx is logged in full (message, stack, cause, and the request that
 * triggered it) BEFORE the response is sent, regardless of whether the error
 * was "expected". The previous version only logged non-operational 500s, which
 * meant a database outage — an operational 503 — produced a client-visible
 * failure and complete silence in the logs. When the only view into a running
 * deployment is its log stream, an unlogged 5xx is an undiagnosable one.
 *
 * 4xx is not logged: those are the client's mistakes, and logging them turns
 * the log into noise that hides the real failures.
 */

function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let details = err.details;

  // Invalid ObjectId in a URL param, e.g. GET /api/customers/not-an-id
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid value '${err.value}' for field '${err.path}'`;
  }

  // Schema validation failure — report every invalid field at once.
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).reduce((acc, e) => {
      acc[e.path] = e.message;
      return acc;
    }, {});
  }

  // Unique index violation, e.g. a duplicate email or SKU.
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    message = `A record with that ${field} already exists`;
  }

  // Mongoose could not reach the server within serverSelectionTimeoutMS. Very
  // common on a first deploy: wrong MONGO_URI, or the database's IP allow-list
  // does not include the platform's egress.
  if (err.name === 'MongooseServerSelectionError' || err.name === 'MongoServerSelectionError') {
    statusCode = 503;
    message = 'Database unavailable';
  }

  // --- Log every server-side failure, in full --------------------------------
  /*
   * Structured, not a formatted block of text.
   *
   * The old version printed a boxed, indented report that read nicely in a
   * terminal and could not be searched, filtered or alerted on. `err` is passed
   * as a field so pino serialises the name, message and stack itself, and the
   * request id from the async context is attached automatically — so this line
   * and every other line for the same request share one searchable key.
   */
  if (statusCode >= 500) {
    log.error(
      {
        err,
        req: { method: req.method, url: req.originalUrl, ip: req.ip },
        res: { statusCode },
        // An unexpected error is a bug; an operational one is a rule the client
        // broke or a dependency that is down. Worth distinguishing when
        // deciding whether an alert should wake somebody.
        kind: err.isOperational ? 'operational' : 'unexpected',
        ...(err.code ? { code: err.code } : {}),
        ...(env.isConfigValid ? {} : { configErrors: env.configErrors }),
      },
      err.message
    );
  }

  // Unexpected 500s must not leak internals to the client in production.
  // Operational errors (403, 404, 503 "Database unavailable") keep their
  // message, because it is the useful part and reveals nothing sensitive.
  if (statusCode === 500 && !err.isOperational && env.isProduction) {
    message = 'Internal server error';
  }

  /*
   * The request id goes back to the client on every error.
   *
   * This is what makes the logging useful to a real person: a user reports
   * "it said something went wrong, reference a1b2c3d4" and that string finds
   * every log line for their request, across every module. Without it, support
   * starts from a timestamp and a guess.
   *
   * It reveals nothing — it is a random id we generated for this one request.
   */
  const requestId = currentContext()?.requestId;

  res.status(statusCode).json({
    success: false,
    message,
    ...(details ? { details } : {}),
    ...(requestId ? { requestId } : {}),
    // Stack traces are useful while developing, never in production.
    ...(env.isProduction || env.isTest ? {} : { stack: err.stack }),
  });
}

module.exports = { notFound, errorHandler };
