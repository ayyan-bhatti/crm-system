
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

/*
 * NO AI IN THE END-TO-END RUN. THIS LINE MAKES THAT TRUE RATHER THAN ASSUMED.
 *
 * storefront.spec.js has always documented that "GEMINI_API_KEY is unset in the
 * e2e environment (see e2eServer.js)" and asserted on the documented
 * `mode: 'fallback'` path accordingly. Nothing here actually unset it. What was
 * really happening is that `backend/.env` carries a real key for manual local
 * testing, so every end-to-end run was making live model calls — and the
 * fallback assertions passed only because that key's daily free-tier quota
 * happened to be exhausted. The day the quota reset, the search test started
 * failing with "Results for" instead of "Showing keyword matches for", which is
 * the AI path working correctly.
 *
 * A test suite whose outcome depends on somebody else's rate limit is not a
 * test suite. It also meant every run spent real quota, slowly, invisibly.
 *
 * Set to an EMPTY STRING rather than deleted: `config/env.js` runs dotenv,
 * which only fills in keys that are absent from `process.env`. Deleting the key
 * would let the value in `.env` take its place; assigning an empty one is
 * present-but-falsy, which is exactly what `env.geminiApiKey` treats as
 * unconfigured.
 */
process.env.GEMINI_API_KEY = '';

/*
 * Stripe is left unconfigured for the same reason, and the storefront spec
 * asserts on that: an end-to-end run must not depend on a payment processor
 * being reachable, and the card path's real behaviour is covered exhaustively
 * at the API level in tests/stripeCheckout.test.js with Stripe stubbed.
 */
process.env.STRIPE_SECRET_KEY = '';
process.env.STRIPE_WEBHOOK_SECRET = '';

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
  /*
   * A sales rep, added in round 3 so the end-to-end run can prove all THREE
   * staff roles still work after the CRM's visual update — which the round's
   * definition of done asks for by name. A rep is also the only role whose
   * access is record-scoped rather than role-scoped (they see the orders
   * assigned to them and nothing else), so it is the one that a UI change can
   * break in a way the other two would not reveal.
   */
  rep: {
    name: 'Sara Iqbal',
    email: 'e2e-rep@example.com',
    password: 'Multan-Ledger-64',
    role: 'sales_rep',
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
    imageUrl: 'https://loremflickr.com/480/480/widget?lock=4211',
    description: 'A dependable blue widget, used by the end-to-end specs.',
  },
  /*
   * A product WITH variants, alongside the one without.
   *
   * Both shapes are seeded deliberately. A catalogue where every product has
   * colours would exercise only the variant path and would quietly stop
   * proving that the pre-variant path — which every existing product in a real
   * deployment is on — still works. "Sold out in one colour" is included so the
   * storefront's disabled-swatch state has something real to render.
   */
  variantProduct: {
    name: 'Trail Jacket',
    sku: 'E2E-TJ-1',
    price: 80,
    category: 'Outerwear',
    imageUrl: 'https://loremflickr.com/480/480/jacket?lock=8823',
    description: 'A weatherproof jacket, sold in two colours.',
    variants: [
      { color: { name: 'Midnight', hex: '#111827' }, size: 'M', stockQty: 6 },
      { color: { name: 'Sand', hex: '#d6c7a1' }, size: 'M', stockQty: 0 },
    ],
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
  await User.create(SEED.rep);
  await Customer.create({ ...SEED.customer, createdBy: admin._id, assignedTo: admin._id });
  await Product.create(SEED.product);
  // `create`, not `insertMany`, so the pre-save hook that keeps `stockQty`
  // equal to the sum of the variants actually runs.
  await Product.create(SEED.variantProduct);

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
