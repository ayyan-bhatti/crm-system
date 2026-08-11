const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const mongoose = require('mongoose');

const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const ensureDb = require('./middleware/ensureDb');

const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const customerRoutes = require('./routes/customerRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const aiSearchRoutes = require('./routes/aiSearchRoutes');

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

// --- Global middleware -----------------------------------------------------

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
app.get('/api/health', (req, res) => {
  const dbStates = ['disconnected', 'connected', 'connecting', 'disconnecting'];

  // A misconfigured deployment is still "up" enough to answer this, which is
  // the whole point: hit /api/health first and it names the problem.
  res.status(env.isConfigValid ? 200 : 500).json({
    success: env.isConfigValid,
    status: env.isConfigValid ? 'ok' : 'misconfigured',
    environment: env.nodeEnv,
    serverless: env.isServerless,
    database: dbStates[mongoose.connection.readyState] || 'unknown',
    // Names of missing variables only — never their values. Env var names are
    // not secrets, and having them here turns a blind 500 into a fix.
    configErrors: env.configErrors,
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

// --- Error handling --------------------------------------------------------
// Registered last so they see errors from every route above.

app.use(notFound);
app.use(errorHandler);

module.exports = app;
