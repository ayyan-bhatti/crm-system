const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/User');
const Customer = require('../src/models/Customer');
const Product = require('../src/models/Product');
const Buyer = require('../src/models/Buyer');
const { signToken } = require('../src/utils/token');
const { ROLES } = require('../src/config/constants');

/**
 * Factories shared by the test files.
 *
 * Users are created straight through the model rather than through
 * POST /api/auth/register, because registration deliberately makes the *first*
 * account an admin — going through the API would make every test depend on the
 * order accounts happen to be created in. Here a test asks for the role it
 * wants and gets exactly that.
 */

const api = () => request(app);

// Keeps generated emails unique within a file without the caller having to care.
let sequence = 0;

async function createUser(role = ROLES.SALES_REP, overrides = {}) {
  sequence += 1;

  const user = await User.create({
    name: overrides.name || `Test ${role} ${sequence}`,
    email: overrides.email || `${role}${sequence}@test.com`,
    password: overrides.password || 'Karachi-Ledger-72',
    role,
    ...overrides,
  });

  const token = signToken(user);

  return {
    user,
    token,
    // Spread straight into `.set(...)` in a request.
    headers: { Authorization: `Bearer ${token}` },
  };
}

const createAdmin = (overrides) => createUser(ROLES.ADMIN, overrides);
const createManager = (overrides) => createUser(ROLES.MANAGER, overrides);
const createRep = (overrides) => createUser(ROLES.SALES_REP, overrides);

/** A customer owned by `owner` (assigned to and created by them). */
async function createCustomer(owner, overrides = {}) {
  sequence += 1;

  return Customer.create({
    name: overrides.name || `Customer ${sequence}`,
    email: overrides.email || `customer${sequence}@test.com`,
    city: overrides.city || 'Karachi',
    status: overrides.status || 'lead',
    assignedTo: overrides.assignedTo !== undefined ? overrides.assignedTo : owner.user._id,
    createdBy: owner.user._id,
    ...overrides,
  });
}

async function createProduct(overrides = {}) {
  sequence += 1;

  return Product.create({
    name: overrides.name || `Product ${sequence}`,
    sku: overrides.sku || `SKU-${sequence}`,
    price: overrides.price !== undefined ? overrides.price : 10,
    stockQty: overrides.stockQty !== undefined ? overrides.stockQty : 100,
    category: overrides.category || 'General',
    ...overrides,
  });
}

/**
 * A buyer account, created straight through the model for the same reason
 * `createUser` bypasses `/api/auth/register`: a test asks for the account it
 * wants without depending on whatever the real registration endpoint does
 * (email verification, activation, rate limiting) that has nothing to do with
 * what the test is checking.
 *
 * No `token`/`headers` here, unlike `createUser` — buyer sessions are cookie
 * based (see the buyer-auth build-log entry), so a test that needs an
 * authenticated buyer request logs in through the real endpoint to get real
 * cookies, rather than fabricating a bearer token buyer routes don't accept.
 */
async function createBuyer(overrides = {}) {
  sequence += 1;

  return Buyer.create({
    name: overrides.name || `Test Buyer ${sequence}`,
    email: overrides.email || `buyer${sequence}@test.com`,
    password: overrides.password || 'Karachi-Ledger-72',
    ...overrides,
  });
}

module.exports = {
  api,
  createUser,
  createAdmin,
  createManager,
  createRep,
  createCustomer,
  createProduct,
  createBuyer,
};
