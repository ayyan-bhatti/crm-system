/**
 * An error that carries an HTTP status code.
 *
 * Controllers throw these; the central error handler turns them into JSON
 * responses. Anything thrown that is NOT an ApiError is treated as a bug and
 * reported as a 500, so we never leak an unexpected stack trace as a 4xx.
 */
class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    // Marks the error as "expected" — i.e. a rule the client broke, not a crash.
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = 'Not authenticated') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }

  static conflict(message = 'Resource already exists') {
    return new ApiError(409, message);
  }
}

module.exports = ApiError;
