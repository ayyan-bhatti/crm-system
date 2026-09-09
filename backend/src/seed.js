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
  'SOF-001': [
    { color: { name: 'Stone', hex: '#d9d3c7' }, stockQty: 6 },
    { color: { name: 'Clay', hex: '#b98d6f' }, stockQty: 4 },
    // Sold out, so the storefront's disabled-swatch state has something to show.
    { color: { name: 'Charcoal', hex: '#3f3d3a' }, stockQty: 0 },
  ],
  'BED-001': [
    { color: { name: 'Oatmeal', hex: '#e6ddcc' }, stockQty: 5 },
    // Priced above the others, so "from $x" renders on the card.
    { color: { name: 'Charcoal Bouclé', hex: '#4a4744' }, stockQty: 3, priceOverride: 1249 },
  ],
  'DCH-001': [
    { color: { name: 'Natural Oak', hex: '#c9a876' }, stockQty: 14 },
    { color: { name: 'Walnut', hex: '#5c4331' }, stockQty: 10 },
  ],
  'MIR-001': [
    { color: { name: 'Brass', hex: '#b6935a' }, stockQty: 7 },
    { color: { name: 'Black', hex: '#1c1b19' }, stockQty: 9 },
  ],
};

/**
 * Thirty products across thirteen furniture and home categories — Sofas,
 * Armchairs, Dining Tables, Dining Chairs, Beds, Side Tables, Coffee
 * Tables, Rugs, Lighting, Mirrors, Storage, Accessories, Textiles and
 * Outdoor — each with a real, hand-picked photo, a designer, materials,
 * dimensions and a rating. This replaced an earlier general-merchandise
 * catalogue (electronics, beauty, footwear): a storefront built to feel
 * like a premium furniture retailer needs a furniture catalogue, not a
 * fashion-and-gadgets one wearing a furniture-store skin. See
 * `curatedImage`'s own note for how the photo ids were chosen and verified.
 */
const PRODUCTS = [
  // --- Sofas ---------------------------------------------------------------
  {
    name: 'Luna Bouclé Sofa',
    sku: 'SOF-001',
    price: 1899,
    salePrice: 1599,
    stockQty: 10,
    category: 'Sofas',
    subcategory: 'Sofa',
    brand: 'Fenwick & Co.',
    materials: ['Bouclé wool', 'Solid ash frame'],
    dimensions: { width: 228, height: 84, depth: 96, unit: 'cm' },
    tags: ['boucle', 'living room', 'statement'],
    featured: true,
    rating: { average: 4.8, count: 96 },
    description:
      'A deep, cloud-like three-seater in nubbly bouclé, built on a solid ash frame that will outlast the fabric.',
    photo: '1600210491369-e753d80a41f3',
  },
  {
    name: 'Sora Linen Sofa',
    sku: 'SOF-002',
    newArrival: true,
    price: 1699,
    stockQty: 8,
    category: 'Sofas',
    subcategory: 'Sofa',
    brand: 'Nordvik',
    materials: ['Linen', 'Beechwood legs'],
    dimensions: { width: 214, height: 80, depth: 90, unit: 'cm' },
    tags: ['linen', 'living room'],
    rating: { average: 4.6, count: 58 },
    description:
      'A relaxed, tailored linen sofa with a low back and tapered legs — equally at home in a studio or a living room.',
    photo: '1600210492493-0946911123ea',
  },

  // --- Armchairs -------------------------------------------------------------
  {
    name: 'Dune Bouclé Armchair',
    sku: 'ARM-001',
    price: 749,
    salePrice: 649,
    stockQty: 16,
    category: 'Armchairs',
    subcategory: 'Lounge Chair',
    brand: 'Nordvik',
    materials: ['Bouclé wool', 'Beechwood frame'],
    dimensions: { width: 82, height: 78, depth: 88, unit: 'cm' },
    tags: ['boucle', 'lounge'],
    rating: { average: 4.7, count: 74 },
    description: 'A rounded, low-slung lounge chair upholstered in the same textured bouclé as the Luna sofa.',
    photo: '1759722666941-a90d5a15b1d7',
  },
  {
    name: 'Forma Leather Chair',
    sku: 'ARM-002',
    newArrival: true,
    price: 699,
    stockQty: 12,
    category: 'Armchairs',
    subcategory: 'Accent Chair',
    brand: 'Studio Halden',
    materials: ['Top-grain leather', 'Oak legs'],
    dimensions: { width: 76, height: 82, depth: 80, unit: 'cm' },
    tags: ['accent chair', 'leather'],
    featured: true,
    rating: { average: 4.5, count: 41 },
    description: 'A padded leather accent chair in a deep forest green — built for one long read, not a quick sit.',
    photo: '1568097225352-916d69bd4bed',
  },

  // --- Dining tables ---------------------------------------------------------
  {
    name: 'Nordic Oak Dining Table',
    sku: 'DTB-001',
    price: 1249,
    stockQty: 7,
    category: 'Dining Tables',
    subcategory: 'Dining Table',
    brand: 'Nordvik',
    materials: ['Solid oak'],
    dimensions: { width: 220, height: 75, depth: 95, unit: 'cm' },
    tags: ['oak', 'dining', 'seats eight'],
    featured: true,
    rating: { average: 4.8, count: 63 },
    description: 'A generous solid-oak table for eight, with a visible grain that only gets better with age.',
    photo: '1758977404607-9d6217cad08a',
  },
  // --- Dining chairs ---------------------------------------------------------
  {
    name: 'Atelier Dining Chair',
    sku: 'DCH-001',
    price: 189,
    stockQty: 24,
    category: 'Dining Chairs',
    subcategory: 'Dining Chair',
    brand: 'Studio Halden',
    materials: ['Solid oak', 'Woven cane back'],
    dimensions: { width: 46, height: 82, depth: 52, unit: 'cm' },
    tags: ['oak', 'cane', 'dining'],
    featured: true,
    rating: { average: 4.7, count: 88 },
    description: 'A cane-backed dining chair with a contoured seat — sold individually, sets the table one at a time.',
    photo: '1758977404607-9d6217cad08a',
  },
  // --- Beds -------------------------------------------------------------------
  {
    name: 'Noma Bed Frame',
    sku: 'BED-001',
    price: 1099,
    stockQty: 8,
    category: 'Beds',
    subcategory: 'Bed Frame',
    brand: 'Fenwick & Co.',
    materials: ['Bouclé upholstery', 'Solid pine frame'],
    dimensions: { width: 160, height: 110, depth: 210, unit: 'cm' },
    tags: ['upholstered', 'bedroom'],
    featured: true,
    rating: { average: 4.7, count: 54 },
    description: 'A tall, upholstered headboard on a low platform base — no box spring needed.',
    photo: '1616594039964-ae9021a400a0',
  },
  {
    name: 'Aria Bed Frame',
    sku: 'BED-002',
    newArrival: true,
    price: 1250,
    salePrice: 999,
    stockQty: 4,
    category: 'Beds',
    subcategory: 'Bed Frame',
    brand: 'Nordvik',
    materials: ['Solid oak'],
    dimensions: { width: 180, height: 90, depth: 215, unit: 'cm' },
    tags: ['oak', 'bedroom', 'minimal'],
    rating: { average: 4.6, count: 19 },
    description: 'A low, exposed-joinery oak frame with no upholstery to wear out — built for a king mattress.',
    photo: '1617325247661-675ab4b64ae2',
  },

  // --- Side tables -----------------------------------------------------------
  {
    name: 'Kona Side Table',
    sku: 'SDT-001',
    price: 249,
    stockQty: 22,
    category: 'Side Tables',
    subcategory: 'Side Table',
    brand: 'Studio Halden',
    materials: ['Solid walnut'],
    dimensions: { width: 40, height: 50, depth: 40, unit: 'cm' },
    tags: ['walnut', 'living room'],
    rating: { average: 4.6, count: 45 },
    description: 'A single-plank walnut side table, sized to actually reach from an armchair.',
    photo: '1646143612209-a06a538b8c7c',
  },
  {
    name: 'Pilar Side Table',
    sku: 'SDT-002',
    price: 329,
    stockQty: 15,
    category: 'Side Tables',
    subcategory: 'Side Table',
    brand: 'Fenwick & Co.',
    materials: ['Solid oak'],
    dimensions: { width: 42, height: 48, depth: 42, unit: 'cm' },
    tags: ['oak', 'living room'],
    rating: { average: 4.5, count: 28 },
    description: 'A block-legged oak table, low enough to double as extra seating when the room fills up.',
    photo: '1523755231516-e43fd2e8dca5',
  },

  // --- Coffee tables ---------------------------------------------------------
  {
    name: 'Milo Round Coffee Table',
    sku: 'CFT-001',
    price: 459,
    stockQty: 13,
    category: 'Coffee Tables',
    subcategory: 'Coffee Table',
    brand: 'Nordvik',
    materials: ['Solid oak', 'Travertine top'],
    dimensions: { width: 90, height: 38, depth: 90, unit: 'cm' },
    tags: ['round', 'travertine', 'living room'],
    featured: true,
    rating: { average: 4.8, count: 67 },
    description: 'A travertine-topped round table with a substantial oak base — the room’s quiet centrepiece.',
    photo: '1550581190-9c1c48d21d6c',
  },
  {
    name: 'Dansk Oval Coffee Table',
    sku: 'CFT-002',
    newArrival: true,
    price: 499,
    stockQty: 9,
    category: 'Coffee Tables',
    subcategory: 'Coffee Table',
    brand: 'Studio Halden',
    materials: ['Walnut veneer'],
    dimensions: { width: 120, height: 36, depth: 60, unit: 'cm' },
    tags: ['oval', 'walnut', 'living room'],
    rating: { average: 4.5, count: 31 },
    description: 'An oval walnut table with softened edges, scaled for a sofa rather than a sectional.',
    photo: '1758565811033-84d1365000c6',
  },

  // --- Rugs -------------------------------------------------------------------
  {
    name: 'Sora Wool Rug',
    sku: 'RUG-001',
    price: 349,
    salePrice: 279,
    stockQty: 14,
    category: 'Rugs',
    subcategory: 'Area Rug',
    brand: 'Loom & Weft',
    materials: ['New Zealand wool'],
    dimensions: { width: 200, height: null, depth: 300, unit: 'cm' },
    tags: ['wool', 'neutral', 'living room'],
    rating: { average: 4.7, count: 82 },
    description: 'A dense, undyed wool rug in its natural colour — the quiet foundation under everything else.',
    photo: '1736580602768-3e06e97d7288',
  },
  {
    name: 'Weft Textured Rug',
    sku: 'RUG-002',
    price: 299,
    stockQty: 20,
    category: 'Rugs',
    subcategory: 'Area Rug',
    brand: 'Loom & Weft',
    materials: ['Wool blend'],
    dimensions: { width: 160, height: null, depth: 230, unit: 'cm' },
    tags: ['patterned', 'texture', 'living room'],
    rating: { average: 4.4, count: 29 },
    description: 'A patterned wool-blend rug in warm neutrals — enough texture to hide what a hallway rug actually sees.',
    photo: '1690268798551-90e0fa935c4d',
  },

  // --- Lighting ---------------------------------------------------------------
  {
    name: 'Arco Floor Lamp',
    sku: 'LGT-001',
    price: 289,
    stockQty: 17,
    category: 'Lighting',
    subcategory: 'Floor Lamp',
    brand: 'Halo Lighting',
    materials: ['Powder-coated steel'],
    dimensions: { width: 35, height: 148, depth: 35, unit: 'cm' },
    tags: ['floor lamp', 'living room'],
    featured: true,
    rating: { average: 4.6, count: 49 },
    description: 'A slim, matte-black floor lamp that throws light up rather than out — good for a corner with nothing else going on.',
    photo: '1494438639946-1ebd1d20bf85',
  },
  {
    name: 'Halo Pendant Light',
    sku: 'LGT-002',
    price: 219,
    stockQty: 11,
    category: 'Lighting',
    subcategory: 'Pendant',
    brand: 'Halo Lighting',
    materials: ['Enamelled steel shade'],
    dimensions: { width: 32, height: 28, depth: 32, unit: 'cm' },
    tags: ['pendant', 'dining'],
    rating: { average: 4.5, count: 33 },
    description: 'A single dome pendant in a deep enamel finish, hung low over a table rather than a whole room.',
    photo: '1761864294727-3c9f6b3e7425',
  },
  {
    name: 'Dusk Table Lamp',
    sku: 'LGT-003',
    newArrival: true,
    price: 129,
    stockQty: 26,
    category: 'Lighting',
    subcategory: 'Table Lamp',
    brand: 'Halo Lighting',
    materials: ['Ceramic base', 'Linen shade'],
    dimensions: { width: 24, height: 44, depth: 24, unit: 'cm' },
    tags: ['table lamp', 'bedroom'],
    rating: { average: 4.4, count: 21 },
    description: 'A rounded ceramic base under a linen shade — the lamp for a bedside table, not a desk.',
    photo: '1532344214108-1b6d425db572',
  },

  // --- Mirrors ----------------------------------------------------------------
  {
    name: 'Halo Wall Mirror',
    sku: 'MIR-001',
    price: 219,
    stockQty: 16,
    category: 'Mirrors',
    subcategory: 'Wall Mirror',
    brand: 'Studio Halden',
    materials: ['Metal frame', 'Glass'],
    dimensions: { width: 70, height: 90, depth: 3, unit: 'cm' },
    tags: ['mirror', 'entryway'],
    featured: true,
    rating: { average: 4.6, count: 52 },
    description: 'An arched mirror in a slim metal frame, sized for a hallway or the top of a dresser.',
    photo: '1729160010511-a996a95c0475',
  },
  {
    name: 'Arco Gilt Mirror',
    sku: 'MIR-002',
    price: 259,
    stockQty: 10,
    category: 'Mirrors',
    subcategory: 'Wall Mirror',
    brand: 'Studio Halden',
    materials: ['Gold-leaf frame', 'Glass'],
    dimensions: { width: 80, height: 110, depth: 4, unit: 'cm' },
    tags: ['mirror', 'ornate'],
    rating: { average: 4.5, count: 18 },
    description: 'A carved, gold-leaf frame with real presence — the mirror that anchors a room rather than disappearing into it.',
    photo: '1560828343-a0b3d8864d1b',
    photoAlt: '1541123603104-512919d6a96c',
  },

  // --- Storage ----------------------------------------------------------------
  {
    name: 'Linea Sideboard',
    sku: 'STO-001',
    price: 899,
    stockQty: 9,
    category: 'Storage',
    subcategory: 'Sideboard',
    brand: 'Nordvik',
    materials: ['Solid oak', 'Brass hardware'],
    dimensions: { width: 160, height: 78, depth: 42, unit: 'cm' },
    tags: ['oak', 'sideboard', 'dining'],
    featured: true,
    rating: { average: 4.7, count: 46 },
    description: 'A long, low sideboard with three sliding panels and a full-width brass pull.',
    photo: '1541123603104-512919d6a96c',
  },
  {
    name: 'Bruk Gilded Library Shelving',
    sku: 'STO-002',
    price: 599,
    stockQty: 12,
    category: 'Storage',
    subcategory: 'Shelving',
    brand: 'Studio Halden',
    materials: ['Solid oak', 'Gold-leaf trim'],
    dimensions: { width: 90, height: 190, depth: 32, unit: 'cm' },
    tags: ['shelving', 'study', 'statement'],
    rating: { average: 4.4, count: 24 },
    description:
      'A five-shelf oak unit finished with a gold-leaf edge, modelled on the reading-room shelving it takes its name from.',
    photo: '1590548251068-53aa01421259',
  },
  {
    name: 'Kiri Chest of Drawers',
    sku: 'STO-003',
    newArrival: true,
    price: 750,
    stockQty: 11,
    category: 'Storage',
    subcategory: 'Dresser',
    brand: 'Nordvik',
    materials: ['Solid oak', 'Brass handles'],
    dimensions: { width: 90, height: 80, depth: 45, unit: 'cm' },
    tags: ['dresser', 'bedroom'],
    rating: { average: 4.6, count: 15 },
    description: 'A four-drawer dresser with a warm, honey-toned finish that only deepens with age.',
    photo: '1544691560-fc2053d97726',
  },

  // --- Accessories -------------------------------------------------------------
  {
    name: 'Terra Ceramic Vase',
    sku: 'ACC-001',
    price: 65,
    stockQty: 34,
    category: 'Accessories',
    subcategory: 'Vase',
    brand: 'Loom & Weft',
    materials: ['Stoneware'],
    dimensions: { width: 18, height: 28, depth: 18, unit: 'cm' },
    tags: ['ceramic', 'decor'],
    rating: { average: 4.6, count: 39 },
    description: 'A hand-thrown stoneware vase with a matte, slightly uneven glaze — every piece a little different.',
    photo: '1620812067822-899be8a6a9a7',
  },
  {
    name: 'Nima Glass Vase',
    sku: 'ACC-002',
    price: 45,
    stockQty: 30,
    category: 'Accessories',
    subcategory: 'Vase',
    brand: 'Loom & Weft',
    materials: ['Recycled glass'],
    dimensions: { width: 12, height: 24, depth: 12, unit: 'cm' },
    tags: ['glass', 'decor'],
    rating: { average: 4.5, count: 17 },
    description: 'A clear recycled-glass vase, blown with a faint ripple that catches the light differently in every room.',
    photo: '1609210885099-6ba41569c6dc',
  },

  // --- Textiles ----------------------------------------------------------------
  {
    name: 'Weft Throw Blanket',
    sku: 'TEX-001',
    price: 79,
    stockQty: 40,
    category: 'Textiles',
    subcategory: 'Throw',
    brand: 'Loom & Weft',
    materials: ['Merino wool'],
    dimensions: { width: 130, height: null, depth: 180, unit: 'cm' },
    tags: ['throw', 'wool', 'gift'],
    rating: { average: 4.7, count: 61 },
    description: 'A fringed merino throw, heavy enough to actually keep the cold off a sofa in winter.',
    photo: '1531877025030-f7696a50770f',
  },
  // --- Outdoor -----------------------------------------------------------------
  {
    name: 'Riva Outdoor Lounge Chair',
    sku: 'OUT-001',
    price: 549,
    stockQty: 8,
    category: 'Outdoor',
    subcategory: 'Outdoor Seating',
    brand: 'Studio Halden',
    materials: ['All-weather rope', 'Powder-coated aluminium'],
    dimensions: { width: 70, height: 78, depth: 82, unit: 'cm' },
    tags: ['outdoor', 'lounge'],
    featured: true,
    rating: { average: 4.6, count: 27 },
    description: 'A rope-wrapped aluminium frame that shrugs off rain — cushions stay indoors, the chair does not have to.',
    photo: '1777052854737-7893f50de539',
  },
  {
    name: 'Terra Outdoor Dining Table',
    sku: 'OUT-002',
    newArrival: true,
    price: 899,
    stockQty: 6,
    category: 'Outdoor',
    subcategory: 'Outdoor Dining',
    brand: 'Loom & Weft',
    materials: ['Teak', 'Stainless steel hardware'],
    dimensions: { width: 200, height: 74, depth: 95, unit: 'cm' },
    tags: ['outdoor', 'dining', 'teak'],
    rating: { average: 4.3, count: 14 },
    description: 'A weatherproof teak table for six, left untreated to silver gracefully over its first summer outside.',
    photo: '1722719228260-6f2a93d9ee37',
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
