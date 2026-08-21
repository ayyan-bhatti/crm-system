/**
 * MongoDB connection helper.
 *
 * This has to serve two very different runtimes:
 *
 *   Long-running server (npm run dev / start)
 *     One process, one connection, opened once at boot.
 *
 *   Serverless function (Vercel)
 *     The module is evaluated once per cold start, then the same instance
 *     handles many requests, and several instances may exist at once. Calling
 *     mongoose.connect() per request would open a new connection every time and
 *     exhaust the database's connection limit within minutes.
 *
 * The cached promise below is what makes the second case safe: the first
 * request through a cold instance starts the connection, every later request on
 * that instance reuses it, and concurrent requests during startup all await the
 * same promise rather than racing to open their own.
 *
 * The test suite does NOT use this file — it starts mongodb-memory-server and
 * connects Mongoose itself (tests/setup.js). Keeping connection logic out of
 * app.js is what makes that possible: `app` is just a request handler, with no
 * opinion about which database it is attached to.
 */
const mongoose = require('mongoose');
const env = require('./env');
const { componentLogger } = require('./logger');

const log = componentLogger('db');

// Return an error instead of hanging for 30s when the DB is unreachable.
mongoose.set('strictQuery', true);

/** The in-flight or settled connection promise for this process. */
let connectionPromise = null;

/**
 * Connect, or hand back the existing connection.
 *
 * Throws on failure rather than exiting the process — a serverless function
 * that exits takes the whole instance down and turns a recoverable database
 * blip into a hard outage. The caller decides what to do: the long-running
 * server exits, the request path returns a 500.
 */
async function connectDB() {
  // 1 = connected. Already good, nothing to do.
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(env.mongoUri, {
        serverSelectionTimeoutMS: 10000,
        // Serverless instances are many and short-lived, so each one should
        // hold only a small pool rather than the default.
        maxPoolSize: env.isProduction ? 5 : 10,
      })
      .then((conn) => {
        log.info(
          { host: conn.connection.host, database: conn.connection.name },
          'MongoDB connected'
        );
        return conn.connection;
      })
      .catch((err) => {
        // Clear the cache so the next request retries instead of being handed
        // a permanently rejected promise.
        connectionPromise = null;
        throw err;
      });
  }

  return connectionPromise;
}

async function disconnectDB() {
  connectionPromise = null;
  await mongoose.connection.close();
}

module.exports = { connectDB, disconnectDB };
