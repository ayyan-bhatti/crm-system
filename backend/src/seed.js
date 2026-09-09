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
/**
 * A specific, real, verified-reachable Unsplash photo id — not a random-photo
 * lottery keyed off the SKU.
 *
 * `loremflickr.com`'s keyword search used to sit here, and it never actually
 * matched what it was asked for: a search for "desk" is as likely to return a
 * photo of a park bench, because the service matches loosely and returns
 * WHATEVER it has tagged with that word. Every id below was picked by hand for
 * the specific product it illustrates and curl-verified (`200`, real
 * `image/jpeg`) before being committed here — see the response format Unsplash
 * documents at https://images.unsplash.com/photo-<id>.
 */
function curatedImage(id, { w = 800 } = {}) {
  return `https://images.unsplash.com/photo-${id}?w=${w}&q=80&auto=format&fit=crop`;
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
  'TECH-001': [
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
    { color: { name: 'Midnight', hex: '#111827' }, stockQty: 9 },
    { color: { name: 'Cloud', hex: '#eef1f5' }, stockQty: 7 },
  ],
  'APP-001': [
    { color: { name: 'Crimson', hex: '#b5292f' }, size: '9', stockQty: 6 },
    { color: { name: 'Crimson', hex: '#b5292f' }, size: '10', stockQty: 4 },
    { color: { name: 'Forest', hex: '#2f4f3a' }, size: '9', stockQty: 0 },
    { color: { name: 'Forest', hex: '#2f4f3a' }, size: '10', stockQty: 5 },
  ],
};

/**
 * Twenty products across eight categories, each with a real, hand-picked
 * photo, a brand, tags, and a rating — not the ten-item office-supplies
 * closet with mismatched stock photos this catalogue used to be. See
 * `curatedImage`'s own note for how the ids were chosen and verified.
 */
const PRODUCTS = [
  {
    name: 'Standing Desk',
    sku: 'FURN-001',
    price: 450,
    stockQty: 24,
    category: 'Furniture',
    brand: 'Uplift Studio',
    tags: ['office', 'ergonomic', 'desk'],
    featured: true,
    rating: { average: 4.6, count: 128 },
    description: 'A height-adjustable desk that goes from sitting to standing in seconds.',
    photo: '1683582411325-b87240c5b530',
  },
  {
    name: 'Ergonomic Chair',
    sku: 'FURN-002',
    price: 320,
    stockQty: 8,
    category: 'Furniture',
    brand: 'Uplift Studio',
    tags: ['office', 'ergonomic', 'seating'],
    rating: { average: 4.4, count: 95 },
    description: 'Full lumbar support and adjustable armrests for a full day at the desk.',
    photo: '1518455027359-f3f8164ba6bd',
    photoAlt: '1598300042247-d088f8ab3a91',
  },
  {
    name: 'Mechanical Keyboard',
    sku: 'TECH-001',
    price: 95,
    salePrice: 79,
    stockQty: 60,
    category: 'Electronics',
    brand: 'Keytron',
    tags: ['typing', 'gaming', 'hot-swap'],
    featured: true,
    rating: { average: 4.7, count: 342 },
    description: 'Hot-swappable switches and a compact layout for all-day typing.',
    photo: '1618384887929-16ec33fab9ef',
    photoAlt: '1547394765-185e1e68f34e',
  },
  {
    name: 'Wireless Headphones',
    sku: 'TECH-002',
    price: 180,
    stockQty: 34,
    category: 'Electronics',
    brand: 'Auralite',
    tags: ['audio', 'travel', 'anc'],
    rating: { average: 4.5, count: 210 },
    description: 'Active noise cancelling over-ears with a battery that lasts the whole flight.',
    photo: '1609081219090-a6d81d3085bf',
    photoAlt: '1571781926291-c477ebfd024b',
  },
  {
    name: 'Smart Watch',
    sku: 'TECH-003',
    price: 220,
    salePrice: 189,
    stockQty: 16,
    category: 'Electronics',
    brand: 'Pulse',
    tags: ['fitness', 'wearable'],
    rating: { average: 4.3, count: 176 },
    description: 'Tracks your day and your workouts, and still looks right with a shirt and tie.',
    photo: '1579586337278-3befd40fd17a',
    photoAlt: '1546868871-7041f2a55e12',
  },
  {
    name: 'Bluetooth Speaker',
    sku: 'TECH-004',
    price: 85,
    stockQty: 27,
    category: 'Electronics',
    brand: 'Auralite',
    tags: ['audio', 'portable'],
    rating: { average: 4.2, count: 88 },
    description: 'Pocket-sized and genuinely loud, with ten hours on a single charge.',
    photo: '1608043152269-423dbba4e7e1',
    photoAlt: '1589003077984-894e133dabab',
  },
  {
    name: 'Desk Lamp',
    sku: 'HOME-001',
    price: 60,
    stockQty: 45,
    category: 'Home',
    brand: 'Glow & Co.',
    tags: ['lighting', 'desk'],
    rating: { average: 4.6, count: 64 },
    description: 'A balanced-arm reading lamp that stays exactly where you put it.',
    photo: '1519219788971-8d9797e0928e',
    photoAlt: '1582356630861-61bb9b41f541',
  },
  {
    name: 'Potted Plant',
    sku: 'HOME-002',
    price: 35,
    stockQty: 18,
    category: 'Home',
    brand: 'Verdant',
    tags: ['plants', 'decor'],
    rating: { average: 4.8, count: 40 },
    description: 'A low-maintenance houseplant in a ceramic pot, delivered already thriving.',
    photo: '1592150621744-aca64f48394a',
    photoAlt: '1603436326446-74e2d65f3168',
  },
  {
    name: 'Ceramic Mug Set',
    sku: 'HOME-003',
    price: 28,
    stockQty: 52,
    category: 'Home',
    brand: 'Kiln House',
    tags: ['kitchen', 'gift'],
    rating: { average: 4.7, count: 52 },
    description: 'A set of two hand-glazed mugs, dishwasher and microwave safe.',
    photo: '1616241673111-508b4662c707',
    photoAlt: '1570784332176-fdd73da66f03',
  },
  {
    name: 'Leather Journal',
    sku: 'HOME-004',
    price: 32,
    stockQty: 40,
    category: 'Home',
    brand: 'Folio & Ink',
    tags: ['stationery', 'gift'],
    rating: { average: 4.5, count: 33 },
    description: 'A refillable leather-bound notebook with 200 pages of unlined paper.',
    photo: '1677064061401-f77f966ff8a1',
    photoAlt: '1639371040157-55b642d03f4f',
  },
  {
    name: 'Desk Organizer',
    sku: 'SUPP-001',
    price: 18,
    stockQty: 65,
    category: 'Supplies',
    brand: 'Uplift Studio',
    tags: ['office', 'storage'],
    rating: { average: 4.1, count: 27 },
    description: 'Keeps cables, pens and a phone stand off the desk and within reach.',
    photo: '1644463589256-02679b9c0767',
    photoAlt: '1760348213270-7cd00b8c3405',
  },
  {
    name: 'Leather Backpack',
    sku: 'ACC-001',
    price: 140,
    stockQty: 21,
    category: 'Accessories',
    brand: 'Wayfarer Goods',
    tags: ['bags', 'travel', 'leather'],
    featured: true,
    rating: { average: 4.6, count: 118 },
    description: 'Full-grain leather with a padded 15" laptop sleeve, ages better every year.',
    photo: '1547949003-9792a18a2601',
  },
  {
    name: 'Leather Wallet',
    sku: 'ACC-002',
    price: 65,
    stockQty: 38,
    category: 'Accessories',
    brand: 'Wayfarer Goods',
    tags: ['leather', 'gift'],
    rating: { average: 4.5, count: 71 },
    description: 'A slim bifold with six card slots, cut from a single piece of hide.',
    photo: '1601592996763-f05c9c80a7f1',
    photoAlt: '1620109176813-e91290f6c795',
  },
  {
    name: 'Sunglasses',
    sku: 'ACC-003',
    price: 75,
    stockQty: 29,
    category: 'Accessories',
    brand: 'Solstice',
    tags: ['eyewear', 'summer'],
    rating: { average: 4.4, count: 59 },
    description: 'Polarised lenses in a classic frame that does not go out of style.',
    photo: '1511499767150-a48a237f0083',
    photoAlt: '1572635196237-14b3f281503f',
  },
  {
    name: 'Chronograph Watch',
    sku: 'ACC-004',
    price: 210,
    salePrice: 175,
    stockQty: 14,
    category: 'Accessories',
    brand: 'Halden & Co.',
    tags: ['watch', 'gift'],
    featured: true,
    rating: { average: 4.6, count: 47 },
    description: 'A stainless chronograph with a sapphire crystal — dressed up or worn every day.',
    photo: '1523275335684-37898b6baf30',
  },
  {
    name: 'Running Shoes',
    sku: 'APP-001',
    price: 110,
    salePrice: 89,
    stockQty: 15,
    category: 'Footwear',
    brand: 'Northstar',
    tags: ['running', 'training'],
    featured: true,
    rating: { average: 4.6, count: 203 },
    description: 'A cushioned daily trainer built for the miles that add up over a year.',
    photo: '1542291026-7eec264c27ff',
    photoAlt: '1606107557195-0e29a4b5b4aa',
  },
  {
    name: 'Court Sneakers',
    sku: 'APP-002',
    price: 98,
    stockQty: 32,
    category: 'Footwear',
    brand: 'Northstar',
    tags: ['sneakers', 'casual'],
    rating: { average: 4.5, count: 84 },
    description: 'A clean, low-profile court shoe that goes with everything else in the wardrobe.',
    photo: '1526170375885-4d8ecf77b99f',
  },
  {
    name: 'Water Bottle',
    sku: 'OUT-001',
    price: 25,
    stockQty: 70,
    category: 'Outdoors',
    brand: 'Basecamp',
    tags: ['hydration', 'outdoors'],
    rating: { average: 4.7, count: 96 },
    description: 'Double-walled steel that keeps cold drinks cold for a full day outside.',
    photo: '1625708458528-802ec79b1ed8',
    photoAlt: '1544003484-3cd181d17917',
  },
  {
    name: 'Vitamin C Serum',
    sku: 'BEAU-001',
    price: 42,
    stockQty: 60,
    category: 'Beauty',
    brand: 'Lumen Skincare',
    tags: ['skincare', 'serum'],
    rating: { average: 4.5, count: 152 },
    description: 'A brightening daily serum that layers cleanly under moisturiser and sunscreen.',
    photo: '1556228720-195a672e8a03',
  },
  {
    name: 'Eau de Parfum',
    sku: 'BEAU-002',
    price: 88,
    stockQty: 25,
    category: 'Beauty',
    brand: 'Maison Verre',
    tags: ['fragrance', 'gift'],
    featured: true,
    rating: { average: 4.7, count: 61 },
    description: 'A warm, woody signature scent in a refillable glass bottle.',
    photo: '1571019613454-1cb2f99b2d8b',
  },
].map(({ photo, photoAlt, ...product }) => {
  const variants = VARIANTS[product.sku];

  return {
    ...product,
    imageUrl: curatedImage(photo),
    /*
     * A second image on every product, so the storefront card's hover-swap has
     * something to swap TO. Where a distinct second angle was not hand-picked,
     * the same photo repeats at a different crop width rather than showing an
     * unrelated product on hover — that would be worse than no swap at all.
     */
    images: [curatedImage(photoAlt || photo, { w: 900 }), curatedImage(photo, { w: 700 })],
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

        /*
         * MARKETING CONSENT, SEEDED AS A MIXTURE ON PURPOSE.
         *
         * The obvious thing is to opt everybody in, so the campaign screens
         * look impressive. That would make the demo actively misleading: the
         * whole point of the consent gate is the gap between "matched the
         * audience" and "can actually be messaged", and a book where everyone
         * has agreed hides both the gap and the counter that explains it.
         *
         * So roughly two thirds take email, a third take SMS and a couple take
         * WhatsApp, keyed off the index so the data is the same on every seed.
         * A campaign to "everyone" therefore reports a real skipped count, and
         * the number is the feature working rather than a bug.
         */
        marketing: {
          email: {
            optIn: index % 3 !== 2,
            optInAt: index % 3 !== 2 ? daysAgoDate(118 + index * 5) : null,
          },
          sms: {
            optIn: index % 3 === 0,
            optInAt: index % 3 === 0 ? daysAgoDate(118 + index * 5) : null,
          },
          whatsapp: {
            optIn: index % 5 === 0,
            optInAt: index % 5 === 0 ? daysAgoDate(118 + index * 5) : null,
          },
        },

        /* One hand-assigned tag, so the tag filter has something to find. */
        marketingTags: index === 0 ? ['VIP'] : index === 1 ? ['wholesale'] : [],
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
