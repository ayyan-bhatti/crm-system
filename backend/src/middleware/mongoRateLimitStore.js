const mongoose = require('mongoose');

/**
 * A rate-limit store backed by MongoDB, shared across every server instance.
 *
 * WHY THIS REPLACES THE IN-MEMORY DEFAULT
 *
 * express-rate-limit counts in a Map inside the process. On a long-running
 * server that is exactly right. On Vercel it is close to useless: each function
 * instance has its own memory, so the effective limit is (configured limit x
 * number of warm instances), and every counter resets when an instance is
 * recycled — which happens constantly. A "10 attempts per 15 minutes" login
 * limit can quietly become sixty.
 *
 * Redis is the usual answer. This project already depends on MongoDB and on
 * nothing else, and adding a second datastore for one counter is a real
 * operational cost — another thing to provision, monitor and pay for. Mongo is
 * slower than Redis for this, and "slower" here means one indexed upsert on the
 * handful of endpoints that are rate limited, which is not a meaningful cost
 * next to the bcrypt comparison happening on the same request.
 *
 * HOW THE WINDOW WORKS
 *
 * Fixed windows, not a sliding log. Each key gets one document holding a count
 * and an expiry; the first request in a window sets the expiry, and everything
 * until then increments. A sliding window would be more precise at the
 * boundary — someone can make `max` requests at the end of one window and `max`
 * again at the start of the next — but it needs a timestamp per request rather
 * than a single counter, which is far more storage and more work per hit for a
 * precision that does not change the defence.
 *
 * The increment is a single atomic `findOneAndUpdate` with upsert. Read-then-
 * write would let simultaneous requests each read the same count and each write
 * count+1, which is precisely the burst these limits exist to catch.
 */

const rateLimitHitSchema = new mongoose.Schema({
  /** `${limiterName}:${clientKey}` — see the note in the store below. */
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true, default: 0 },
  /** When the current window ends. */
  expiresAt: { type: Date, required: true },
});

/*
 * MongoDB removes each document once its window has passed, so the collection
 * cannot grow without bound. `expireAfterSeconds: 0` means "expire at the time
 * in this field".
 *
 * Mongo's TTL monitor runs about once a minute, so a document can outlive its
 * window by up to that long. That does not affect correctness here: the store
 * compares `expiresAt` itself when deciding whether to start a new window, and
 * treats an expired-but-not-yet-collected document as a fresh one.
 */
rateLimitHitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RateLimitHit =
  mongoose.models.RateLimitHit || mongoose.model('RateLimitHit', rateLimitHitSchema);

/**
 * The store interface express-rate-limit expects.
 *
 * Implemented directly rather than pulling in `rate-limit-mongo`, which is
 * ~40 lines of logic and one more unmaintained dependency in the request path
 * of the login endpoint.
 */
class MongoRateLimitStore {
  /**
   * @param {object} options
   * @param {string} options.name distinguishes one limiter's counters from
   *   another's. Without it, the login and register limiters would share a
   *   counter for the same IP and consume each other's budget.
   */
  constructor({ name }) {
    this.name = name;
  }

  /** express-rate-limit hands the limiter's options over at startup. */
  init(options) {
    this.windowMs = options.windowMs;
  }

  scopedKey(key) {
    return `${this.name}:${key}`;
  }

  /**
   * Record a hit and report the current count.
   *
   * The whole operation is one atomic upsert, so concurrent requests cannot
   * both read a stale count.
   */
  async increment(key) {
    const scoped = this.scopedKey(key);
    const now = new Date();

    /*
     * Two steps, and the order matters.
     *
     * First, retire a window that has already ended: reset it rather than
     * letting the increment below continue a stale count. This is what makes
     * the store correct even though Mongo's TTL collector is up to a minute
     * behind.
     */
    await RateLimitHit.updateOne(
      { key: scoped, expiresAt: { $lte: now } },
      { $set: { count: 0, expiresAt: new Date(now.getTime() + this.windowMs) } }
    );

    // Then count this request, creating the document if it is the first.
    const record = await RateLimitHit.findOneAndUpdate(
      { key: scoped },
      {
        $inc: { count: 1 },
        // Only sets the expiry when the document is being created, so a window
        // is not extended by the traffic inside it.
        $setOnInsert: { expiresAt: new Date(now.getTime() + this.windowMs) },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return {
      totalHits: record.count,
      resetTime: record.expiresAt,
    };
  }

  /** Used by express-rate-limit when a request should not have counted. */
  async decrement(key) {
    await RateLimitHit.updateOne(
      { key: this.scopedKey(key), count: { $gt: 0 } },
      { $inc: { count: -1 } }
    );
  }

  /** Clear one client's counter. The tests use this to isolate cases. */
  async resetKey(key) {
    await RateLimitHit.deleteOne({ key: this.scopedKey(key) });
  }

  /** Clear every counter for this limiter. */
  async resetAll() {
    await RateLimitHit.deleteMany({ key: new RegExp(`^${this.name}:`) });
  }
}

module.exports = { MongoRateLimitStore, RateLimitHit };
