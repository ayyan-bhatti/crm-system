const mongoose = require('mongoose');
const env = require('./env');

/**
 * Build the schema indexes deliberately, instead of letting Mongoose do it
 * lazily on first use.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Mongoose creates the indexes declared on a schema the first time the app
 * touches that collection. That sounds convenient and has two sharp edges in
 * production:
 *
 *   1. The first queries after a deploy run UNINDEXED, because the build has
 *      not finished. On a large collection that is the slowest the app will
 *      ever be, at exactly the moment people are checking whether the deploy
 *      worked.
 *   2. Index changes never actually land. Adding an index to a schema takes
 *      effect on the next cold start; REMOVING one does nothing at all —
 *      Mongoose does not drop indexes it no longer declares. The two unused
 *      text indexes removed earlier in this project would have stayed in the
 *      database forever, still being maintained on every write, despite being
 *      deleted from the code.
 *
 * `syncIndexes()` fixes both: it creates what is missing AND drops what is no
 * longer declared, so the database matches the schema rather than accumulating
 * whatever any past version happened to define.
 *
 * WHY THIS IS NOT RUN ON EVERY BOOT IN SERVERLESS
 *
 * `syncIndexes` is a potentially expensive operation — on a large collection an
 * index build takes real time. A long-running server pays that once at startup,
 * which is fine. A serverless platform cold-starts instances constantly, and
 * paying for an index check on each one would add latency to the first request
 * of every instance, forever, to do work that only needs doing once per deploy.
 *
 * So: the long-running server syncs at boot, and serverless deployments run
 * `npm run indexes` as a deploy step instead. Both paths use this same function,
 * so they cannot drift.
 */

/** Every model whose indexes this app owns. */
function models() {
  return mongoose.modelNames().map((name) => mongoose.model(name));
}

/**
 * Bring the database's indexes in line with the schemas.
 *
 * @param {{ quiet?: boolean }} [options]
 * @returns {Promise<Array<{ model: string, dropped: string[] }>>} what changed
 */
async function syncIndexes({ quiet = false } = {}) {
  const results = [];

  for (const Model of models()) {
    /*
     * Sequential rather than Promise.all.
     *
     * Index builds are I/O on the database, not on this process, and firing a
     * dozen at once at a small Atlas cluster is a good way to make a deploy
     * step look like an outage. They are quick individually; doing them in
     * order keeps the load predictable and the log readable.
     */
    const dropped = await Model.syncIndexes();
    results.push({ model: Model.modelName, dropped });

    if (!quiet && dropped.length) {
      console.log(
        `[indexes] ${Model.modelName}: dropped ${dropped.length} index(es) no longer in the schema — ${dropped.join(', ')}`
      );
    }
  }

  if (!quiet) {
    console.log(`[indexes] Synced ${results.length} collections with their schemas.`);
  }

  return results;
}

/**
 * The boot-time call.
 *
 * Skipped on serverless (see above) and in tests, where each file builds only
 * what it needs against a throwaway database. A failure here is logged but does
 * NOT stop the server: missing indexes make the app slow, while refusing to
 * start makes it unavailable, and the second is worse.
 */
async function syncIndexesOnBoot() {
  if (env.isTest) return;

  if (env.isServerless) {
    console.log(
      '[indexes] Skipping index sync on a serverless instance — run `npm run indexes` as a deploy step instead.'
    );
    return;
  }

  try {
    await syncIndexes();
  } catch (err) {
    console.error(
      `[indexes] Could not sync indexes: ${err.message}. The app will still run, but queries may be slower than expected.`
    );
  }
}

module.exports = { syncIndexes, syncIndexesOnBoot };
