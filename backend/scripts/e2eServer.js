
const path = require('path');

/*
 * Run from the backend directory, whatever launched this.
 *
 * mongodb-memory-server resolves its cached mongod binary relative to the
 * CURRENT WORKING DIRECTORY. Playwright starts this process from the frontend
 * folder, so without this the cache in backend/node_modules/.cache is invisible
 * and it silently re-downloads 600MB of MongoDB — which then blows the
 * start-up timeout and reports only "Timed out waiting for webServer", naming
 * nothing that would lead you here.
 *
 * Setting it in the script rather than in the Playwright config means the fix
 * holds however this is launched: by Playwright, by CI, or by hand.
 */
process.chdir(path.resolve(__dirname, '..'));

/*
 * ...and point mongodb-memory-server straight at the binary cache.
 *
 * The chdir above is necessary but, empirically, not sufficient: launched by
 * Playwright the library still resolved a different cache directory and started
 * downloading. Rather than keep guessing at its resolution rules, this states
 * the location outright. It is the same directory the Jest suite already
 * populated, so an end-to-end run reuses that download instead of fetching its
 * own copy.
 */
process.env.MONGOMS_DOWNLOAD_DIR =
  process.env.MONGOMS_DOWNLOAD_DIR ||
  path.resolve(__dirname, '..', 'node_modules', '.cache', 'mongodb-memory-server');

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

/**
 * A throwaway backend for the Playwright end-to-end tests.
 *
 * WHY A REAL SERVER RATHER THAN MOCKED NETWORK RESPONSES
 *
 * Playwright can intercept requests and answer them itself, which is faster and
 * much easier to set up. It would also miss the entire point of these tests.
 *
 * The riskiest work in this project is the auth rework: httpOnly cookies, the
 * CSRF double-submit, refresh rotation, and the order transaction. Every one of
 * those is an interaction BETWEEN the browser and the server — cookie
 * attributes the browser decides whether to honour, a header the client must
 * echo back, a transaction that must commit. Mocking the server would replace
 * exactly the half being tested with an assumption.
 *
 * So this boots the real Express app against a real (in-memory, single-node
 * replica set) MongoDB, seeded with known data. Nothing touches a development
 * database and nothing survives the process.
 */

const PORT = Number(process.env.E2E_PORT) || 5000;

/*
 * Set before requiring the app: config/env reads process.env at module load, so
 * anything assigned afterwards would be ignored.
 *
 * NODE_ENV is 'test' so the rate limiters stay off — an end-to-end run signs in
 * repeatedly from one address, which is precisely the traffic they reject.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'e2e-secret-not-used-outside-end-to-end-tests-000000';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
// No API key: the AI features take their documented fallback path, which is the
// behaviour to exercise anyway — the tests must not depend on a paid service.
process.env.ANTHROPIC_API_KEY = '';

/** The account the specs sign in with. Must satisfy the password policy. */
const SEED = {
  admin: {
    name: 'Ayesha Khan',
    email: 'e2e-admin@example.com',
    password: 'Karachi-Ledger-72',
    role: 'admin',
  },
  // Exercises the phase-4 RBAC extension: a manager reaches /approvals and
  // sees buyer-initiated requests, filtered server-side from the same
  // colleague-request queue an admin sees in full.
  manager: {
    name: 'Bilal Ahmed',
    email: 'e2e-manager@example.com',
    password: 'Lahore-Ledger-53',
    role: 'manager',
  },
  customer: {
    name: 'Karachi Traders',
    email: 'contact@karachitraders.example',
    city: 'Karachi',
    status: 'active',
  },
  product: {
    name: 'Blue Widget',
    sku: 'E2E-BW-1',
    price: 25,
    stockQty: 40,
    category: 'Widgets',
    // Seeded so the storefront grid renders a real image rather than the
    // generated "no photo yet" placeholder — the specs assert on product
    // cards, and a placeholder is a correct but less representative render.
    imageUrl: 'https://picsum.photos/seed/e2e-bw-1/480/480',
    description: 'A dependable blue widget, used by the end-to-end specs.',
  },
};

async function main() {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URI = mongo.getUri();

  const app = require('../src/app');
  const User = require('../src/models/User');
  const Customer = require('../src/models/Customer');
  const Product = require('../src/models/Product');

  await mongoose.connect(process.env.MONGO_URI);

  // Indexes are built lazily on first use, so build them up front — otherwise
  // the very first request of the run pays for it and can look like a hang.
  await Promise.all([User.init(), Customer.init(), Product.init()]);

  const admin = await User.create(SEED.admin);
  await User.create(SEED.manager);
  await Customer.create({ ...SEED.customer, createdBy: admin._id, assignedTo: admin._id });
  await Product.create(SEED.product);

  const server = app.listen(PORT, () => {
    // Playwright waits for the port, but this line makes a failed boot obvious
    // in the log rather than showing only a timeout.
    console.log(`[e2e] backend listening on ${PORT} with a throwaway database`);
  });

  const shutdown = async () => {
    server.close();
    await mongoose.disconnect();
    await mongo.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[e2e] failed to start:', err);
  process.exit(1);
});

module.exports = { SEED };
