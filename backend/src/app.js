const express = require('express');
const cors = require('cors');
const { requestOrigin } = require('./utils/publicUrl');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const mongoose = require('mongoose');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const ensureDb = require('./middleware/ensureDb');
const { issueCsrfToken, verifyCsrf } = require('./middleware/csrf');
const { requestLogger } = require('./middleware/requestLogger');
const { componentLogger } = require('./config/logger');

const log = componentLogger('http');

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const customerRoutes = require('./routes/customerRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const aiSearchRoutes = require('./routes/aiSearchRoutes');
const auditRoutes = require('./routes/auditRoutes');
const internalRoutes = require('./routes/internalRoutes');
const changeRequestRoutes = require('./routes/changeRequestRoutes');
const shopRoutes = require('./routes/shopRoutes');
const contactRoutes = require('./routes/contactRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const automationRoutes = require('./routes/automationRoutes');
const cronRoutes = require('./routes/cronRoutes');
const unsubscribeRoutes = require('./routes/unsubscribeRoutes');

/**
 * The Express application.
 *
 * This module builds and exports the app but never listens on a port. That one
 * decision lets the same file serve three runtimes:
 *
 *   src/server.js   imports it, connects, and listens        (local / any host)
 *   tests/          import it and point it at in-memory Mongo (Jest)
 *   Vercel          imports it directly as the service entrypoint, and wraps
 *                   the exported app in a Function — see vercel.json
 *
 * Because Vercel treats the default export as the whole application, this file
 * is the deployment entrypoint; anything a request needs must be wired up here
 * rather than in server.js, which Vercel never runs.
 */
const app = express();

/**
 * Trust the platform's proxy.
 *
 * Vercel (like any hosted platform) terminates TLS at its edge and forwards the
 * request over HTTP, setting X-Forwarded-For and X-Forwarded-Proto. Without
 * this setting Express reports the proxy's address as `req.ip` — which would
 * make per-IP rate limiting count every visitor as the same client — and treats
 * the connection as insecure, which suppresses Secure cookies.
 *
 * `1` rather than `true`: trusting only the single closest proxy means a client
 * cannot spoof its own address by sending its own X-Forwarded-For header.
 */
app.set('trust proxy', 1);

/*
 * Request id + structured request log, FIRST.
 *
 * Before helmet, CORS and body parsing, so that a request rejected by any of
 * them still gets an id and still appears in the log. A request that fails at
 * the CORS layer and leaves no trace is precisely the one somebody will need to
 * find later.
 */
app.use(requestLogger);

// --- Global middleware -----------------------------------------------------

/**
 * Security headers.
 *
 * Registered first, so that even a response produced by an error further down
 * still carries them.
 *
 * WHAT THIS CSP DOES AND DOES NOT COVER — the important caveat.
 *
 * This app is deployed as two Vercel services: the API (this Express app) and
 * the static frontend. A header set here applies only to API responses, which
 * are JSON. It does NOT reach the HTML the browser actually renders — that is
 * served by the frontend service, so the CSP protecting the *app* is declared
 * in vercel.json instead. Setting a strict CSP here and assuming the SPA is
 * covered is an easy and completely silent mistake, so both halves exist and
 * both are commented.
 *
 * What this policy is for, then, is the API's own responses: a JSON endpoint
 * has no legitimate reason to load a script, embed a frame, or be framed by
 * anyone, so everything is denied. If an endpoint were ever tricked into
 * reflecting HTML, the browser would refuse to execute it.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        // A JSON API needs no resources at all. Deny by default, allow nothing.
        defaultSrc: ["'none'"],
        // Blocks clickjacking: no page may put an API response in a frame.
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        // Only meaningful in production, where HTTPS actually exists.
        ...(env.isProduction ? {} : { upgradeInsecureRequests: null }),
      },
    },

    /*
     * HSTS: tell the browser to use HTTPS for this domain for a year, so a
     * later plain-http request is upgraded before it leaves the machine and
     * cannot be intercepted. Off outside production, where there is no HTTPS
     * and pinning localhost to it would make the app unreachable — a genuinely
     * unpleasant mistake, because the browser remembers it for a year.
     */
    hsts: env.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,

    /*
     * Send the origin but not the path on cross-origin navigations. Record ids
     * live in our URLs (/customers/652f...), and a full Referer would leak them
     * to any third-party site a user clicks through to.
     */
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

    /*
     * The frontend and API share an origin in production and are proxied
     * together in development, so nothing legitimate loads API responses as a
     * subresource from elsewhere.
     */
    crossOriginResourcePolicy: { policy: 'same-site' },
  })
);

/**
 * CORS.
 *
 * Worth being precise about what this does and does not affect in production:
 * behind the Vercel rewrites the frontend and the API share one origin, so the
 * browser sends no `Origin` header, no preflight happens, and this middleware
 * is never the thing that blocks a request. A wrong CLIENT_ORIGIN therefore
 * cannot produce a 500 — it can only ever surface as a browser console CORS
 * error on a *cross-origin* caller.
 *
 * It still matters for: local development (Vite on :5173 → API on :5000), and
 * any separate client. A comma-separated list is accepted so preview
 * deployments can be allowed alongside production.
 *
 * When CLIENT_ORIGIN is not set at all, an origin matching the host the request
 * arrived on is also allowed — see the note inside. Without that, a deployment
 * whose frontend is on a different origin from the API is refused by the
 * localhost default, and the page sees only "Network Error".
 */
const allowedOrigins = env.clientOrigin
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * The options-DELEGATE form of `cors`, rather than a plain options object.
 *
 * The `origin` callback in the object form is only handed the origin string,
 * and the check below needs the request as well — to compare the caller's
 * origin against the host this request actually arrived on. The delegate form
 * is the supported way to see it.
 */
app.use(
  cors((req, done) => {
    const origin = req.headers.origin;

    /** Answer the way the object form would have. */
    const allow = (permitted) => done(null, { origin: permitted, credentials: true });

    // No Origin header = same-origin request, curl, or a server-to-server
    // call. Nothing to check.
    if (!origin) return allow(true);
    if (allowedOrigins.includes(origin)) return allow(true);

    /*
     * NOT CONFIGURED, AND THE CALLER IS THIS DEPLOYMENT ITSELF.
     *
     * CLIENT_ORIGIN defaults to http://localhost:5173. On a deployment where
     * nobody set it, that default is the entire allow-list, so a browser on
     * the real domain is refused — and a CORS refusal is invisible to the
     * page that made the request. Axios reports the literal string "Network
     * Error" with no status and no body, which is indistinguishable from the
     * server being down and tells the user nothing.
     *
     * Allowing an origin that matches the host the request arrived on fixes
     * that without widening anything: it is the same origin the browser would
     * have reached us on, so permitting it grants no access that a
     * same-origin request did not already have. A genuinely foreign origin
     * still does not match, and is still refused.
     *
     * Only when unconfigured. An explicit CLIENT_ORIGIN is an allow-list the
     * operator wrote, and is honoured exactly as written.
     */
    if (!process.env.CLIENT_ORIGIN && origin === requestOrigin(req)) {
      return allow(true);
    }

    // Log rather than fail silently — a blocked origin is otherwise only
    // visible in the browser console, never in the server logs.
    log.warn(
      { origin, allowedOrigins },
      'blocked a cross-origin request — set CLIENT_ORIGIN if this origin should be permitted'
    );
    return allow(false);
  })
);

/**
 * THE STRIPE WEBHOOK, MOUNTED BEFORE THE JSON PARSER. THIS ORDER IS LOAD-BEARING.
 *
 * Stripe signs the exact bytes it sends. `express.json()` consumes the request
 * stream and hands the route a parsed object, and re-serialising that object
 * produces different bytes — different key order, different whitespace,
 * different unicode escaping — so the computed signature would never match the
 * one in the header. Every event would be rejected as a forgery, silently, and
 * the only symptom would be that paid orders never appear.
 *
 * `express.raw` gives the handler a Buffer, which is what
 * `stripe.webhooks.constructEvent` needs. It is scoped to this one path, so
 * every other route still gets the parsed body it expects.
 *
 * Three other things follow from putting it here, all deliberate:
 *
 *   - It is ABOVE the CSRF pair. Stripe is a server, holds no cookie, and could
 *     not present a CSRF token; the signature IS its authentication, and it is a
 *     stronger one.
 *   - It is above the config guard, so `ensureDb` is applied explicitly here.
 *     A webhook arriving at a misconfigured deployment should fail loudly and be
 *     retried by Stripe rather than be swallowed by a generic 500 page.
 *   - It does NOT live in routes/shopRoutes.js with the rest of the storefront,
 *     because that router applies the buyer CSRF middleware to everything under
 *     it. The mount is here, the handler is in a controller like every other.
 */
app.post(
  '/api/shop/stripe/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  ensureDb,
  require('./controllers/stripeWebhookController').handleStripeWebhook
);

// Parse JSON request bodies (with a sane size cap).
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/**
 * Parse cookies into `req.cookies`.
 *
 * The session lives in two httpOnly cookies (see utils/cookies.js), so nothing
 * below this line can authenticate a browser request without it. Registered
 * before the routes for that reason.
 */
app.use(cookieParser());

/**
 * CSRF protection — the STAFF session's half of it.
 *
 * Registered immediately after the cookie parser and before every route, so a
 * forged request is rejected before it can reach anything that acts on it.
 *
 * `issueCsrfToken` hands the browser a token; `verifyCsrf` requires it back in
 * a header on every state-changing, cookie-authenticated request. See
 * middleware/csrf.js for why this became necessary the moment the session moved
 * into cookies, and why requests using an Authorization header are exempt.
 *
 * EXCLUDED FROM `/api/shop`, DELIBERATELY.
 *
 * `verifyCsrf` decides "is this cookie-authenticated" by checking for the
 * staff access cookie — and that cookie's path is `/`, so the browser attaches
 * it to a `/api/shop/...` request too, the moment a person also has a staff
 * session open (a manager previewing the storefront, say). Without this
 * exclusion, that combination made every buyer write demand the STAFF CSRF
 * header as well as the buyer's own — one track's session silently imposing
 * a requirement on the other, discovered by a test asserting the two tracks
 * can coexist. `/api/shop` has its own complete CSRF pair
 * (`middleware/shopCsrf.js`, mounted in `routes/shopRoutes.js`); this one has
 * no business there at all.
 *
 * EXCLUDED FROM `/api/unsubscribe` TOO, for a different reason.
 *
 * CSRF is an attack on AMBIENT authority — a credential the browser attaches
 * by itself, which somebody else's page can therefore ride. The unsubscribe
 * endpoint has none: it is authorised entirely by a signed token carried in
 * the request, which an attacker would have to already hold — and if they hold
 * it they have the recipient's address and no need for the recipient's
 * browser. Without this exclusion, a staff member who happened to be signed in
 * to the CRM could not click the unsubscribe link in their own copy of a
 * marketing email, because the browser would attach the staff cookie and the
 * check would then demand a header a mail client cannot send.
 */
const CSRF_EXEMPT = ['/api/shop', '/api/unsubscribe'];
const csrfExempt = (req) => CSRF_EXEMPT.some((prefix) => req.path.startsWith(prefix));

app.use((req, res, next) => (csrfExempt(req) ? next() : issueCsrfToken(req, res, next)));
app.use((req, res, next) => (csrfExempt(req) ? next() : verifyCsrf(req, res, next)));

/*
 * morgan is gone: middleware/requestLogger replaces it.
 *
 * They overlap, and morgan's line is prose — it cannot carry the request id,
 * the user, or the route pattern, and nothing can filter it. Running both would
 * mean two lines per request saying the same thing in two formats.
 */

// --- Routes ----------------------------------------------------------------

/**
 * Liveness probe — handy for deployment checks.
 *
 * Deliberately declared BEFORE the database middleware, so it answers even when
 * the database is unreachable. A health check that fails for the same reason as
 * everything else tells you nothing about where the problem is.
 */
app.get('/api/health', async (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  let database = dbStates[mongoose.connection.readyState] || 'unknown';
  let databaseError = null;

  /*
   * Actively probe the database rather than just reporting the current state.
   *
   * This endpoint sits before the ensureDb middleware so that it still answers
   * when the database is unreachable. The side effect is that on a cold
   * serverless instance nothing has opened a connection yet, so a passive read
   * of readyState reports "disconnected" even when everything is perfectly
   * healthy — exactly the wrong answer for the one endpoint people check after
   * a deploy. Probing here makes the report mean what it says.
   */
  if (env.isConfigValid && mongoose.connection.readyState !== 1) {
    try {
      await connectDB();
      database = 'connected';
    } catch (err) {
      database = 'error';
      databaseError = err.message;
    }
  }

  const healthy = env.isConfigValid && database === 'connected';
  // 500 = cannot start (config), 503 = configured but a dependency is down.
  const statusCode = env.isConfigValid ? (healthy ? 200 : 503) : 500;

  res.status(statusCode).json({
    success: healthy,
    status: healthy ? 'ok' : env.isConfigValid ? 'degraded' : 'misconfigured',
    environment: env.nodeEnv,
    serverless: env.isServerless,
    database,
    // Names of missing variables only — never their values. Env var names are
    // not secrets, and having them here turns a blind 500 into a fix.
    configErrors: env.configErrors,
    /*
     * WHETHER THIS DEPLOYMENT CAN TAKE A CARD, and whether it can confirm one.
     *
     * The README has claimed for two rounds that "`GET /api/health` reports it".
     * It did not. That mattered more than a stale sentence usually does,
     * because the symptom it diagnoses — the storefront showing "Pay by card
     * (unavailable)" — has exactly one cause, an unset key, and no way to
     * confirm it from the outside. The alternative was reading the shop's
     * checkout page and inferring backwards.
     *
     * Booleans, never the keys themselves. `cardPayment` is the secret key,
     * which is what gates the button. `webhookVerification` is the webhook
     * secret, and the two being different is the dangerous state the boot
     * warning already covers: the buyer pays, the event cannot be verified, and
     * no order is ever created.
     */
    payments: {
      cardPayment: env.stripeEnabled,
      webhookVerification: Boolean(env.stripeWebhookSecret),
    },

    /*
     * The messaging channels, reported for exactly the reason `payments` is.
     *
     * `available` is true for all three always — every channel works through
     * its console transport with nothing configured, and saying otherwise
     * would hide a path that genuinely delivers (to the log) and is what makes
     * this whole feature demonstrable with no accounts.
     *
     * `live` is the one that matters operationally: whether a real provider is
     * wired up. A campaign reporting "sent to 400" while `live` is false has
     * written four hundred log lines, which is the correct behaviour and a
     * catastrophic misunderstanding if somebody thinks it is otherwise.
     *
     * `scheduler` says whether the post-sale cron can authenticate at all.
     * Unset, the endpoint refuses everything and the automations silently
     * never run — the failure with no symptom, which is why it is here.
     */
    messaging: {
      ...require('./services/messagingService').channelStatus(),
      scheduler: { configured: Boolean(env.cronSecret) },
    },

    /*
     * Courier tracking. `trackingLinks` is always true — a public tracking-page
     * link needs no configuration for any courier. `easypostLive` and
     * `dhlLive` say whether a "Check live status" button will actually answer
     * — EasyPost is tried first (works for any courier, including its
     * test-mode magic tracking codes), DHL is the fallback. See
     * services/courierService.js.
     */
    courier: {
      trackingLinks: true,
      easypostLive: require('./services/courierService').isEasyPostLiveConfigured(),
      dhlLive: require('./services/courierService').isDhlLiveConfigured(),
    },
    ...(databaseError ? { databaseError } : {}),
    timestamp: new Date(),
  });
});

/**
 * Refuse to serve anything that needs configuration we do not have.
 *
 * Without this, a missing JWT_SECRET surfaces as a confusing failure deep in a
 * controller (or, previously, as a process exit during module load that took
 * the whole function down with no message). Failing here is explicit, logged,
 * and points at /api/health.
 */
app.use((req, res, next) => {
  if (env.isConfigValid) return next();

  log.error(
    { req: { method: req.method, url: req.originalUrl }, configErrors: env.configErrors },
    'refusing request — the server is misconfigured'
  );

  return res.status(500).json({
    success: false,
    message:
      'Server is misconfigured and cannot handle requests. ' +
      'GET /api/health for details, and check the deployment logs.',
    configErrors: env.configErrors,
  });
});

/**
 * Everything below needs the database. On a long-running server this passes
 * straight through (server.js already connected); on serverless it opens the
 * connection on the first request into a cold instance. See middleware/ensureDb.
 */
app.use(ensureDb);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/ai-search', aiSearchRoutes);
app.use('/api/audit-logs', auditRoutes);
app.use('/api/internal', internalRoutes);
app.use('/api/change-requests', changeRequestRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/unsubscribe', unsubscribeRoutes);
app.use('/api/cron', cronRoutes);

// --- Error handling --------------------------------------------------------
// Registered last so they see errors from every route above.

app.use(notFound);
app.use(errorHandler);

module.exports = app;
