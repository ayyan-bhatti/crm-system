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
 */
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args).
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

  // Unexpected errors are bugs: log them, but don't expose internals.
  if (statusCode === 500 && !err.isOperational) {
    // eslint-disable-next-line no-console
    if (!env.isTest) console.error('[error]', err);
    if (env.isProduction) message = 'Internal server error';
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
