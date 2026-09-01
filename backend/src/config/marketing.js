/**
 * Marketing enums, thresholds and defaults.
 *
 * A SEPARATE MODULE FROM constants.js, and re-exported from it so that every
 * existing `require('../config/constants')` keeps working and no caller has to
 * know there are two files. The split is for readability only: constants.js
 * was already four hundred lines describing the CRM's core nouns, and folding
 * a whole marketing subsystem into it would have buried both.
 *
 * Nothing here requires constants.js, so the re-export cannot become a cycle.
 */

/**
 * The channels a marketing message can go out on.
 *
 * A CHANNEL IS THE UNIT OF CONSENT, which is why this enum exists rather than
 * a single `marketingOptIn` boolean. Someone happy to receive an email is not
 * thereby happy to receive a WhatsApp message at nine on a Sunday — those are
 * different intrusions and people rate them differently. Bundling them into
 * one checkbox means the only way to stop the WhatsApp messages is to stop the
 * emails too, which is how a list loses subscribers it could have kept.
 *
 * Every consent field, every campaign, every recipient row and every send is
 * keyed by one of these three values, so a message can never be dispatched
 * without naming the channel it is being consented to.
 */
const CONTACT_CHANNEL = {
  EMAIL: 'email',
  SMS: 'sms',
  WHATSAPP: 'whatsapp',
};

const CONTACT_CHANNEL_VALUES = Object.values(CONTACT_CHANNEL);

/** Human wording, shared by the API, the consent checkboxes and the export. */
const CONTACT_CHANNEL_LABELS = {
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

/**
 * Which record a contactable person came from.
 *
 * NOT STORED ON ANY DOCUMENT — derived when the contact list is assembled, and
 * that is deliberate. A person can be a CRM customer AND a storefront buyer at
 * the same time (they are, the moment a rep enters someone who later makes an
 * account), so a stored `source` column would have to pick one and be wrong
 * about the other. Deriving it at read time lets a merged row say `both`,
 * which is the true answer.
 *
 * `guest` is a HISTORICAL category rather than a live one: storefront checkout
 * now requires an account, so no new guest contacts are created. The ones that
 * exist were created by `matchOrCreateCustomer` from checkouts placed before
 * accounts became mandatory. They are still real people who still have to be
 * reachable, filterable and excludable, so the category stays.
 */
const CONTACT_SOURCE = {
  CRM: 'crm',
  STOREFRONT: 'storefront',
  GUEST: 'guest',
  BOTH: 'both',
};

const CONTACT_SOURCE_VALUES = Object.values(CONTACT_SOURCE);

const CONTACT_SOURCE_LABELS = {
  crm: 'CRM',
  storefront: 'Storefront',
  guest: 'Guest',
  both: 'CRM + storefront',
};

/**
 * Automatically computed segment tags.
 *
 * COMPUTED, NOT STORED, for exactly the reason the delivery board's ranking is
 * computed: every one of these compares a date against TODAY, and a stored tag
 * is wrong the moment the clock passes midnight with nothing writing to the
 * record. "Dormant" is not a property of a customer, it is a property of a
 * customer *on a given day*.
 *
 * All of them are read off the churn-risk and customer-metrics calculations
 * that already exist — no new scoring logic, which was an explicit constraint
 * on this round.
 *
 *   new         first ordered within the last NEW_CUSTOMER_DAYS
 *   at_risk     churn risk is high — they have missed whole cycles
 *   dormant     churn risk is moderate, or the revenue trend says dormant
 *   healthy     ordering on their own schedule
 *   high_value  lifetime revenue at or above HIGH_VALUE_REVENUE
 *
 * A contact with no order history gets NONE of these, which is honest: there
 * is no pattern to describe. They remain reachable, exportable and targetable
 * by source rather than by segment.
 */
const AUTO_SEGMENT = {
  NEW: 'new',
  HEALTHY: 'healthy',
  AT_RISK: 'at_risk',
  DORMANT: 'dormant',
  HIGH_VALUE: 'high_value',
};

const AUTO_SEGMENT_VALUES = Object.values(AUTO_SEGMENT);

const AUTO_SEGMENT_LABELS = {
  new: 'New',
  healthy: 'Healthy',
  at_risk: 'At risk',
  dormant: 'Dormant',
  high_value: 'High value',
};

/** A contact counts as "new" if their FIRST order was within this many days. */
const NEW_CUSTOMER_DAYS = 30;

/**
 * Lifetime revenue at or above which a contact is tagged `high_value`.
 *
 * A FIXED THRESHOLD, and worth saying why this one is fixed when churn risk
 * went to such lengths to be relative. "High value" is a statement about the
 * BUSINESS's economics — what size of customer is worth treating differently —
 * not about the customer's own pattern. A percentile would make the tag mean
 * something different every time somebody new signed up, and would always tag
 * exactly the top n% however small the book was.
 */
const HIGH_VALUE_REVENUE = 1000;

/**
 * The longest a staff-assigned tag may be, and the most one contact may carry.
 *
 * Free-form tags are staff-supplied strings that end up in a filter, on a
 * screen and in a spreadsheet, so they are bounded at the model rather than
 * trusted. The count limit stops one contact accumulating a thousand tags and
 * turning every list render into a wall of pills.
 */
const MAX_TAG_LENGTH = 32;
const MAX_TAGS_PER_CONTACT = 12;

/**
 * A campaign's lifecycle.
 *
 *   draft             being written; nothing sent, nobody asked to approve
 *   pending_approval  a manager proposed it against an audience wider than
 *                     their own contacts; an admin has to agree
 *   scheduled         approved and queued, not yet dispatched
 *   sending           dispatch in progress
 *   sent              dispatch finished — which does NOT mean everyone got it.
 *                     See CampaignRecipient for per-person outcomes and
 *                     `failureCount` for the summary.
 *   failed            dispatch could not run at all
 *
 * `sent` and `failed` are terminal. A campaign is never re-sent: re-running one
 * is how a list gets messaged twice, so a repeat is a NEW campaign with its own
 * recipient rows and its own audit trail.
 */
const CAMPAIGN_STATUS = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  SCHEDULED: 'scheduled',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
};

const CAMPAIGN_STATUS_VALUES = Object.values(CAMPAIGN_STATUS);

/**
 * What happened to one person on one campaign.
 *
 * `skipped_no_consent` is a first-class outcome rather than an absence, and it
 * is the most important decision in this enum. A contact who matched the
 * audience but had not opted in must leave a ROW saying so. Filtered out
 * silently, the campaign would report "sent to 40" against an audience of 60
 * and nobody could tell whether the other 20 were unconsented, unreachable, or
 * a bug in the query.
 */
const RECIPIENT_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED_NO_CONSENT: 'skipped_no_consent',
};

const RECIPIENT_STATUS_VALUES = Object.values(RECIPIENT_STATUS);

/**
 * Pre-built audiences, each mapping onto data the CRM already computes.
 *
 * These are the shortcuts the campaign builder offers, resolved by
 * services/contactService — no new scoring, which was a stated constraint.
 *
 * `all` is a NAMED audience precisely so that "everyone" is an explicit,
 * auditable choice rather than what you get by leaving a filter blank.
 * `mine` is the one audience a manager can always send to without approval,
 * because it is by definition inside their own scope.
 */
const CAMPAIGN_AUDIENCE = {
  ALL: 'all',
  MINE: 'mine',
  AT_RISK: 'at_risk',
  DORMANT: 'dormant',
  NEW: 'new',
  HIGH_VALUE: 'high_value',
};

const CAMPAIGN_AUDIENCE_VALUES = Object.values(CAMPAIGN_AUDIENCE);

/** What each shortcut means, shown next to it in the builder. */
const CAMPAIGN_AUDIENCE_LABELS = {
  all: 'Everyone with an opt-in',
  mine: 'My own contacts',
  at_risk: 'At-risk customers (win-back)',
  dormant: 'Dormant customers (win-back)',
  new: 'New in the last 30 days (welcome)',
  high_value: 'High-value customers (VIP)',
};

/**
 * What kind of message an outbound record represents.
 *
 * `campaign` is a bulk send, `direct` a one-to-one message a staff member sent
 * by hand, and the two automations name themselves. An enum rather than a
 * boolean because "did the reorder reminder go out this week" has to be
 * answerable without inferring it from a subject line.
 */
const OUTBOUND_KIND = {
  CAMPAIGN: 'campaign',
  DIRECT: 'direct',
  REVIEW_REQUEST: 'review_request',
  REORDER_REMINDER: 'reorder_reminder',
};

const OUTBOUND_KIND_VALUES = Object.values(OUTBOUND_KIND);

const OUTBOUND_KIND_LABELS = {
  campaign: 'Campaign',
  direct: 'Direct message',
  review_request: 'Review request',
  reorder_reminder: 'Reorder reminder',
};

/**
 * How many days after DELIVERY to ask for a review. Configurable; default 5.
 *
 * Five rather than one or two: the parcel has to have been opened and used
 * before "how did it go" is a question the person can answer, and a request
 * that arrives before the thing has been tried produces either silence or a
 * review of the courier. Five rather than ten because the further out it goes
 * the less the purchase is on their mind.
 *
 * The WINDOW matters as much as the delay — see POST_SALE_WINDOW_DAYS.
 */
const REVIEW_REQUEST_DELAY_DAYS = 5;

/** The bounds an admin may configure the delay to. */
const REVIEW_REQUEST_DELAY_MIN = 1;
const REVIEW_REQUEST_DELAY_MAX = 30;

/**
 * How far back a post-sale job will look.
 *
 * WITHOUT THIS, THE FIRST RUN MAILS THE ENTIRE ORDER HISTORY. The idempotency
 * flags start null on every order ever placed, so "delivered more than five
 * days ago and not yet asked" matches years of orders the first time the job
 * runs. That is not hypothetical — it is the default behaviour of the obvious
 * implementation, and the blast radius is every customer the business has.
 *
 * So the job only ever considers orders delivered inside this window. Anything
 * older is skipped rather than mailed, which is the right way round: a review
 * request about a purchase from last spring is worse than no review request.
 */
const POST_SALE_WINDOW_DAYS = 30;

/**
 * How close to their own reorder point a customer must be to get a nudge.
 *
 * Expressed as a fraction of the customer's OWN typical gap, reusing exactly
 * the cadence churn risk already measures. At 0.8 they are four-fifths through
 * their normal cycle — approaching, not overdue.
 *
 * The UPPER bound is what keeps this distinct from churn risk. Past 1.2 gaps
 * they are late rather than due, and that is churn's job. A customer must not
 * be both "coming up for a reorder" and "going quiet" in the same week, which
 * is precisely how a CRM starts to look automated.
 */
const REORDER_NUDGE_FROM_GAPS = 0.8;
const REORDER_NUDGE_TO_GAPS = 1.2;

/**
 * The most recipients one campaign dispatch will attempt.
 *
 * A ceiling on blast radius, not a performance knob. The audience comes from a
 * database query and a wrong filter is one character away from "everybody";
 * this is what makes that mistake recoverable. Exceeding it REFUSES the send
 * rather than truncating it — a campaign that silently reached three-fifths of
 * its list is worse than one that did not go at all.
 */
const MAX_CAMPAIGN_RECIPIENTS = 5000;

/**
 * How many messages go out at once during a bulk send.
 *
 * The brief asks for batching rather than "firing hundreds of requests at
 * once", and the reason is the transport at the other end: every provider rate
 * limits, and a burst that trips the limit fails messages that would have been
 * delivered fine a second later.
 */
const CAMPAIGN_BATCH_SIZE = 25;

/** Field caps for campaign content, enforced at the model and the validator. */
const MAX_CAMPAIGN_SUBJECT = 150;
const MAX_CAMPAIGN_BODY = 4000;
/**
 * A single SMS segment is 160 GSM-7 characters; longer messages are split and
 * billed per segment. 320 allows two, which is enough for a real message and
 * still a deliberate ceiling rather than an accident.
 */
const MAX_SMS_LENGTH = 320;
/** Meta's limit for a free-form WhatsApp message body is 4096. */
const MAX_WHATSAPP_LENGTH = 1000;
const MAX_SOCIAL_POST = 600;

module.exports = {
  CONTACT_CHANNEL,
  CONTACT_CHANNEL_VALUES,
  CONTACT_CHANNEL_LABELS,
  CONTACT_SOURCE,
  CONTACT_SOURCE_VALUES,
  CONTACT_SOURCE_LABELS,
  AUTO_SEGMENT,
  AUTO_SEGMENT_VALUES,
  AUTO_SEGMENT_LABELS,
  NEW_CUSTOMER_DAYS,
  HIGH_VALUE_REVENUE,
  MAX_TAG_LENGTH,
  MAX_TAGS_PER_CONTACT,
  CAMPAIGN_STATUS,
  CAMPAIGN_STATUS_VALUES,
  RECIPIENT_STATUS,
  RECIPIENT_STATUS_VALUES,
  CAMPAIGN_AUDIENCE,
  CAMPAIGN_AUDIENCE_VALUES,
  CAMPAIGN_AUDIENCE_LABELS,
  OUTBOUND_KIND,
  OUTBOUND_KIND_VALUES,
  OUTBOUND_KIND_LABELS,
  REVIEW_REQUEST_DELAY_DAYS,
  REVIEW_REQUEST_DELAY_MIN,
  REVIEW_REQUEST_DELAY_MAX,
  POST_SALE_WINDOW_DAYS,
  REORDER_NUDGE_FROM_GAPS,
  REORDER_NUDGE_TO_GAPS,
  MAX_CAMPAIGN_RECIPIENTS,
  CAMPAIGN_BATCH_SIZE,
  MAX_CAMPAIGN_SUBJECT,
  MAX_CAMPAIGN_BODY,
  MAX_SMS_LENGTH,
  MAX_WHATSAPP_LENGTH,
  MAX_SOCIAL_POST,
};
