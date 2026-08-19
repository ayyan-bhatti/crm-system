const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');

/**
 * Per-IP rate limits for the endpoints that are worth attacking.
 *
 * WHAT THIS DEFENDS AGAINST — and what it does not
 *
 * This is the *volume* half of the defence: it caps how many requests one
 * network address can make in a window, which is what stops credential
 * stuffing, sign-up spam and someone running up an Anthropic bill. It is
 * deliberately not the only defence on login, because an attacker with a
 * botnet has thousands of addresses and each one stays under the limit. The
 * per-account lockout in models/User is the other half: it follows the
 * *account* rather than the address, so a distributed attack on one password
 * still gets throttled.
 *
 * WHY IN-MEMORY, AND WHAT THAT COSTS
 *
 * express-rate-limit's default store is a Map in the process. On a long-running
 * server that is exactly right. On Vercel each function instance has its own
 * memory, so the real limit is roughly (configured limit x number of warm
 * instances), and counters reset when an instance is recycled. That is a real
 * weakness and worth stating plainly rather than pretending otherwise.
 *
 * The fix is a shared store (Redis, or a Mongo-backed store). It is not done
 * here because it adds an external dependency to a project that currently needs
 * only MongoDB, and because the defence that actually protects an account —
 * the lockout — is already stored in MongoDB and therefore shared across every
 * instance. The IP limiter is the cheap outer layer; the durable one sits
 * behind it.
 */

/**
 * Build a limiter.
 *
 * Every limiter routes its rejection through the app's normal JSON error shape,
 * so a throttled client parses the response exactly like any other failure
 * instead of hitting express-rate-limit's plain-text default.
 */
function createLimiter({ windowMs, max, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    max,
    // Defaults to the client IP when no key generator is given.
    ...(keyGenerator ? { keyGenerator } : {}),
    // Return rate-limit state in the standard RateLimit-* headers so a client
    // can back off politely instead of guessing.
    standardHeaders: true,
    legacyHeaders: false,

    /**
     * Turn the limiters off in the test suite.
     *
     * Not a shortcut: the existing tests register and log in dozens of times
     * from one address, which is exactly the traffic pattern these limits are
     * built to reject. Leaving them on would make unrelated tests fail for a
     * reason that has nothing to do with what they are testing. The dedicated
     * rate-limit tests flip `env.rateLimitEnabled` on for themselves.
     */
    skip: () => !env.rateLimitEnabled,

    handler: (req, res) => {
      const retryAfterSeconds = Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        success: false,
        message,
        retryAfterSeconds,
      });
    },
  });
}

/**
 * Login: 10 attempts per 15 minutes per IP.
 *
 * Chosen to sit well above honest use and well below useful brute force. A real
 * person mistypes a password two or three times; ten leaves room for a shared
 * office IP without being generous enough to matter to an attacker, who needs
 * thousands of guesses. Tightening it further starts locking out legitimate
 * NAT'd offices, which is the failure mode nobody notices until a customer
 * complains.
 */
const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message:
    'Too many sign-in attempts from this address. Please wait a few minutes and try again.',
});

/**
 * Registration: 5 accounts per hour per IP.
 *
 * Sign-up is the one endpoint that creates unbounded state from an anonymous
 * caller, so the limit is the tightest here. Nobody legitimately creates a
 * sixth account in an hour from one address.
 */
const registerLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many accounts created from this address. Please try again later.',
});

/**
 * Password change: 5 per hour per IP.
 *
 * The endpoint verifies the current password, so it is a second place an
 * attacker can guess one — and unlike login it sits behind a valid session,
 * which makes it easy to forget to protect.
 */
const passwordResetLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many password change attempts. Please try again later.',
});

/**
 * AI search: 20 requests per 5 minutes per IP.
 *
 * The only limit here that is about money rather than security. Every call is a
 * paid Anthropic request, so an unthrottled endpoint is a way for anyone with
 * an account to spend the project's budget — accidentally, with a stuck retry
 * loop, as easily as deliberately. 20 in 5 minutes is far more than anyone
 * types by hand and far less than a script can burn through.
 *
 * Phase 2.4 adds a per-user limit on top: this one keys on IP, so an office
 * sharing an address would otherwise share a budget.
 */
const aiSearchLimiter = createLimiter({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: 'Too many AI searches. Please wait a moment before searching again.',
});

/**
 * The same budget again, but counted PER USER.
 *
 * Both limits are applied to the AI endpoints, and they catch different things:
 *
 *   per IP    one machine, or one script, hammering the endpoint.
 *   per user  the case the IP limiter gets wrong in both directions. An office
 *             behind one NAT address shares a single IP, so five colleagues
 *             using the feature normally would exhaust one quota between them —
 *             a limit that punishes ordinary use. And a determined user with a
 *             phone hotspot changes IP freely, so the IP limit alone is not a
 *             cap on any individual's spending.
 *
 * The signed-in user id is a much better identity for a cost control than a
 * network address, because it is exactly the thing being budgeted.
 *
 * Slightly more generous than the IP limit: one person legitimately runs more
 * searches in five minutes than an unauthenticated address should ever get.
 */
const aiPerUserLimiter = createLimiter({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message:
    'You have made a lot of AI requests in a short time. Please wait a moment before trying again.',
  /*
   * Must run after `protect`, which is what puts `req.user` there. Falls back
   * to the IP so the limiter can never throw on an unauthenticated request that
   * slipped past — the per-IP limiter is still in front of it either way.
   *
   * The fallback goes through `ipKeyGenerator` rather than using `req.ip`
   * directly, and that is not ceremony: a single IPv6 customer is normally
   * handed a whole /64, so keying on the raw address would let one person
   * present billions of distinct "clients" and walk straight past the limit.
   * The helper normalises an IPv6 address to its subnet prefix.
   */
  keyGenerator: (req) => (req.user ? `user:${req.user._id}` : `ip:${ipKeyGenerator(req.ip)}`),
});

module.exports = {
  createLimiter,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
  aiSearchLimiter,
  aiPerUserLimiter,
};
