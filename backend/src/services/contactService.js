const Customer = require('../models/Customer');
const Buyer = require('../models/Buyer');
const Order = require('../models/Order');
const { computeMetricsForCustomers } = require('./customerMetrics');
const { assessChurnRisk, LEVELS } = require('./churnRisk');
const { hasFullRecordAccess } = require('../middleware/roles');
const {
  CONTACT_CHANNEL_VALUES,
  CONTACT_SOURCE,
  AUTO_SEGMENT,
  NEW_CUSTOMER_DAYS,
  HIGH_VALUE_REVENUE,
  CAMPAIGN_AUDIENCE,
} = require('../config/marketing');

/**
 * Every contactable person, as one list.
 *
 * ============================================================================
 * THE MERGE, AND WHY IT IS BY EMAIL
 * ============================================================================
 *
 * A person can exist in this system twice: as a `Customer` (a rep typed them
 * in, or a checkout created one) and as a `Buyer` (they made a storefront
 * account). Those are two documents about one human, and a marketing list that
 * shows both is a list that emails them twice.
 *
 * They are merged on EMAIL, lower-cased, and that is not an arbitrary choice —
 * it is the key the rest of the app already dedupes on. `matchOrCreateCustomer`
 * matches a checkout to an existing `Customer` by email; `Buyer.email` is
 * unique. Using anything else here would mean this screen had a different idea
 * of "the same person" from the code that creates the records, and the two
 * would disagree in exactly the cases that matter.
 *
 * `linkedCustomerId` is deliberately NOT the merge key, though it exists and
 * points the right way. It is set at a buyer's FIRST CHECKOUT, so a buyer who
 * registered and never ordered has none — and that person is precisely who a
 * welcome campaign is for. Merging on the link alone would show them as a
 * separate contact from their own CRM record the moment a rep created one.
 * The link is used as a second signal, never as the only one.
 *
 * ============================================================================
 * CONSENT WHEN THE TWO RECORDS DISAGREE
 * ============================================================================
 *
 * Every write path in this app propagates consent to BOTH records — see
 * `unsubscribeService.setConsentEverywhere` — so in normal operation they
 * cannot diverge. They can still diverge for data that predates this round, or
 * if a record is edited directly in the database.
 *
 * The reconciliation is THE MOST RECENT DECISION WINS, comparing `optInAt`
 * against `optOutAt` across both records. The two obvious alternatives are
 * both wrong:
 *
 *   "any opt-in wins"   would resurrect a consent somebody has since
 *                       withdrawn, which is the exact harm the feature exists
 *                       to prevent.
 *   "any opt-out wins"  fails closed, which sounds safe, but permanently
 *                       silences anyone who ever unsubscribed and later
 *                       deliberately opted back in. Refusing to honour a
 *                       person's current wish is not caution.
 *
 * A decision with no timestamp at all is treated as older than any timestamped
 * one, so real evidence beats a bare boolean.
 */

/** Days in milliseconds, for the "new customer" window. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reconcile one channel's consent across the records for one person.
 *
 * @param {object[]} records Customer and/or Buyer documents
 * @param {string} channel
 */
function reconcileChannel(records, channel) {
  let best = { optIn: false, optInAt: null, optOutAt: null };
  let bestAt = -Infinity;
  let sawAny = false;

  for (const record of records) {
    const block = record?.marketing?.[channel];
    if (!block) continue;

    sawAny = true;

    const decidedAt = block.optIn
      ? block.optInAt?.getTime?.() ?? block.optInAt ?? null
      : block.optOutAt?.getTime?.() ?? block.optOutAt ?? null;

    // An undated decision loses to any dated one, and to nothing else.
    const rank = decidedAt === null || decidedAt === undefined ? -1 : Number(decidedAt);

    if (rank > bestAt) {
      bestAt = rank;
      best = {
        optIn: Boolean(block.optIn),
        optInAt: block.optInAt || null,
        optOutAt: block.optOutAt || null,
      };
    }
  }

  return sawAny ? best : { optIn: false, optInAt: null, optOutAt: null };
}

function reconcileConsent(records) {
  const consent = {};
  for (const channel of CONTACT_CHANNEL_VALUES) {
    consent[channel] = reconcileChannel(records, channel);
  }
  return consent;
}

/**
 * Which of the four sources this merged contact represents.
 *
 * `guest` is the interesting one. A `Customer` with no `createdBy` was not
 * entered by a member of staff — it was upserted by `matchOrCreateCustomer`
 * from a storefront checkout — and if there is no `Buyer` for that email
 * either, the person never had an account. That is a guest contact, and they
 * exist because storefront checkout did not always require an account. No new
 * ones are created; the ones there are still have to be reachable and, more
 * importantly, still have to be EXCLUDABLE by a filter.
 */
function deriveSource(customer, buyer) {
  if (customer && buyer) return CONTACT_SOURCE.BOTH;
  if (buyer) return CONTACT_SOURCE.STOREFRONT;
  return customer?.createdBy ? CONTACT_SOURCE.CRM : CONTACT_SOURCE.GUEST;
}

/**
 * The computed segment tags for one contact.
 *
 * ENTIRELY REUSED ARITHMETIC. `assessChurnRisk` is the existing per-customer
 * rule, unchanged, and the trend comes from the existing metrics. The round's
 * constraint was explicit that these must not become a second scoring system,
 * and the reason is worth repeating: a contact tagged "at risk" here and
 * "on track" on their own summary page would make both screens untrustworthy,
 * and there is no way for a user to tell which one is lying.
 *
 * A contact with no orders gets NO tags rather than a "dormant" one. There is
 * no pattern to describe, and calling somebody dormant on the strength of
 * never having bought anything is the false positive that teaches people to
 * ignore the column.
 */
function deriveSegments(metrics, now = new Date()) {
  if (!metrics || !metrics.orderCount) return [];

  const segments = [];
  const churn = assessChurnRisk(metrics);

  if (churn.level === LEVELS.HIGH) {
    segments.push(AUTO_SEGMENT.AT_RISK);
  } else if (churn.level === LEVELS.MODERATE || metrics.trend === 'dormant') {
    segments.push(AUTO_SEGMENT.DORMANT);
  } else if (churn.level === LEVELS.LOW) {
    segments.push(AUTO_SEGMENT.HEALTHY);
  }

  /*
   * `new` is orthogonal to the health tags rather than exclusive with them —
   * somebody can be new AND healthy, and both are worth knowing. It is keyed
   * on the FIRST order rather than the most recent, because "new customer"
   * means new to the business, not recently active.
   */
  if (
    metrics.firstOrderDate &&
    now.getTime() - new Date(metrics.firstOrderDate).getTime() <= NEW_CUSTOMER_DAYS * DAY_MS
  ) {
    segments.push(AUTO_SEGMENT.NEW);
  }

  if (metrics.totalRevenue >= HIGH_VALUE_REVENUE) {
    segments.push(AUTO_SEGMENT.HIGH_VALUE);
  }

  return segments;
}

/**
 * Which `Customer` ids a user is allowed to see contacts for.
 *
 * Mirrors the record permissions that already exist rather than inventing a
 * parallel set, which is the same discipline `usePermissions` follows:
 *
 *   admin, manager  every contact. This is exactly their existing customer-book
 *                   access — `hasFullRecordAccess` — and deliberately not
 *                   narrowed here. A manager who can already open every
 *                   customer record gains nothing from being shown a shorter
 *                   list, and a second, different scope would be a second
 *                   thing to keep in step.
 *
 *   sales rep       the customers on orders ASSIGNED TO THEM, and nothing else.
 *                   A rep has no customer book at all in this system, and this
 *                   screen must not become one. What they do have is the
 *                   contact details of people whose orders they are fulfilling
 *                   — the same narrow, order-scoped hole the order endpoints
 *                   already open, expressed here so that this screen cannot
 *                   widen it.
 *
 * @returns {Promise<{ unrestricted: boolean, customerIds: string[] }>}
 */
async function visibleCustomerIds(user) {
  if (hasFullRecordAccess(user)) return { unrestricted: true, customerIds: [] };

  const ids = await Order.distinct('customer', { assignedTo: user._id });

  return { unrestricted: false, customerIds: ids.map((id) => String(id)) };
}

/**
 * Build the merged contact list for a user.
 *
 * @param {object} user the staff member asking
 * @param {object} [filters]
 * @param {string} [filters.source]   one of CONTACT_SOURCE_VALUES
 * @param {string} [filters.segment]  one of AUTO_SEGMENT_VALUES
 * @param {string} [filters.tag]      a hand-assigned tag
 * @param {string} [filters.channel]  used with `optedIn` below
 * @param {string} [filters.optedIn]  'yes' | 'no' — requires `channel`
 * @param {string} [filters.search]   name or email substring
 * @returns {Promise<object[]>} merged contacts, newest first
 */
async function listContacts(user, filters = {}) {
  const scope = await visibleCustomerIds(user);

  /* ---- 1. the candidate records ---------------------------------------- */

  const customerQuery = scope.unrestricted ? {} : { _id: { $in: scope.customerIds } };
  const customers = await Customer.find(customerQuery).lean();

  /*
   * A sales rep sees buyers only where the buyer IS one of the customers they
   * can already see. Any other rule would hand a rep storefront accounts they
   * have no order for, which is the customer book by another name.
   */
  const customerEmails = new Set(customers.map((c) => c.email));

  const buyers = scope.unrestricted
    ? await Buyer.find({}).lean()
    : await Buyer.find({ email: { $in: [...customerEmails] } }).lean();

  /* ---- 2. merge on email ----------------------------------------------- */

  const byEmail = new Map();

  const slot = (email) => {
    const key = String(email || '').toLowerCase().trim();
    if (!key) return null;
    if (!byEmail.has(key)) byEmail.set(key, { email: key, customer: null, buyer: null });
    return byEmail.get(key);
  };

  for (const customer of customers) {
    const entry = slot(customer.email);
    /*
     * Two `Customer` records CAN share an email — nothing in the schema
     * forbids it, and duplicates predate the upsert that now prevents them.
     * The oldest wins, because it is the one the rest of the system has been
     * attaching orders and history to.
     */
    if (entry && (!entry.customer || entry.customer.createdAt > customer.createdAt)) {
      entry.customer = customer;
    }
  }

  for (const buyer of buyers) {
    const entry = slot(buyer.email);
    if (entry) entry.buyer = buyer;
  }

  /* ---- 3. metrics and segments, in one query for the whole page --------- */

  const customerIds = [...byEmail.values()].map((e) => e.customer?._id).filter(Boolean);
  const metricsById = await computeMetricsForCustomers(customerIds);

  const now = new Date();

  let contacts = [...byEmail.values()].map((entry) =>
    buildContact(entry, metricsById.get(String(entry.customer?._id)), now)
  );

  /* ---- 4. filters ------------------------------------------------------ */

  contacts = applyFilters(contacts, filters);

  /*
   * Newest first, matching every other list in this app. Sorted here rather
   * than in the database because the list is a MERGE of two collections — a
   * database sort would order each half correctly and the union not at all.
   */
  contacts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return contacts;
}

/** Assemble one merged row. */
function buildContact(entry, metrics, now) {
  const { customer, buyer } = entry;
  const records = [customer, buyer].filter(Boolean);

  const manualTags = [
    ...new Set([...(customer?.marketingTags || []), ...(buyer?.marketingTags || [])]),
  ];

  return {
    /*
     * THE EMAIL IS THE ID. A merged contact is not a document, so it has no
     * `_id` of its own — and inventing a synthetic one would be a value that
     * changes whenever the merge does. Every write against a contact
     * (consent, tags) is addressed by email and applied to every underlying
     * record, which is the same rule the merge itself is built on.
     */
    email: entry.email,
    customerId: customer?._id || null,
    buyerId: buyer?._id || null,

    name: customer?.name || buyer?.name || '',
    phone: customer?.phone || '',
    company: customer?.company || '',
    city: customer?.city || '',

    source: deriveSource(customer, buyer),
    consent: reconcileConsent(records),

    segments: deriveSegments(metrics, now),
    tags: manualTags,

    assignedTo: customer?.assignedTo || null,
    createdBy: customer?.createdBy || null,

    orderCount: metrics?.orderCount || 0,
    totalRevenue: metrics?.totalRevenue || 0,
    lastOrderDate: metrics?.lastOrderDate || null,

    createdAt: customer?.createdAt || buyer?.createdAt || new Date(0),
  };
}

/**
 * Apply the screen's filters.
 *
 * IN MEMORY, and for the same reason the delivery board ranks in memory: the
 * list is a merge of two collections plus a computed segment, and none of
 * those three things is a field the database can filter on. Bounded by the
 * scope query above, which is where the real narrowing happens.
 */
function applyFilters(contacts, filters) {
  let result = contacts;

  if (filters.source) {
    /*
     * `both` is a real value a contact can have, so filtering for `crm` has to
     * decide whether a CRM-and-storefront contact counts. It does: they ARE a
     * CRM contact, plus something else. Anything stricter would make the three
     * source filters fail to add up to the whole list, which is the kind of
     * arithmetic a user notices and cannot explain.
     */
    const wanted = filters.source;
    result = result.filter((c) => {
      if (c.source === wanted) return true;
      if (c.source !== CONTACT_SOURCE.BOTH) return false;
      return wanted === CONTACT_SOURCE.CRM || wanted === CONTACT_SOURCE.STOREFRONT;
    });
  }

  if (filters.segment) {
    result = result.filter((c) => c.segments.includes(filters.segment));
  }

  if (filters.tag) {
    const tag = String(filters.tag).toLowerCase();
    result = result.filter((c) => c.tags.some((t) => t.toLowerCase() === tag));
  }

  if (filters.channel && (filters.optedIn === 'yes' || filters.optedIn === 'no')) {
    const wanted = filters.optedIn === 'yes';
    result = result.filter((c) => Boolean(c.consent[filters.channel]?.optIn) === wanted);
  }

  if (filters.search) {
    const needle = String(filters.search).toLowerCase();
    result = result.filter(
      (c) => c.name.toLowerCase().includes(needle) || c.email.includes(needle)
    );
  }

  return result;
}

/**
 * Resolve one contact by email, for an individual send.
 *
 * Returns the same shape `listContacts` produces, so the consent gate cannot
 * behave differently for a one-to-one message than for a campaign — which is
 * exactly the divergence that would let a direct send bypass an opt-out.
 */
async function findContactByEmail(email) {
  const key = String(email || '').toLowerCase().trim();
  if (!key) return null;

  const [customers, buyer] = await Promise.all([
    Customer.find({ email: key }).sort({ createdAt: 1 }).lean(),
    Buyer.findOne({ email: key }).lean(),
  ]);

  const customer = customers[0] || null;
  if (!customer && !buyer) return null;

  const metricsById = customer
    ? await computeMetricsForCustomers([customer._id])
    : new Map();

  return buildContact(
    { email: key, customer, buyer },
    metricsById.get(String(customer?._id)),
    new Date()
  );
}

/**
 * Is this contact inside the actor's OWN scope?
 *
 * This is the question the campaign approval rule turns on, and it needed
 * defining because THIS CODEBASE HAS NO TEAM MODEL. There is no `managerId` on
 * `User`, no reporting line, no team collection — managers see every record
 * and own none of them, which is a deliberate design from earlier rounds
 * ("managers run the business, admins own the record").
 *
 * So "their own team's contacts" is read as the contacts they are personally
 * connected to: assigned to them, or created by them. That preserves the
 * intent of the rule — a manager acts freely within their own patch and needs
 * agreement to reach beyond it — without inventing an org chart that nothing
 * else in the system would use or maintain.
 *
 * The alternative considered and rejected was adding `managerId` to `User` and
 * defining a team as a manager's reps. It is closer to the brief's wording and
 * it is a whole feature: a field, an admin screen to set it, a migration for
 * existing users, and a new way for permissions to be wrong. Recorded here
 * rather than in a commit message because the next person will wonder.
 */
function isWithinOwnScope(contact, user) {
  if (!user) return false;

  const mine = String(user._id);
  const idOf = (value) => (value && typeof value === 'object' ? value._id : value);

  return [contact.assignedTo, contact.createdBy].some(
    (value) => value != null && String(idOf(value)) === mine
  );
}

/**
 * Resolve a campaign's audience definition into contacts.
 *
 * Resolved against the SENDER'S OWN VISIBILITY, so a campaign can never reach
 * somebody its author could not have looked up. That matters most for the
 * `all` preset: "everyone" means everyone the sender can see, not everyone in
 * the database, and the two differ for a sales rep — who cannot launch
 * campaigns at all, but whose exclusion should follow from the scope rather
 * than only from the role check.
 */
async function resolveAudience(audience, user) {
  const filters = {
    source: audience.source || '',
    tag: audience.tag || '',
  };

  /*
   * The preset and the explicit segment filter are the same axis, so the
   * preset fills it in unless one was given. `all` and `mine` set no segment
   * at all — they are about WHO rather than about state.
   */
  if (audience.segment) {
    filters.segment = audience.segment;
  } else if (
    audience.preset &&
    audience.preset !== CAMPAIGN_AUDIENCE.ALL &&
    audience.preset !== CAMPAIGN_AUDIENCE.MINE
  ) {
    filters.segment = audience.preset;
  }

  const contacts = await listContacts(user, filters);

  if (audience.preset === CAMPAIGN_AUDIENCE.MINE) {
    return contacts.filter((c) => isWithinOwnScope(c, user));
  }

  return contacts;
}

module.exports = {
  listContacts,
  findContactByEmail,
  resolveAudience,
  isWithinOwnScope,
  visibleCustomerIds,
  deriveSegments,
  deriveSource,
  reconcileConsent,
};
