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
  headline: 'Made to be worn, not just bought.',
  body:
    'A small catalogue, chosen carefully. Search it in plain language — ' +
    '"something for a rainy weekend under $50" works.',
  primaryCta: { label: 'Shop everything', to: '/products' },
  secondaryCta: { label: 'Browse by category', to: '/products?view=categories' },
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
    eyebrow: 'The workspace edit',
    headline: 'Everything for the desk you actually sit at',
    body: 'Chairs, desks and the small things that make eight hours bearable.',
    cta: 'Shop furniture',
    category: 'Furniture',
    tone: 'ink',
  },
  {
    eyebrow: 'Restock',
    headline: 'The bits that always run out',
    body: 'Paper, markers, and the rest of the drawer nobody thinks about until it is empty.',
    cta: 'Shop supplies',
    category: 'Supplies',
    tone: 'wash',
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
