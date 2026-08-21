const crypto = require('crypto');
const { logger, withRequestContext, currentContext } = require('../config/logger');
const metrics = require('../services/metrics');

/**
 * Request ids, request logging, and the numbers behind /api/internal/metrics.
 *
 * WHY A REQUEST ID
 *
 * A user says "it broke around two o'clock and showed me an error". Without an
 * id, finding the corresponding log lines means guessing from timestamps and
 * hoping nobody else was using the system. With one, the error response carries
 * the id, the user quotes it, and every line for that request — across every
 * module, however deep — is one search.
 *
 * Incoming ids are FORWARDED rather than replaced. Vercel, load balancers and
 * gateways set `x-request-id` and use it in their own logs; generating a new
 * one would break the chain at exactly the boundary where correlation matters.
 * A client-supplied id is only ever used for correlation, never for a decision,
 * so a forged one can mislead a search and nothing more.
 */

/** Accept an upstream id only if it looks like one — see the note below. */
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;

function resolveRequestId(req) {
  const candidate = req.get('x-request-id') || req.get('x-vercel-id') || '';

  /*
   * A header is user input. An unvalidated one ends up in every log line for
   * the request, which is how log-injection works: a newline in the value lets
   * an attacker forge whole log entries. JSON output escapes newlines anyway,
   * so this is belt and braces — and it also stops a 10KB header bloating every
   * line of a request.
   */
  if (SAFE_ID.test(candidate)) return candidate;

  return crypto.randomUUID();
}

/**
 * Attach a request id and log the outcome of every request.
 *
 * One line per request, on completion, rather than one on the way in and
 * another on the way out. The inbound line carries nothing the outbound one
 * does not, and doubling the volume of the noisiest log in the system to say
 * "a request started" is a poor trade.
 */
function requestLogger(req, res, next) {
  const requestId = resolveRequestId(req);
  const startedAt = process.hrtime.bigint();

  // Echoed so a client — or a user reading dev tools — can quote it.
  res.setHeader('X-Request-Id', requestId);

  withRequestContext({ requestId }, () => {
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

      /*
       * The route PATTERN, not the URL.
       *
       * `req.route?.path` gives `/customers/:id` where `req.originalUrl` gives
       * `/api/customers/652f8a...`. Metrics keyed on the URL would create a
       * fresh series per customer id — thousands of one-hit entries, and no way
       * to see "the customer detail endpoint is slow".
       */
      const route = routePattern(req);

      metrics.record({
        method: req.method,
        route,
        statusCode: res.statusCode,
        durationMs,
      });

      const context = currentContext();

      const line = {
        req: {
          method: req.method,
          url: req.originalUrl,
          route,
          ip: req.ip,
        },
        res: { statusCode: res.statusCode },
        durationMs: Math.round(durationMs * 100) / 100,
        // Set by `protect` once it has identified the caller.
        ...(context?.userId ? { userId: context.userId } : {}),
      };

      /*
       * Level by outcome. A 500 is our problem and should page someone; a 4xx
       * is the client's mistake and is worth seeing but not alerting on; a 2xx
       * is routine. Logging all three at the same level makes the level useless
       * as a filter.
       */
      if (res.statusCode >= 500) logger.error(line, 'request failed');
      else if (res.statusCode >= 400) logger.warn(line, 'request rejected');
      else logger.info(line, 'request completed');
    });

    next();
  });
}

/** `/api/customers/:id` rather than a URL with an id baked into it. */
function routePattern(req) {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    return `${base}${req.route.path}`.replace(/\/$/, '') || '/';
  }

  // No route matched (a 404), or the response finished before routing. The
  // literal path is the only thing available, and lumping every unmatched URL
  // under one label keeps the metrics readable.
  return req.originalUrl.split('?')[0];
}

module.exports = { requestLogger, resolveRequestId };
