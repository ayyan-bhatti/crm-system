const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const { ACCESS_COOKIE } = require('../utils/cookies');

/**
 * CSRF protection for the cookie-based session.
 *
 * WHY THIS IS SUDDENLY NECESSARY
 *
 * It was not needed when the token lived in localStorage, because the app had
 * to attach it deliberately on every request and an attacker's page could not
 * do that. Cookies are different: the browser sends them automatically with any
 * request to this origin, including one triggered by evil.com. Without a check,
 * a hidden form on any site the user visits could POST to /api/orders and the
 * browser would helpfully authenticate it.
 *
 * So moving to cookies (Phase 1.1) *created* this problem, and this middleware
 * is the other half of that change rather than an unrelated addition.
 *
 * THE MECHANISM: double-submit cookie
 *
 *   1. The server issues a random value in a NON-httpOnly cookie.
 *   2. The frontend reads it and echoes it back in the X-CSRF-Token header.
 *   3. The server requires the two to match.
 *
 * An attacker's page can *cause* the cookie to be sent, but the same-origin
 * policy stops it from ever *reading* the value, so it cannot produce the
 * matching header. That asymmetry — sendable but not readable — is the whole
 * trick.
 *
 * WHY THIS COOKIE IS DELIBERATELY NOT httpOnly
 *
 * It looks like a mistake next to the session cookies, so it is worth being
 * explicit: the frontend has to read this one, or it could not send the header.
 * That is safe because the value is not a credential. On its own it grants
 * nothing — it only proves the request came from code running on our origin.
 *
 * WHY NOT THE `csurf` PACKAGE
 *
 * It has been deprecated and unmaintained since 2022. This is about forty lines
 * of well-understood logic, and vendoring it means no dependency that quietly
 * stops receiving security fixes.
 *
 * DEFENCE IN DEPTH
 *
 * SameSite=Lax on the session cookies already blocks the cross-site POST this
 * defends against, in every browser that honours it. This is the second layer,
 * for the cases SameSite does not cover: an older browser, a same-site
 * subdomain that has been compromised, or a future deployment forced to set
 * SameSite=None because the API and frontend end up on genuinely different
 * sites.
 */

const CSRF_COOKIE = 'simplecrm_csrf';
const CSRF_HEADER = 'x-csrf-token';

/**
 * Methods that cannot change state, and so need no protection.
 *
 * CSRF is about forged *writes*. A forged GET is not interesting because the
 * attacker still cannot read the response (the same-origin policy again), and
 * requiring a token on GET would break ordinary navigation.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Issue the CSRF cookie if the browser does not already have one.
 *
 * Runs on every request rather than only at login, so a token that expires or
 * is cleared mid-session is replaced silently instead of turning into a wall of
 * 403s the user cannot get past without logging out.
 */
function issueCsrfToken(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE]) {
    const token = crypto.randomBytes(32).toString('hex');

    res.cookie(CSRF_COOKIE, token, {
      // Readable by JavaScript on purpose — see the note above.
      httpOnly: false,
      secure: env.cookieSecure,
      sameSite: env.cookieSameSite,
      path: '/',
    });

    // Make it visible to the current request too, so a client that logs in and
    // immediately writes does not fail its first attempt.
    req.cookies = { ...req.cookies, [CSRF_COOKIE]: token };
    res.locals.csrfToken = token;
  }

  return next();
}

/** Constant-time comparison, so the check cannot be timed to leak the token. */
function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * Reject a state-changing request whose CSRF header does not match its cookie.
 *
 * THE IMPORTANT EXEMPTION: requests authenticated by an `Authorization` header
 * rather than a cookie are skipped. This is not a loophole — it is the point.
 * CSRF exists because cookies are attached *automatically*; a bearer header has
 * to be set deliberately by the caller, and an attacker's cross-origin page
 * cannot set headers on a request the browser makes on its behalf. Demanding a
 * CSRF token from a script or a mobile client that never had a cookie would be
 * ceremony with no security value.
 *
 * The test for "is this a cookie-authenticated request" is the presence of the
 * access cookie, checked here rather than relying on `req.authVia`, because
 * this middleware runs before `protect` — a forged request must be rejected
 * before it reaches anything that acts on it.
 */
function verifyCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const usedBearer = (req.headers.authorization || '').startsWith('Bearer ');
  if (usedBearer) return next();

  // Not authenticated by cookie at all — e.g. login itself, before any session
  // exists. There is no session to ride, so there is nothing to forge.
  if (!req.cookies?.[ACCESS_COOKIE]) return next();

  const cookieToken = req.cookies[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    throw ApiError.forbidden(
      'CSRF check failed. Reload the page and try again — if this keeps happening, ' +
        'your browser may be blocking cookies for this site.'
    );
  }

  return next();
}

module.exports = {
  CSRF_COOKIE,
  CSRF_HEADER,
  issueCsrfToken,
  verifyCsrf,
};
