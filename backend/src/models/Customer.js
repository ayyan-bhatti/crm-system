const mongoose = require('mongoose');
const { CUSTOMER_STATUS, CUSTOMER_STATUS_VALUES } = require('../config/constants');
const { MAX_TAG_LENGTH, MAX_TAGS_PER_CONTACT } = require('../config/marketing');
const { marketingConsentField } = require('./marketingConsent');

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Customer name is required'],
    trim: true,
    maxlength: [120, 'Name cannot exceed 120 characters'],
  },
  email: {
    type: String,
    required: [true, 'Customer email is required'],
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
  },
  phone: {
    type: String,
    trim: true,
    default: '',
  },

  /**
   * Where to deliver, as one free-text block rather than parsed fields.
   *
   * No street/city/postcode/country columns, deliberately. Address formats are
   * not the same shape across countries — postcodes are optional in some and
   * structured differently in others, and "state" does not exist everywhere —
   * so a fixed set of boxes forces every address that does not fit into the
   * wrong one. This app displays the address and never sorts, groups or
   * validates on its parts, so there is nothing to gain from splitting it and a
   * whole class of unenterable addresses to lose.
   *
   * The city field stays separate because the AI search filters on it, which is
   * a real reason for a field to exist on its own.
   */
  address: {
    type: String,
    trim: true,
    default: '',
    maxlength: [500, 'An address cannot be longer than 500 characters'],
  },
  company: {
    type: String,
    trim: true,
    default: '',
  },
  // Not in the original model list, but the natural-language search feature is
  // specified with a location example ("customers in Karachi ..."), so a city
  // field is needed for that query to mean anything.
  city: {
    type: String,
    trim: true,
    default: '',
  },
  status: {
    type: String,
    enum: {
      values: CUSTOMER_STATUS_VALUES,
      message: `Status must be one of: ${CUSTOMER_STATUS_VALUES.join(', ')}`,
    },
    default: CUSTOMER_STATUS.LEAD,
  },
  notes: {
    type: String,
    trim: true,
    default: '',
    maxlength: [2000, 'Notes cannot exceed 2000 characters'],
  },
  // The sales rep responsible for this customer.
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  /**
   * Who added the record, if a staff member did.
   *
   * Null for a customer matched or created from a storefront checkout — a
   * guest or a buyer's first order has no staff actor at all. Loosened from
   * `required: true` deliberately: every existing staff-facing write path
   * still always supplies it (customer creation has always been a staff-only
   * route), so nothing that worked before is affected. Only the new
   * storefront path relies on the loosening.
   */
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  /**
   * Channel-by-channel marketing consent. See models/marketingConsent.js.
   *
   * Every channel defaults to false, so a customer created by ANY path — a rep
   * typing them in, an approved change request, or `matchOrCreateCustomer`
   * upserting them from a storefront checkout — starts opted out of all three.
   * That is not a policy this model hopes its callers will follow: it is the
   * only value the schema can produce unless somebody explicitly sets another,
   * which is what makes "consent is never assumed" structural rather than
   * aspirational.
   */
  marketing: marketingConsentField(),

  /**
   * Free-form tags a staff member assigns by hand: "VIP", "wholesale".
   *
   * DELIBERATELY SEPARATE FROM THE COMPUTED SEGMENTS. "At risk" and "dormant"
   * are arithmetic about dates, recomputed on every read because they are true
   * only of a particular day. These are human judgements no calculation could
   * reach, so they are the half that has to be stored — and keeping the two in
   * different fields means a recomputation can never wipe a hand-assigned tag,
   * and a person can never assign one that then silently disagrees with the
   * data behind it.
   */
  marketingTags: {
    type: [String],
    default: [],
    validate: [
      {
        validator: (tags) => tags.length <= MAX_TAGS_PER_CONTACT,
        message: `A contact cannot have more than ${MAX_TAGS_PER_CONTACT} tags`,
      },
      {
        validator: (tags) =>
          tags.every((t) => typeof t === 'string' && t.length <= MAX_TAG_LENGTH),
        message: `A tag cannot be longer than ${MAX_TAG_LENGTH} characters`,
      },
    ],
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/* ---------------------------------------------------------------------------
 * INDEXES
 *
 * Each one below is here because a query in the codebase runs it. An index that
 * matches no query is not free — every write has to maintain it, and it takes
 * RAM that the indexes doing real work would otherwise use.
 * -------------------------------------------------------------------------*/

/*
 * REMOVED: a text index on name/email/company/notes.
 *
 * It was described as powering the AI search keyword fallback. It did not —
 * nothing in the codebase issues a `$text` query. The fallback builds
 * `containsRegex` clauses (see services/filterTranslator.js), and so does the
 * customer list, so the text index was maintained on every insert and update
 * and read by nothing.
 *
 * Worth being precise about why it could not have been used even if it were
 * wired up: `$text` matches whole words with stemming, so it finds "trading"
 * from "trade" but NOT "rach" inside "Karachi". A CRM search box is expected to
 * do substring matching, which is a different operation.
 */

/*
 * The sales-rep scope filter: { $or: [{ assignedTo }, { createdBy }] }.
 *
 * MongoDB cannot use one compound index for an $or — it evaluates each branch
 * separately and unions the results — so each branch needs its own index. Only
 * `assignedTo` was covered (as the second field of a compound index, which an
 * $or branch on its own cannot use anyway), and `createdBy` had none at all.
 *
 * The effect: every list request from a sales rep scanned the whole customer
 * collection. Invisible with the seed data, quadratic with real data.
 */
/*
 * WHY EVERY SORTING INDEX ENDS WITH `_id`
 *
 * `getSort` appends `_id` to every sort so the ordering is total (see the long
 * note in utils/queryHelpers.js — without it, tied documents can appear on two
 * pages at once). That fix has a consequence that is easy to miss and was
 * caught here by an explain() test rather than by reading the code:
 *
 *   an index on { createdAt: -1 } does NOT satisfy a sort of
 *   { createdAt: -1, _id: -1 }
 *
 * MongoDB falls back to fetching every matching document and sorting them in
 * memory. The index still exists, the query still returns the right answer, and
 * the only symptom is that it got slower — which is precisely the kind of
 * regression that goes unnoticed until the collection is large.
 *
 * So each index below carries `_id` in the same direction as its sort field.
 */

customerSchema.index({ assignedTo: 1, createdAt: -1, _id: -1 });
customerSchema.index({ createdBy: 1, createdAt: -1, _id: -1 });

/*
 * The default list ordering (newest first) for admins and managers, whose scope
 * filter is `{}` — so nothing else narrows the query and the sort is the entire
 * cost. `_id` is appended by getSort as a tiebreaker; it is part of every index
 * implicitly, so the sort is still satisfied.
 */
customerSchema.index({ createdAt: -1, _id: -1 });

/* The status filter on the list screen, ordered so the sort comes free with it. */
customerSchema.index({ status: 1, createdAt: -1, _id: -1 });

/*
 * Sorting by name — the picker's ordering, and an option on the list screen.
 */
customerSchema.index({ name: 1, _id: 1 });

/*
 * WHAT THESE INDEXES DO NOT FIX, stated plainly.
 *
 * The search box builds a case-insensitive, UNANCHORED regex (`/karachi/i`).
 * A btree index cannot serve that: without a `^` anchor there is no prefix to
 * seek to, so MongoDB scans. The indexes above make the FILTERING and SORTING
 * fast; they do not make substring search fast, and adding more of them would
 * not change that.
 *
 * The real fixes, in the order I would reach for them:
 *   1. anchor the search (`^karachi`), which turns it into an index seek but
 *      changes the feature to "starts with"
 *   2. MongoDB Atlas Search, which is built for this and is what a production
 *      deployment on Atlas should use
 *   3. a dedicated search service
 *
 * None is done here because the collection is small and the honest answer is
 * that it does not need one yet. Writing that down is better than implying the
 * index list has solved a problem it has not.
 */

module.exports = mongoose.model('Customer', customerSchema);
