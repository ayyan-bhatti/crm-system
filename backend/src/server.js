/**
 * Process entry point: connect to MongoDB, then start listening.
 *
 * Keeping this separate from app.js means the app can be tested without a
 * server socket or a real database.
 */
const app = require('./app');
const env = require('./config/env');
const { connectDB } = require('./config/db');
const { syncIndexesOnBoot } = require('./config/indexes');
const { componentLogger } = require('./config/logger');

const log = componentLogger('server');

async function start() {
  // env.js records configuration problems instead of exiting, because exiting
  // during module load on a serverless platform produces an unreadable crash.
  // A long-running server has no such constraint, so it fails fast here — the
  // errors were already printed in detail by config/env.js.
  if (!env.isConfigValid) {
    log.fatal(
      { configErrors: env.configErrors },
      'refusing to start with an invalid configuration'
    );
    process.exit(1);
  }

  // connectDB throws rather than exiting, so that the serverless path can turn
  // a database outage into a 503. Here — a long-running server that cannot
  // reach its database is not useful — we fail fast and let the process
  // manager restart us.
  try {
    await connectDB();
  } catch (err) {
    log.fatal({ err }, 'MongoDB connection failed');
    process.exit(1);
  }

  /*
   * Bring the indexes in line with the schemas before serving.
   *
   * Mongoose otherwise builds them lazily on first use, which means the first
   * queries after a deploy run unindexed — and, worse, that an index REMOVED
   * from a schema is never dropped from the database. Awaited so the server
   * does not start serving mid-build. It never throws; see config/indexes.js.
   */
  await syncIndexesOnBoot();

  const server = app.listen(env.port, () => {
    log.info({ port: env.port, environment: env.nodeEnv }, 'SimpleCRM API listening');
  });

  /**
   * A rejected promise nobody handled means the app is in an unknown state.
   * Close the server so in-flight requests finish, then exit and let the
   * process manager restart cleanly.
   */
  process.on('unhandledRejection', (err) => {
    log.fatal({ err }, 'unhandled rejection — shutting down');
    server.close(() => process.exit(1));
  });

  // Ctrl-C / container stop: shut down gracefully.
  process.on('SIGINT', () => server.close(() => process.exit(0)));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

start();
