/**
 * Request counts, error rates and latency, per route.
 *
 * WHAT THIS IS AND IS NOT
 *
 * It is enough to answer the three questions someone actually asks when a
 * deployment feels wrong: what is being hit, what is failing, and what is slow.
 * It is deliberately not a monitoring system — there is no time series, no
 * alerting and no history beyond the current process.
 *
 * WHY IN MEMORY, WHEN THE RATE LIMITER WAS MOVED TO MONGO
 *
 * The two look similar and are not. A rate limiter is a CONTROL: if its
 * counters are wrong the limit is wrong, and on serverless that made it wrong
 * by a factor of the instance count — which is why it moved into MongoDB.
 * Metrics are an OBSERVATION: a per-instance view is still a true sample, and
 * writing to the database on every single request to improve it would mean the
 * measurement changing the thing being measured.
 *
 * The honest consequence, and it is stated in the endpoint's own response: on a
 * serverless platform these numbers describe ONE instance since it woke up, not
 * the whole deployment. That is why the payload carries `instanceId` and
 * `windowStartedAt` — a reader can see which slice they are looking at rather
 * than mistaking it for the total.
 *
 * WHY THE SHAPE IS WHAT IT IS
 *
 * The output is deliberately close to what a Prometheus exporter would emit —
 * counters per (method, route, status class) plus latency buckets — so this can
 * be pointed at a real system later by writing a formatter, not by
 * re-instrumenting the app.
 */
const crypto = require('crypto');

/**
 * Latency buckets, in milliseconds.
 *
 * Buckets rather than every raw duration: keeping one number per request would
 * grow without bound, and the questions people ask ("how many requests took
 * over a second?") are bucket questions. The boundaries are chosen around what
 * a user notices — 50ms is imperceptible, 1s is a pause, 5s is broken.
 */
const LATENCY_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000];

/**
 * A cap on distinct route labels.
 *
 * Metrics keyed on something unbounded — a 404 for every URL a scanner tries —
 * would grow this map until the process ran out of memory. That failure mode
 * has a name (cardinality explosion) and it takes out the app it was meant to
 * be observing, so anything past the cap is folded into a single `other` label.
 */
const MAX_ROUTES = 200;

/** Identifies which instance answered, since each has its own numbers. */
const instanceId = crypto.randomUUID().slice(0, 8);
const startedAt = new Date();

/** route key -> { count, errors, clientErrors, totalMs, maxMs, buckets } */
const routes = new Map();

let totalRequests = 0;
let totalErrors = 0;

function emptyRoute() {
  return {
    count: 0,
    // 5xx — our fault, and the number that matters for an error rate.
    errors: 0,
    // 4xx — the client's, tracked separately so a burst of 401s does not look
    // like the service is broken.
    clientErrors: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: Object.fromEntries(LATENCY_BUCKETS.map((b) => [b, 0])),
    overflow: 0,
  };
}

function record({ method, route, statusCode, durationMs }) {
  const key = `${method} ${route}`;
  const label = routes.has(key) || routes.size < MAX_ROUTES ? key : `${method} other`;

  const entry = routes.get(label) || emptyRoute();

  entry.count += 1;
  entry.totalMs += durationMs;
  entry.maxMs = Math.max(entry.maxMs, durationMs);

  if (statusCode >= 500) entry.errors += 1;
  else if (statusCode >= 400) entry.clientErrors += 1;

  const bucket = LATENCY_BUCKETS.find((b) => durationMs <= b);
  if (bucket === undefined) entry.overflow += 1;
  else entry.buckets[bucket] += 1;

  routes.set(label, entry);

  totalRequests += 1;
  if (statusCode >= 500) totalErrors += 1;
}

/** The current numbers, shaped for a JSON response. */
function snapshot() {
  const perRoute = [...routes.entries()]
    .map(([key, entry]) => {
      const [method, ...rest] = key.split(' ');

      return {
        method,
        route: rest.join(' '),
        count: entry.count,
        serverErrors: entry.errors,
        clientErrors: entry.clientErrors,
        errorRate: entry.count ? round(entry.errors / entry.count) : 0,
        latencyMs: {
          mean: entry.count ? round(entry.totalMs / entry.count, 2) : 0,
          max: round(entry.maxMs, 2),
          buckets: entry.buckets,
          overSlowest: entry.overflow,
        },
      };
    })
    // Busiest first: the top of the list is where attention should go.
    .sort((a, b) => b.count - a.count);

  return {
    /*
     * Stated in the payload rather than left for the reader to infer. On
     * serverless these numbers are ONE instance since it woke up — presenting
     * them as deployment totals would be actively misleading.
     */
    scope: 'this server instance only',
    instanceId,
    windowStartedAt: startedAt,
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),

    totals: {
      requests: totalRequests,
      serverErrors: totalErrors,
      errorRate: totalRequests ? round(totalErrors / totalRequests) : 0,
    },

    routes: perRoute,
  };
}

/** Test seam — metrics accumulate across a whole process by design. */
function reset() {
  routes.clear();
  totalRequests = 0;
  totalErrors = 0;
}

function round(value, places = 4) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

module.exports = { record, snapshot, reset, LATENCY_BUCKETS, MAX_ROUTES };
