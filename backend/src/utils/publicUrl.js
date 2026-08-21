const env = require('../config/env');

/**
 * The origin to put in a link that will be opened in a browser.
 *
 * WHY THIS IS NOT JUST `env.appUrl`.
 *
 * `env.appUrl` falls back to `http://localhost:5173` when neither `APP_URL` nor
 * `CLIENT_ORIGIN` is set. On a laptop that is exactly right. On a deployment
 * where nobody set either variable it is a link to the user's own machine —
 * which is the bug this exists to fix. Every invitation and every password
 * reset pointed at localhost, so the token was valid and the URL was useless,
 * and the failure looked like "the link doesn't work" rather than like a
 * missing environment variable.
 *
 * So: explicit configuration always wins, and when there is none we use the
 * origin the request actually arrived on. A deployment that was never
 * configured then produces working links instead of broken ones.
 *
 * THE HOST HEADER IS ATTACKER-CONTROLLED, AND THAT IS THE TRADE-OFF.
 *
 * Deriving a link from the request is the classic host-header injection
 * vector: someone requests a password reset for your address with a forged
 * Host, and the email that lands in your inbox carries their domain. It is
 * worth being precise about why this is still the right default here.
 *
 *   - It only applies when NOTHING is configured. Setting `APP_URL` (or
 *     `CLIENT_ORIGIN`) disables this path completely, which is why the README
 *     tells a real deployment to set it and why `/api/health` reports it.
 *   - The alternative is not "a safe link". It is a link to localhost, which
 *     is 100% broken for 100% of recipients. A configuration mistake should
 *     degrade to something that works, not to something that cannot.
 *   - The forged value has to survive the proxy. Behind Vercel,
 *     `x-forwarded-host` is set by the platform from the hostname that was
 *     actually routed, so an arbitrary Host header does not reach here.
 *
 * A deployment that sends real password-reset mail to real users should set
 * `APP_URL`. This is the floor, not the recommendation.
 */

/** Hosts that are obviously not a public origin, so not worth preferring. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i;

/**
 * Origin of the request, as the browser that made it would write it.
 *
 * Returns null when there is no usable host — a server-to-server call with no
 * Host header, or a test harness that did not set one.
 *
 * Exported as `requestOrigin` because the CORS check in app.js needs exactly
 * this and not `publicOrigin`: it is asking "did this request arrive on the
 * origin the caller claims to be from", which has nothing to do with whether
 * APP_URL is configured. Folding in that fallback would make the answer depend
 * on unrelated configuration.
 */
function requestOrigin(req) {
  if (!req || typeof req.get !== 'function') return null;

  /*
   * `x-forwarded-host` before `host`, because behind a proxy `host` is the
   * internal one. Express's own `req.hostname` already reads the forwarded
   * header (the app sets `trust proxy`), but it drops the PORT, which matters
   * for anything not on 80/443 — including every local reverse-proxy setup.
   */
  const forwardedHost = req.get('x-forwarded-host');
  const host = (forwardedHost || req.get('host') || '').split(',')[0].trim();

  if (!host) return null;

  /*
   * A host header can carry anything, and this value goes into a URL that
   * someone will click. Anything outside the character set of a hostname and
   * port is refused rather than sanitised — a header with a slash or a space in
   * it is not a hostname that needs rescuing, it is someone trying to append
   * their own path to our link.
   */
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) return null;

  const protocol = (req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim();

  if (protocol !== 'http' && protocol !== 'https') return null;

  return `${protocol}://${host}`;
}

/**
 * Build an absolute URL for a path, for a link a human will click.
 *
 * @param {import('express').Request} req the request that triggered the link
 * @param {string} path an absolute path, e.g. `/accept-invite?token=…`
 */
function publicUrl(req, path) {
  return `${publicOrigin(req)}${path}`;
}

/** The origin `publicUrl` would use. Exported so `/api/health` can report it. */
function publicOrigin(req) {
  // Explicitly configured: always wins, and is the only path a deployment
  // handling real user mail should be relying on.
  if (env.appUrlConfigured) return env.appUrl;

  const derived = requestOrigin(req);

  /*
   * A localhost request with no configuration is a developer on their laptop,
   * where env.appUrl (which also points at localhost, but at the FRONTEND's
   * port rather than the API's) is the more useful answer. Deriving from the
   * request here would produce a link to the API port, where the accept page
   * is not served.
   */
  if (!derived || LOCAL_HOST.test(derived.replace(/^https?:\/\//, ''))) {
    return env.appUrl;
  }

  return derived;
}

module.exports = { publicUrl, publicOrigin, requestOrigin };
