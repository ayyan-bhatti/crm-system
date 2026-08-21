const crypto = require('crypto');
const env = require('../config/env');
const { componentLogger } = require('../config/logger');

const log = componentLogger('ai-cache');

/**
 * A short-lived cache for identical AI requests.
 *
 * WHAT IT IS FOR
 *
 * People repeat searches. They run one, look at the results, navigate away,
 * come back and run the same one again; or three colleagues ask the same
 * question the same morning. Every one of those is a paid API call producing a
 * byte-identical answer.
 *
 * WHY FIVE MINUTES
 *
 * The window has to be short enough that the answer is still true. The AI call
 * translates a question into a FILTER — it does not read the data — so a cached
 * filter is re-run against the live database on every hit, and results are
 * never stale. What could go stale is the translation itself, and only if
 * somebody changes the schema mid-session.
 *
 * Five minutes is chosen against user behaviour rather than correctness: it
 * comfortably covers "run it, look, come back", and is short enough that a
 * genuinely new session pays for a fresh call. A longer window would save more
 * money and start to feel like the app was ignoring you.
 *
 * WHY THE CUSTOMER SUMMARY IS NOT CACHED
 *
 * Only AI SEARCH uses this. A summary is about one customer and includes
 * figures that move whenever an order is placed — caching it would show a rep a
 * revenue number that is minutes out of date, on the screen they opened
 * specifically to check it. Search caches a query translation; a summary caches
 * an answer, and those are not the same risk.
 *
 * WHY IN MEMORY
 *
 * Same reasoning as the metrics, and the opposite of the rate limiter: a cache
 * is an OPTIMISATION, not a control. A per-instance cache still saves most of
 * the duplicate calls, and a miss costs exactly what the call cost before. A
 * shared cache in MongoDB would add a read and a write to every AI request to
 * save a fraction more — paying in latency on every request to save money on
 * some.
 */

/** How long an entry stays usable. */
const TTL_MS = 5 * 60 * 1000;

/**
 * A hard cap on entries.
 *
 * An unbounded cache keyed on user input is a memory leak with extra steps: a
 * script issuing unique queries would grow it until the process died. When full,
 * the oldest entry is evicted — a plain LRU is more machinery than this needs,
 * and the access pattern here (a burst of repeats, then never again) makes
 * insertion order a good enough proxy.
 */
const MAX_ENTRIES = 200;

/** key -> { value, expiresAt } */
const store = new Map();

/**
 * The cache key.
 *
 * SCOPED PER USER, which is the important part. Two people asking the same
 * question are entitled to different answers: a sales rep sees only their own
 * customers, so serving them an admin's cached results would leak records the
 * permission model exists to hide. Hashing the query keeps a raw customer name
 * out of a map that ends up in a heap dump.
 */
function cacheKey({ feature, query, entity, userId }) {
  const material = `${feature}|${userId || 'anonymous'}|${entity || 'auto'}|${normalise(query)}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * "customers in Karachi" and "  Customers  In  KARACHI " are the same question.
 *
 * Only case and whitespace are folded — nothing clever. Aggressive
 * normalisation risks treating two genuinely different questions as one, and a
 * wrong cache hit is far worse than a missed one.
 */
function normalise(query) {
  return String(query || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The cached value, or null. Expired entries are dropped on access. */
function get(descriptor) {
  if (!env.aiCacheEnabled) return null;

  const key = cacheKey(descriptor);
  const entry = store.get(key);

  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  log.debug({ feature: descriptor.feature }, 'AI cache hit');
  return entry.value;
}

/** Store a value under the descriptor. */
function set(descriptor, value) {
  if (!env.aiCacheEnabled) return;

  // Evict oldest-first when full. Map preserves insertion order, so the first
  // key is the oldest.
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }

  store.set(cacheKey(descriptor), { value, expiresAt: Date.now() + TTL_MS });
}

/** Test seam, and useful after a schema change invalidates every translation. */
function clear() {
  store.clear();
}

function size() {
  return store.size;
}

module.exports = { get, set, clear, size, cacheKey, TTL_MS, MAX_ENTRIES };
