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

// The React dev server runs on a different origin, so CORS must allow it.
// `credentials` is on for forward-compatibility if auth ever moves to cookies.
app.use(cors({ origin: env.clientOrigin, credentials: true }));

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
  res.json({
    success: true,
    status: 'ok',
    environment: env.nodeEnv,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date(),
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
