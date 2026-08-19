const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const mongoose = require('mongoose');

const env = require('./config/env');
const { connectDB } = require('./config/db');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const ensureDb = require('./middleware/ensureDb');
const { issueCsrfToken, verifyCsrf } = require('./middleware/csrf');

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const customerRoutes = require('./routes/customerRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const aiSearchRoutes = require('./routes/aiSearchRoutes');
const auditRoutes = require('./routes/auditRoutes');

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
 */
const allowedOrigins = env.clientOrigin
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header = same-origin request, curl, or a server-to-server
      // call. Nothing to check.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);

      // Log rather than fail silently — a blocked origin is otherwise only
      // visible in the browser console, never in the server logs.
      // eslint-disable-next-line no-console
      console.warn(
        `[cors] Blocked origin "${origin}". Allowed: ${allowedOrigins.join(', ') || '(none)'}. ` +
          'Set CLIENT_ORIGIN if this origin should be permitted.'
      );
      return callback(null, false);
    },
    credentials: true,
  })
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
 * CSRF protection.
 *
 * Registered immediately after the cookie parser and before every route, so a
 * forged request is rejected before it can reach anything that acts on it.
 *
 * `issueCsrfToken` hands the browser a token; `verifyCsrf` requires it back in
 * a header on every state-changing, cookie-authenticated request. See
 * middleware/csrf.js for why this became necessary the moment the session moved
 * into cookies, and why requests using an Authorization header are exempt.
 */
app.use(issueCsrfToken);
app.use(verifyCsrf);

// Request logging — noise-free during tests.
if (!env.isTest) {
  app.use(morgan(env.isProduction ? 'combined' : 'dev'));
}

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

  // eslint-disable-next-line no-console
  console.error(
    `[config] Refusing ${req.method} ${req.originalUrl} — server is misconfigured: ` +
      env.configErrors.join(' | ')
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

// --- Error handling --------------------------------------------------------
// Registered last so they see errors from every route above.

app.use(notFound);
app.use(errorHandler);

module.exports = app;
