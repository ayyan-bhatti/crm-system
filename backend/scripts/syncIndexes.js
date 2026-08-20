/**
 * Deploy step: bring the database's indexes in line with the schemas.
 *
 *   npm run indexes
 *
 * Run this after deploying, before (or just after) the new code starts serving.
 * It is idempotent and safe to run repeatedly — an index that already matches
 * its schema is left alone.
 *
 * This exists because serverless instances deliberately skip the index sync at
 * boot: cold starts are frequent, and paying for an index check on each one
 * would add latency to the first request of every instance to do work that only
 * needs doing once per deploy. See src/config/indexes.js.
 */
const path = require('path');

// Resolve the app's modules regardless of where this was invoked from.
process.chdir(path.resolve(__dirname, '..'));

const mongoose = require('mongoose');
const env = require('./../src/config/env');
const { connectDB, disconnectDB } = require('./../src/config/db');
const { syncIndexes } = require('./../src/config/indexes');

// Loading the models is what registers them with Mongoose — `syncIndexes`
// iterates the registry, so a model nobody required would be silently skipped.
require('./../src/models/User');
require('./../src/models/Customer');
require('./../src/models/Product');
require('./../src/models/Order');
require('./../src/models/AuditLog');
require('./../src/models/RefreshToken');
require('./../src/models/IdempotencyKey');

async function main() {
  if (!env.isConfigValid) {
    console.error('[indexes] Refusing to run with an invalid configuration (see above).');
    process.exit(1);
  }

  await connectDB();
  console.log(`[indexes] Connected to ${mongoose.connection.name}. Syncing…`);

  const results = await syncIndexes();

  const droppedTotal = results.reduce((total, r) => total + r.dropped.length, 0);
  console.log(
    `[indexes] Done. ${results.length} collections checked, ${droppedTotal} stale index(es) removed.`
  );

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(`[indexes] Failed: ${err.message}`);
  // A failed index sync must exit non-zero so a deploy pipeline notices.
  process.exit(1);
});
