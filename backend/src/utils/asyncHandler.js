/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * handler instead of hanging the request.
 *
 * Without this, every controller would need its own try/catch that does nothing
 * but call next(err). With it, controllers read as straight-line code.
 *
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
