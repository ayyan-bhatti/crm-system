const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

/**
 * Test database lifecycle.
 *
 * Registered via `setupFilesAfterEnv` in package.json, so this runs once per
 * test file. Each file therefore gets its own throwaway MongoDB, spun up in
 * memory — the suite never touches a real database and leaves nothing behind.
 *
 * A SINGLE-NODE REPLICA SET, NOT A STANDALONE SERVER
 *
 * This used to be `MongoMemoryServer`, which starts a standalone `mongod`.
 * Standalone MongoDB does not support transactions at all, so every test of the
 * transactional order path would either fail with "Transaction numbers are only
 * allowed on a replica set member" or, worse, silently exercise the
 * non-transactional fallback and report that the transactions work.
 *
 * A one-node replica set is the smallest configuration that supports them. It
 * costs a few seconds of extra start-up per test file, which is the right price
 * for tests that exercise the same code path production does — MongoDB Atlas,
 * including the free tier, is also a replica set.
 *
 * Collections are cleared between individual tests rather than dropped and
 * recreated: it is much faster, and it keeps the indexes (including the unique
 * ones on User.email and Product.sku) in place so tests can rely on them.
 */

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
