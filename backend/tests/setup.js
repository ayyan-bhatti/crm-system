const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/**
 * Test database lifecycle.
 *
 * Registered via `setupFilesAfterEnv` in package.json, so this runs once per
 * test file. Each file therefore gets its own throwaway MongoDB, spun up in
 * memory — the suite never touches a real database and leaves nothing behind.
 *
 * Collections are cleared between individual tests rather than dropped and
 * recreated: it is much faster, and it keeps the indexes (including the unique
 * ones on User.email and Product.sku) in place so tests can rely on them.
 */

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
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
