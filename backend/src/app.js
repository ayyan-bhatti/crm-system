const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const env = require('./config/env');
const { notFound, errorHandler } = require('./middleware/errorHandler');

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
 * This module builds and exports the app but never listens on a port and never
 * connects to a database. src/server.js does both for real runs; the test suite
 * imports this file and points it at an in-memory MongoDB instead.
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

/** Liveness probe — handy for deployment checks. */
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', environment: env.nodeEnv, timestamp: new Date() });
});

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
