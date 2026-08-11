/**
 * Development seed script — `npm run seed`.
 *
 * Wipes the configured database and fills it with a realistic set of users,
 * customers, products and orders, so the UI and the AI search have something to
 * work with the first time you open them.
 *
 * DESTRUCTIVE: it clears every collection first. It refuses to run against
 * NODE_ENV=production for that reason.
 */
const mongoose = require('mongoose');
const env = require('./config/env');
const { connectDB } = require('./config/db');
const User = require('./models/User');
const Customer = require('./models/Customer');
const Product = require('./models/Product');
const Order = require('./models/Order');
const { ROLES, ORDER_STATUS } = require('./config/constants');

const PASSWORD = 'password123';

const USERS = [
  { name: 'Amina Rashid', email: 'admin@simplecrm.test', role: ROLES.ADMIN },
  { name: 'Bilal Ahmed', email: 'manager@simplecrm.test', role: ROLES.MANAGER },
  { name: 'Sara Iqbal', email: 'sara@simplecrm.test', role: ROLES.SALES_REP },
  { name: 'Omar Farooq', email: 'omar@simplecrm.test', role: ROLES.SALES_REP },
];

const PRODUCTS = [
  { name: 'Standing Desk', sku: 'FURN-001', price: 450, stockQty: 24, category: 'Furniture' },
  { name: 'Ergonomic Chair', sku: 'FURN-002', price: 320, stockQty: 8, category: 'Furniture' },
  { name: 'Filing Cabinet', sku: 'FURN-003', price: 180, stockQty: 40, category: 'Furniture' },
  { name: '27" Monitor', sku: 'TECH-001', price: 290, stockQty: 15, category: 'Electronics' },
  { name: 'Mechanical Keyboard', sku: 'TECH-002', price: 95, stockQty: 60, category: 'Electronics' },
  { name: 'Wireless Mouse', sku: 'TECH-003', price: 35, stockQty: 4, category: 'Electronics' },
  { name: 'USB-C Dock', sku: 'TECH-004', price: 145, stockQty: 22, category: 'Electronics' },
  { name: 'Laser Printer', sku: 'TECH-005', price: 410, stockQty: 3, category: 'Electronics' },
  { name: 'A4 Paper (5 reams)', sku: 'SUPP-001', price: 22, stockQty: 200, category: 'Supplies' },
  { name: 'Whiteboard Markers', sku: 'SUPP-002', price: 12, stockQty: 6, category: 'Supplies' },
];

// `daysAgo` drives the AI-search demo: some customers have recent orders and
// some have none in the last 30 days, so "customers with no orders in the last
// 30 days" returns a meaningful, non-empty answer straight after seeding.
const CUSTOMERS = [
  { name: 'Karachi Textiles', company: 'Karachi Textiles Ltd', city: 'Karachi', status: 'active', rep: 2, daysAgo: 3 },
  { name: 'Indus Logistics', company: 'Indus Logistics', city: 'Karachi', status: 'active', rep: 2, daysAgo: 12 },
  { name: 'Clifton Traders', company: 'Clifton Trading Co', city: 'Karachi', status: 'active', rep: 2, daysAgo: 95 },
  { name: 'Saddar Supplies', company: 'Saddar Supplies', city: 'Karachi', status: 'inactive', rep: 3, daysAgo: null },
  { name: 'Gulshan Motors', company: 'Gulshan Motors', city: 'Karachi', status: 'lead', rep: 3, daysAgo: null },
  { name: 'Lahore Fabrics', company: 'Lahore Fabrics', city: 'Lahore', status: 'active', rep: 3, daysAgo: 6 },
  { name: 'Anarkali Retail', company: 'Anarkali Retail Group', city: 'Lahore', status: 'active', rep: 3, daysAgo: 60 },
  { name: 'Model Town Clinic', company: 'Model Town Medical', city: 'Lahore', status: 'lead', rep: 2, daysAgo: null },
  { name: 'Islamabad Consulting', company: 'ICG Partners', city: 'Islamabad', status: 'active', rep: 1, daysAgo: 1 },
  { name: 'Blue Area Legal', company: 'Blue Area Associates', city: 'Islamabad', status: 'inactive', rep: 1, daysAgo: 210 },
  { name: 'Peshawar Foods', company: 'Peshawar Food Co', city: 'Peshawar', status: 'lead', rep: 2, daysAgo: null },
  { name: 'Quetta Hardware', company: 'Quetta Hardware', city: 'Quetta', status: 'active', rep: 3, daysAgo: 45 },
];

/** A date N days in the past. */
function daysAgoDate(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Deterministic pseudo-random pick, so repeated seeds produce the same data. */
function pick(array, index) {
  return array[index % array.length];
}

async function seed() {
  if (env.isProduction) {
    // eslint-disable-next-line no-console
    console.error('[seed] Refusing to run with NODE_ENV=production — this deletes all data.');
    process.exit(1);
  }

  await connectDB();

  // eslint-disable-next-line no-console
  console.log('[seed] Clearing existing data…');
  await Promise.all([
    User.deleteMany({}),
    Customer.deleteMany({}),
    Product.deleteMany({}),
    Order.deleteMany({}),
  ]);

  // --- Users ---------------------------------------------------------------
  // create() rather than insertMany() so the password-hashing pre-save hook
  // runs — insertMany bypasses it and would store plain text.
  const users = [];
  for (const spec of USERS) {
    users.push(await User.create({ ...spec, password: PASSWORD }));
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] Created ${users.length} users`);

  // --- Products ------------------------------------------------------------
  const products = await Product.insertMany(PRODUCTS);
  // eslint-disable-next-line no-console
  console.log(`[seed] Created ${products.length} products`);

  // --- Customers -----------------------------------------------------------
  const customers = [];
  for (const [index, spec] of CUSTOMERS.entries()) {
    const owner = users[spec.rep];

    customers.push(
      await Customer.create({
        name: spec.name,
        email: `${spec.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
        phone: `+92 3${String(index).padStart(2, '0')} 555 01${index}`,
        company: spec.company,
        city: spec.city,
        status: spec.status,
        notes: spec.daysAgo === null ? 'No orders placed yet — follow up.' : '',
        assignedTo: owner._id,
        createdBy: owner._id,
        createdAt: daysAgoDate(120 + index * 5),
      })
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] Created ${customers.length} customers`);

  // --- Orders --------------------------------------------------------------
  // One order per customer that has a `daysAgo`. Most are completed, so the
  // dashboard shows real revenue; a couple stay pending and one is cancelled.
  const orders = [];

  for (const [index, spec] of CUSTOMERS.entries()) {
    if (spec.daysAgo === null) continue;

    const customer = customers[index];
    const placedAt = daysAgoDate(spec.daysAgo);

    // Two line items, picked deterministically.
    const lineProducts = [pick(products, index), pick(products, index + 4)];
    const items = lineProducts.map((product, i) => ({
      product: product._id,
      quantity: i + 1,
      priceAtOrder: product.price,
    }));

    const total =
      Math.round(items.reduce((sum, item) => sum + item.priceAtOrder * item.quantity, 0) * 100) /
      100;

    // Vary the statuses so every filter in the UI has something to show.
    let status = ORDER_STATUS.COMPLETED;
    if (index % 5 === 1) status = ORDER_STATUS.PENDING;
    if (index % 7 === 6) status = ORDER_STATUS.CANCELLED;

    orders.push(
      await Order.create({
        customer: customer._id,
        items,
        total,
        status,
        completedAt: status === ORDER_STATUS.COMPLETED ? placedAt : null,
        createdBy: customer.assignedTo,
        createdAt: placedAt,
      })
    );

    // Keep stock consistent with the completed orders, so the low-stock figures
    // on the dashboard reflect what the order history implies.
    if (status === ORDER_STATUS.COMPLETED) {
      for (const item of items) {
        await Product.updateOne(
          { _id: item.product, stockQty: { $gte: item.quantity } },
          { $inc: { stockQty: -item.quantity } }
        );
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[seed] Created ${orders.length} orders`);

  // eslint-disable-next-line no-console
  console.log(`
[seed] Done. Sign in with any of these (password: ${PASSWORD}):

  admin@simplecrm.test      admin      — full access, including user management
  manager@simplecrm.test    manager    — full CRM access, no user management
  sara@simplecrm.test       sales_rep  — only her own customers and orders
  omar@simplecrm.test       sales_rep  — only his own customers and orders

Try the AI search with: "customers in Karachi with no orders in the last 30 days"
`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] Failed:', err);
  process.exit(1);
});
