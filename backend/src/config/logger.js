const pino = require('pino');
const { AsyncLocalStorage } = require('async_hooks');
const env = require('./env');

/**
 * Structured logging.
 *
 * WHY JSON RATHER THAN console.log
 *
 * `console.log('[db] connected to ' + host)` is readable by a person watching a
 * terminal and almost useless to anything else. On a hosted platform nobody
 * watches a terminal — logs are searched, filtered and alerted on, and that
 * needs fields rather than sentences. "Show me every 5xx on /api/orders for
 * user X in the last hour" is a query against structured records and a regex
 * guessing game against prose.
 *
 * So every line is a JSON object with a level, a timestamp, a request id and
 * whatever context the event has. Vercel, CloudWatch, Datadog and friends all
 * parse that natively.
 *
 * WHY THE REQUEST ID IS IN ASYNC STORAGE RATHER THAN PASSED AROUND
 *
 * The point of a request id is that EVERY line produced while handling one
 * request carries it, so a user reporting "it failed at 14:32 and said
 * a1b2c3" can be traced to the exact lines. That only works if code deep in a
 * service can log it without having been handed a request object — and
 * threading `req` through every service function purely so it can log would
 * distort every signature in the codebase for one cross-cutting concern.
 *
 * `AsyncLocalStorage` is Node's answer: the request middleware opens a context,
 * and anything running inside that async chain can read it, however deep.
 *
 * DEVELOPMENT PRINTS PROSE, PRODUCTION PRINTS JSON
 *
 * JSON is for machines. A developer reading a terminal wants a line they can
 * scan, so `pino-pretty` is used locally when it is installed — and its absence
 * is not fatal, because a missing dev dependency should never stop the server.
 */

/** Carries the current request's context down the async call chain. */
const requestContext = new AsyncLocalStorage();

/**
 * Fields that must never be logged, at any level.
 *
 * Logs are retained, shipped to third-party services and read by people who are
 * not the user — which makes them exactly the wrong place for a credential.
 * `redact` replaces these paths wherever they appear rather than relying on
 * every call site to remember.
 */
const REDACTED_PATHS = [
  'password',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
];

function buildTransport() {
  // Pretty output only where a human is reading it, and only if available.
  if (env.isProduction || env.isTest) return undefined;

  try {
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    };
  } catch {
    // Not installed. JSON to the console is a perfectly good fallback, and a
    // missing dev dependency must not stop the app.
    return undefined;
  }
}

const logger = pino({
  level: env.logLevel,

  /*
   * Silent in tests.
   *
   * Not laziness: the suite deliberately exercises failure paths — expired
   * tokens, refused logins, rolled-back transactions — every one of which logs.
   * Hundreds of lines of expected errors scrolling past makes a REAL failure
   * impossible to spot, which is worse than no logs at all.
   */
  enabled: !env.isTest,

  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },

  // ISO timestamps rather than epoch millis: a human reading a log line should
  // not have to convert it, and every log platform parses ISO.
  timestamp: pino.stdTimeFunctions.isoTime,

  formatters: {
    // `level: "info"` rather than `level: 30`. Costs nothing and means a filter
    // can be written by someone who has not memorised pino's numbering.
    level: (label) => ({ level: label }),
  },

  /**
   * Every line gets the current request's id and user automatically.
   *
   * This is what makes the id useful — a service five calls deep logs it
   * without knowing a request exists.
   */
  mixin() {
    const context = requestContext.getStore();
    if (!context) return {};

    return {
      requestId: context.requestId,
      ...(context.userId ? { userId: context.userId } : {}),
    };
  },

  transport: buildTransport(),
});

/** Run `fn` with a request context attached to everything it awaits. */
function withRequestContext(context, fn) {
  return requestContext.run(context, fn);
}

/** The current request's context, or undefined outside a request. */
function currentContext() {
  return requestContext.getStore();
}

/**
 * A child logger tagged with a component name.
 *
 * `logger.child({ component: 'ai' })` means every line from that module carries
 * it, so "everything the AI client did" is a filter rather than a grep for a
 * prefix string somebody might have typed differently.
 */
function componentLogger(component) {
  return logger.child({ component });
}

module.exports = { logger, componentLogger, withRequestContext, currentContext };
