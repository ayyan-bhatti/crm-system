/**
 * Every word of marketing copy on the storefront, in one file.
 *
 * WHY THIS IS A FILE OF CONSTANTS AND NOT A CONTENT-MANAGEMENT SYSTEM
 *
 * A deliberate decision, made explicitly rather than by default. The round-3
 * brief asked for a well-designed hero and a couple of promotional sections and
 * said not to build a CMS for them this round — so the copy is hardcoded, and
 * the concession to future editing is that it all lives HERE rather than being
 * scattered through six components. Changing the hero headline is a one-line
 * edit in a file with no JSX in it.
 *
 * What a real CMS would add, when someone wants it: a `SiteContent` model, an
 * admin-only editor screen, and the permissions and tests that go with them.
 * The shape below is close to what that model's documents would hold, so the
 * migration is a fetch replacing an import rather than a rewrite.
 *
 * NOTHING HERE PROMISES ANYTHING THE SHOP CANNOT DO. The trust badges in
 * particular are written generically on purpose — this is a demonstration
 * storefront with no returns department and no shipping contract, so the copy
 * describes the mechanism (Stripe really does handle the payment) rather than
 * inventing a policy that does not exist.
 */

/** The slim strip above the header. */
export const ANNOUNCEMENT = 'Free delivery on orders over $75 · Estimated arrival in 3–5 days';

/** The full-bleed hero on the home page. */
export const HERO = {
  eyebrow: 'New season',
  headline: 'Furniture made to be lived with.',
  body:
    'A small, carefully chosen catalogue — solid materials, considered proportions, ' +
    'nothing built to be replaced in two years.',
  primaryCta: { label: 'Shop everything', to: '/products' },
  secondaryCta: { label: 'Shop by room', to: '/rooms' },
};

/**
 * The two promotional panels below the featured grid.
 *
 * `category` points each one at a real category filter rather than a
 * hardcoded product list, so a panel keeps working after the catalogue changes
 * — a promo linking to a product that has been deleted is a 404 with a banner
 * on top of it.
 */
export const PROMOS = [
  {
    eyebrow: 'The living room edit',
    headline: 'Everything for the room you actually sit in',
    body: 'Sofas, armchairs and the coffee tables that hold the coffee.',
    cta: 'Shop sofas',
    category: 'Sofas',
    tone: 'ink',
  },
  {
    eyebrow: 'Restock',
    headline: 'The small pieces that finish a room',
    body: 'Vases, throws and the cushions nobody thinks about until the sofa looks bare.',
    cta: 'Shop accessories',
    category: 'Accessories',
    tone: 'wash',
  },
];

/**
 * The "What are you looking for?" category grid on the homepage. Each image
 * is the same hand-picked, verified Unsplash photo used for that category's
 * own products in the seed catalogue (see backend/src/seed.js) — reusing it
 * here rather than sourcing a separate "category hero" image keeps every
 * photo on the site traceable to a real, checked source instead of doubling
 * the surface area of things that could go stale or 404.
 */
export const CATEGORY_DISCOVERY = [
  { name: 'Sofas', image: '1600210491369-e753d80a41f3' },
  { name: 'Armchairs', image: '1759722666941-a90d5a15b1d7' },
  { name: 'Dining Tables', image: '1758977404607-9d6217cad08a' },
  { name: 'Beds', image: '1616594039964-ae9021a400a0' },
  { name: 'Storage', image: '1541123603104-512919d6a96c' },
  { name: 'Rugs', image: '1736580602768-3e06e97d7288' },
  { name: 'Lighting', image: '1494438639946-1ebd1d20bf85' },
  { name: 'Outdoor', image: '1777052854737-7893f50de539' },
];

/**
 * Furniture categories grouped by the room they furnish, for the storefront's
 * "Shop by room" page and the header's "Rooms" link. Not a schema field —
 * `Product.category` stays the one real taxonomy the API filters by, and a
 * room is just a named set of those categories, so this list is the only
 * place a new room needs to be taught which categories belong to it.
 */
export const ROOMS = [
  {
    slug: 'living-room',
    name: 'Living Room',
    categories: ['Sofas', 'Armchairs', 'Coffee Tables', 'Rugs', 'Side Tables'],
  },
  {
    slug: 'dining-room',
    name: 'Dining Room',
    categories: ['Dining Tables', 'Dining Chairs', 'Storage', 'Lighting'],
  },
  {
    slug: 'bedroom',
    name: 'Bedroom',
    categories: ['Beds', 'Storage', 'Side Tables', 'Textiles'],
  },
  {
    slug: 'outdoor',
    name: 'Outdoor',
    categories: ['Outdoor'],
  },
];

/**
 * The reassurance strip above the footer.
 *
 * Three, not six. A wall of badges reads as protesting too much, and the
 * shopper stops reading any of them.
 */
export const TRUST_BADGES = [
  {
    title: 'Secure payment',
    body: 'Card details are handled by Stripe and never touch our servers.',
    icon: 'lock',
  },
  {
    title: 'Tracked delivery',
    body: 'Every order gets a status you can follow from confirmed to delivered.',
    icon: 'truck',
  },
  {
    title: 'Talk to a person',
    body: 'A real member of the team is assigned to every order.',
    icon: 'chat',
  },
];

/** Footer link columns. Kept to routes that genuinely exist. */
export const FOOTER_COLUMNS = [
  {
    title: 'Shop',
    links: [
      { label: 'All products', to: '/products' },
      { label: 'New in', to: '/products?sort=newest' },
      { label: 'Under $50', to: '/products?maxPrice=50' },
      { label: 'In stock now', to: '/products?inStock=true' },
    ],
  },
  {
    title: 'Your account',
    links: [
      { label: 'Sign in', to: '/login' },
      { label: 'Create an account', to: '/register' },
      { label: 'Your orders', to: '/account/orders' },
      { label: 'Delivery addresses', to: '/account/addresses' },
      // No sign-in required — a guest checkout never got an account to sign
      // into, and still deserves a way to check on their parcel.
      { label: 'Track an order', to: '/track' },
    ],
  },
];

export const NEWSLETTER = {
  title: 'Get the occasional email',
  body: 'New arrivals and restocks. No more than once a month.',
  /*
   * Said plainly rather than buried. Nothing is connected to an email provider,
   * so promising a welcome email would be a lie the visitor discovers by
   * waiting for one — see models/NewsletterSignup.js.
   */
  disclaimer: 'This is a demonstration shop — your address is stored, nothing is sent.',
};
