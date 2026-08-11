/**
 * Process entry point: connect to MongoDB, then start listening.
 *
 * Keeping this separate from app.js means the app can be tested without a
 * server socket or a real database.
 */
const app = require('./app');
const env = require('./config/env');
const { connectDB } = require('./config/db');

async function start() {
  // connectDB throws rather than exiting, so that the serverless path can turn
  // a database outage into a 503. Here — a long-running server that cannot
  // reach its database is not useful — we fail fast and let the process
  // manager restart us.
  try {
    await connectDB();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[db] MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] SimpleCRM API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  });

  /**
   * A rejected promise nobody handled means the app is in an unknown state.
   * Close the server so in-flight requests finish, then exit and let the
   * process manager restart cleanly.
   */
  process.on('unhandledRejection', (err) => {
    // eslint-disable-next-line no-console
    console.error('[server] Unhandled rejection — shutting down:', err);
    server.close(() => process.exit(1));
  });

  // Ctrl-C / container stop: shut down gracefully.
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

start();
