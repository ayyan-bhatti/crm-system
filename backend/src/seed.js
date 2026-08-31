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

// Satisfies the password policy in utils/passwordPolicy.js — a seed that
// could not pass the app's own rules would be a confusing thing to hand someone.
const PASSWORD = 'Karachi-Ledger-72';

const USERS = [
  { name: 'Ayyan', email: 'admin@simplecrm.test', role: ROLES.ADMIN },
  { name: 'Bilal Ahmed', email: 'manager@simplecrm.test', role: ROLES.MANAGER },
  { name: 'Sara Iqbal', email: 'sara@simplecrm.test', role: ROLES.SALES_REP },
  { name: 'Omar Farooq', email: 'omar@simplecrm.test', role: ROLES.SALES_REP },
];

/**
 * A stand-in photograph for a seeded product.
 *
 * WHY THIS IS KEYWORD-BASED AND NO LONGER picsum.photos.
 *
 * Two separate problems, and only the second one was obvious.
 *
 * The first is relevance. picsum serves a random photograph per seed — a
 * landscape, a face, a building — so "Standing Desk" reliably illustrated
 * itself with something that was not a desk. A demo catalogue where every
 * picture is confidently wrong is not more populated than one with none; it is
 * less trustworthy, because the mismatch is the first thing a viewer notices.
 *
 * The second is that picsum.photos was simply UNREACHABLE from the network this
 * was last run on. It did not 404 — it hung until the browser gave up, so no
 * `onError` ever fired and every product rendered as a blank grey square with
 * nothing in the console to explain it. The storefront looked abandoned. That
 * is also why `ProductImage` now has a timeout rather than relying on `onError`
 * alone: a dead host is silent, not loud.
 *
 * LoremFlickr takes keywords, so the photo is at least in the right category,
 * and `lock` keyed on the SKU keeps one product on one photograph across
 * re-seeds — without it the catalogue reshuffles its own images on every page
 * load, which looks worse than having none.
 *
 * Still a stand-in, not real product photography. The generated tile in
 * `ui.js` remains the guaranteed floor for when this host is unreachable too.
 */
function demoImage(sku, index = 0, keywords = 'product') {
  const lock = `${sku.toLowerCase()}${index ? `-${index}` : ''}`
    .split('')
    .reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7)
    % 100000;

  return `https://loremflickr.com/640/640/${encodeURIComponent(keywords)}?lock=${lock}`;
}

/**
 * The variants a few of the seeded products are sold in.
 *
 * DELIBERATELY NOT ON EVERY PRODUCT, and that is the point rather than
 * laziness. Half the catalogue keeps a flat `stockQty` and no variants at all,
 * because that is the shape every product had before this feature existed and
 * it has to keep working — the storefront card, the detail page, the order form
 * and the stock decrement all have a branch for it. A demo catalogue where
 * every product has colours would exercise only the new path and would quietly
 * stop proving that the old one still works.
 *
 * Quantities are chosen so the seeded shop shows off the states the UI has to
 * render: a colour that is sold out, a product that is low on stock overall,
 * and one variant priced above its siblings.
 */
const VARIANTS = {
  'FURN-002': [
    { color: { name: 'Graphite', hex: '#3f4045' }, size: 'Standard', stockQty: 5 },
    { color: { name: 'Bone', hex: '#e8e1d5' }, size: 'Standard', stockQty: 3 },
    // Sold out, so the storefront's disabled-swatch state has something to show.
    { color: { name: 'Forest', hex: '#2f4f3a' }, size: 'Standard', stockQty: 0 },
  ],
  'TECH-002': [
    { color: { name: 'Midnight', hex: '#111827' }, size: 'Full', stockQty: 18 },
    { color: { name: 'Midnight', hex: '#111827' }, size: 'Compact', stockQty: 22 },
    { color: { name: 'Sand', hex: '#d6c7a1' }, size: 'Compact', stockQty: 12 },
    // Priced above the others, so "from $95" renders on the card.
    {
      color: { name: 'Copper', hex: '#b06a3b' },
      size: 'Compact',
      stockQty: 8,
      priceOverride: 125,
    },
  ],
  'TECH-003': [
    { color: { name: 'Midnight', hex: '#111827' }, stockQty: 2 },
    { color: { name: 'Cloud', hex: '#eef1f5' }, stockQty: 2 },
  ],
  'SUPP-002': [
    { color: { name: 'Assorted', hex: '#7c5cd6' }, stockQty: 6 },
  ],
};

const PRODUCTS = [
  {
    name: 'Standing Desk',
    sku: 'FURN-001',
    price: 450,
    stockQty: 24,
    category: 'Furniture',
    description: 'A height-adjustable desk that goes from sitting to standing in seconds.',
  },
  {
    name: 'Ergonomic Chair',
    sku: 'FURN-002',
    price: 320,
    stockQty: 8,
    category: 'Furniture',
    description: 'Full lumbar support and adjustable armrests for a full day at the desk.',
  },
  {
    name: 'Filing Cabinet',
    sku: 'FURN-003',
    price: 180,
    stockQty: 40,
    category: 'Furniture',
    description: 'A lockable three-drawer cabinet built for A4 and letter-size folders.',
  },
  {
    name: '27" Monitor',
    sku: 'TECH-001',
    price: 290,
    stockQty: 15,
    category: 'Electronics',
    description: 'A crisp 27-inch QHD display with a thin bezel and adjustable stand.',
  },
  {
    name: 'Mechanical Keyboard',
    sku: 'TECH-002',
    price: 95,
    stockQty: 60,
    category: 'Electronics',
    description: 'Hot-swappable switches and a compact layout for all-day typing.',
  },
  {
    name: 'Wireless Mouse',
    sku: 'TECH-003',
    price: 35,
    stockQty: 4,
    category: 'Electronics',
    description: 'A lightweight wireless mouse with a battery that lasts months, not days.',
  },
  {
    name: 'USB-C Dock',
    sku: 'TECH-004',
    price: 145,
    stockQty: 22,
    category: 'Electronics',
    description: 'One cable to your laptop, everything else plugged into the dock.',
  },
  {
    name: 'Laser Printer',
    sku: 'TECH-005',
    price: 410,
    stockQty: 3,
    category: 'Electronics',
    description: 'A reliable mono laser printer built for a busy shared office.',
  },
  {
    name: 'A4 Paper (5 reams)',
    sku: 'SUPP-001',
    price: 22,
    stockQty: 200,
    category: 'Supplies',
    description: 'Five reams of standard 80gsm A4, enough for a month of printing.',
  },
  {
    name: 'Whiteboard Markers',
    sku: 'SUPP-002',
    price: 12,
    stockQty: 6,
    category: 'Supplies',
    description: 'A pack of eight low-odour dry-erase markers in assorted colours.',
  },
].map((product) => {
  const variants = VARIANTS[product.sku];

  /*
   * Keywords for the stand-in photo, taken from the product's own name and
   * category — so "Standing Desk" in Furniture asks for a picture of a desk
   * rather than for whatever the random-photo endpoint felt like returning.
   * Bracketed pack sizes are dropped ("A4 Paper (5 reams)" wants *paper*).
   */
  const keywords = [
    ...product.name
      .replace(/\([^)]*\)/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2)
      .slice(0, 2),
    product.category.toLowerCase(),
  ].join(',');

  return {
    ...product,
    imageUrl: demoImage(product.sku, 0, keywords),
    /*
     * A second image on every product, so the storefront card's hover-swap has
     * something to swap TO. A card whose hover state does nothing looks broken
     * rather than restrained, and with one seeded image that is what every card
     * would do.
     */
    images: [demoImage(product.sku, 2, keywords), demoImage(product.sku, 3, keywords)],
    ...(variants ? { variants } : {}),
    /*
     * Where a product has variants, its own `stockQty` is the SUM of them. The
     * model's pre-save hook enforces exactly this, but `insertMany` does not run
     * that hook — so the value is computed here rather than left to be quietly
     * wrong in the one place the whole demo catalogue comes from.
     */
    ...(variants
      ? { stockQty: variants.reduce((sum, v) => sum + v.stockQty, 0) }
      : {}),
  };
});

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
    console.error('[seed] Refusing to run with NODE_ENV=production — this deletes all data.');
    process.exit(1);
  }

  await connectDB();

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
  console.log(`[seed] Created ${users.length} users`);

  // --- Products ------------------------------------------------------------
  const products = await Product.insertMany(PRODUCTS);
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
  console.log(`[seed] Created ${orders.length} orders`);

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
  console.error('[seed] Failed:', err);
  process.exit(1);
});
