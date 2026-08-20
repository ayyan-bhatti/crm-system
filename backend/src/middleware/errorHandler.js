const env = require('../config/env');
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
  if (statusCode >= 500 && !env.isTest) {
    console.error(
      [
        '',
        '='.repeat(72),
        `[error] ${statusCode} ${req.method} ${req.originalUrl}`,
        `  name    : ${err.name || 'Error'}`,
        `  message : ${err.message}`,
        err.code ? `  code    : ${err.code}` : null,
        // An unexpected error is a bug; an operational one is a rule the
        // client broke or a dependency that is down. Worth distinguishing at
        // a glance when scanning logs.
        `  kind    : ${err.isOperational ? 'operational' : 'UNEXPECTED (likely a bug)'}`,
        '  stack   :',
        String(err.stack || '(no stack)')
          .split('\n')
          .map((line) => `    ${line.trim()}`)
          .join('\n'),
        // Mongoose and node-fetch style errors nest the real reason here.
        err.cause ? `  cause   : ${err.cause.message || err.cause}` : null,
        env.isConfigValid ? null : `  config  : ${env.configErrors.join(' | ')}`,
        '='.repeat(72),
        '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  // Unexpected 500s must not leak internals to the client in production.
  // Operational errors (403, 404, 503 "Database unavailable") keep their
  // message, because it is the useful part and reveals nothing sensitive.
  if (statusCode === 500 && !err.isOperational && env.isProduction) {
    message = 'Internal server error';
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(details ? { details } : {}),
    // Stack traces are useful while developing, never in production.
    ...(env.isProduction || env.isTest ? {} : { stack: err.stack }),
  });
}

module.exports = { notFound, errorHandler };
