/**
 * MongoDB connection helper.
 *
 * The test suite does NOT use this file — it spins up mongodb-memory-server and
 * connects Mongoose itself (see tests/setup.js). Keeping the connection logic
 * out of app.js is what makes that possible: `app` is just a request handler,
 * with no opinion about which database it is attached to.
 */
const mongoose = require('mongoose');
const env = require('./env');

// Return an error instead of hanging for 30s when the DB is unreachable.
mongoose.set('strictQuery', true);

async function connectDB() {
  try {
    const conn = await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
    // eslint-disable-next-line no-console
    console.log(`[db] MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
    return conn;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[db] MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }
}

async function disconnectDB() {
  await mongoose.connection.close();
}

module.exports = { connectDB, disconnectDB };
