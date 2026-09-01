/**
 * Enum values shared across models, middleware and controllers.
 *
 * Defining them once means a typo like 'sales-rep' fails at import time in your
 * editor rather than silently never matching a role check.
 */

const ROLES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  SALES_REP: 'sales_rep',
};

/**
 * Account lifecycle.
 *
 *   pending      waiting on someone else. Cannot sign in. TWO different
 *                situations share this status, and they are told apart by
 *                whether `requestedRole` is set:
 *                  invited     an admin created the account; the person has
 *                              not yet set a password through their link.
 *                  requested   the person signed up and chose a role; an admin
 *                              has not yet approved them.
 *                The distinction matters at the login screen, where "use your
 *                invitation link" and "awaiting approval" send someone to two
 *                completely different places.
 *   active       normal.
 *   rejected     an admin declined a sign-up request. Cannot sign in. Kept
 *                rather than deleted — see the note in userController's reject
 *                handler for why.
 *   deactivated  an offboarded employee. Cannot sign in, and existing sessions
 *                stop working on their next request — see middleware/auth.
 *
 * Deactivation rather than deletion is the default for a departing colleague:
 * deleting the account would orphan every customer and order that references
 * it as `createdBy`, and the audit trail would lose the name behind past
 * actions. Deletion stays available for a record created by mistake.
 */
const USER_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  DEACTIVATED: 'deactivated',
  REJECTED: 'rejected',
};

/**
 * Roles a person may REQUEST for themselves when signing up.
 *
 * Admin is absent, and that is the point rather than an oversight. A request is
 * made by an anonymous member of the public; letting them ask for admin would
 * mean the only thing standing between a stranger and full control of the CRM
 * is an administrator reading a form carefully at the end of a long day.
 * Promotion to admin is a deliberate act by an existing admin, on the user
 * management screen, where the consequence is visible next to the person.
 */
const REQUESTABLE_ROLES = [ROLES.MANAGER, ROLES.SALES_REP];

/**
 * A proposed change waiting on an administrator.
 *
 * Pending means nothing has happened to the real record yet — which is the
 * whole design: see models/ChangeRequest for why the change is stored rather
 * than applied and undone.
 */
const CHANGE_REQUEST_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
};

const CUSTOMER_STATUS = {
  LEAD: 'lead',
  ACTIVE: 'active',
  INACTIVE: 'inactive',
};

/**
 * The COMMERCIAL state of an order: does it count, and has its stock moved.
 *
 * Deliberately left exactly as it was when delivery tracking arrived. It would
 * have been tempting to grow this enum into the delivery sequence — one status
 * field, one badge, less to explain — and it is the wrong shape, for a reason
 * worth writing down because the alternative looks simpler right up until it
 * breaks:
 *
 *   `completed` is what MOVES STOCK. Every stock guarantee in this app hangs
 *   off that transition. Delivery is a different axis entirely — an order can
 *   be shipped and not yet delivered while being, commercially, entirely
 *   settled — and folding the two together would mean stock moved on arrival
 *   at the customer's door rather than when the parcel left, which is both
 *   wrong and unfixable without re-deriving the whole thing.
 *
 * So: this answers "is this sale real and has inventory moved". FULFILMENT_STATUS
 * below answers "where is the parcel". See models/Order.js.
 */
const ORDER_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

/**
 * Where the parcel is. The buyer-facing half of an order's state.
 *
 * `processing` is the default for every order, including every order that
 * existed before this field did — which is true of them in the only sense that
 * matters: nobody has said it shipped.
 *
 * `cancelled` is here as well as in ORDER_STATUS, and that is not duplication.
 * A cancelled order has no delivery state, and a timeline that still reads
 * "Processing" under a cancelled order is a lie the buyer will notice.
 */
const FULFILMENT_STATUS = {
  PROCESSING: 'processing',
  CONFIRMED: 'confirmed',
  /**
   * Picked and packed, waiting for a courier.
   *
   * Added because "Confirmed" and "Shipped" leave the longest real gap in the
   * process unexplained — the parcel exists, it is on a shelf, and nobody has
   * collected it. A customer watching "Confirmed" for two days assumes nothing
   * is happening; "At the warehouse" says something did.
   *
   * Placed BEFORE `shipped` deliberately: the sequence is compared by index to
   * decide whether a status change moves forward, and to decide when a delivery
   * estimate becomes mandatory. Appending it would have made "at the warehouse"
   * a step after the parcel had already left, which is nonsense the ordering
   * would then have enforced.
   */
  AT_WAREHOUSE: 'at_warehouse',
  SHIPPED: 'shipped',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

/**
 * The delivery stages in order, for the buyer's timeline and for validating a
 * staff member's status change. `cancelled` is absent on purpose: it is an exit
 * from the sequence, not a step along it, so it has no position to compare.
 */
const FULFILMENT_SEQUENCE = [
  FULFILMENT_STATUS.PROCESSING,
  FULFILMENT_STATUS.CONFIRMED,
  FULFILMENT_STATUS.AT_WAREHOUSE,
  FULFILMENT_STATUS.SHIPPED,
  FULFILMENT_STATUS.OUT_FOR_DELIVERY,
  FULFILMENT_STATUS.DELIVERED,
];

/** Human wording, shared by the API's audit notes and the UI's badges. */
const FULFILMENT_LABELS = {
  processing: 'Processing',
  confirmed: 'Confirmed',
  at_warehouse: 'At the warehouse',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/**
 * How fast the shop promises to get it there.
 *
 * A SERVICE LEVEL, NOT A LINE ITEM — express carries no surcharge here, and
 * that is a deliberate limit rather than an oversight. Charging for it would
 * mean the delivery fee joining the order total, the Stripe line items, the
 * refund amount and the stock-restoring cancellation path, and every one of
 * those is somewhere a wrong number becomes a wrong amount of money. The
 * promise is modelled; the pricing is not. Adding a fee later means touching
 * exactly those five places, knowingly.
 *
 * `days` is what turns a choice into a date: an order's estimated delivery is
 * set from it AT CREATION rather than being left blank until somebody marks the
 * parcel shipped. A buyer deciding between next-day and standard needs the date
 * before they pay, not after a staff member gets round to it.
 */
const DELIVERY_SPEED = {
  STANDARD: 'standard',
  EXPRESS: 'express',
};

const DELIVERY_OPTIONS = [
  {
    value: DELIVERY_SPEED.STANDARD,
    label: 'Standard delivery',
    hint: 'Arrives in 3–5 working days.',
    days: 4,
  },
  {
    value: DELIVERY_SPEED.EXPRESS,
    label: 'Express — next day',
    hint: 'Ordered today, with you tomorrow. Free while we are getting started.',
    days: 1,
  },
];

/** Days to add to "now" for a given speed, falling back to standard. */
function deliveryDaysFor(speed) {
  const option = DELIVERY_OPTIONS.find((o) => o.value === speed);
  return (option || DELIVERY_OPTIONS[0]).days;
}

/** The promised date for an order placed now at this speed. */
function estimatedDeliveryFor(speed, from = new Date()) {
  const due = new Date(from);
  due.setDate(due.getDate() + deliveryDaysFor(speed));
  return due;
}

/**
 * Which courier a shipped order went out with, if anyone said so.
 *
 * `null` remains the default and the correct value for every order that is not
 * shipped through a third-party courier at all — plenty of small orders are
 * handed over in person or by a driver with no tracking number to give.
 *
 * Only `dhl` has a live status lookup wired up (services/courierService.js),
 * because DHL is the only one of the three with a genuinely self-serve, free
 * developer sandbox (developer.dhl.com). TCS and Leopards both require a
 * merchant/business account application before they issue API credentials at
 * all — there is no signup flow a solo developer can complete today — so for
 * those two this app only builds a link to the courier's own public tracking
 * page, which needs no account and is still a real, working link. `other`
 * covers any courier not in this list; same treatment as tcs/leopards.
 */
const COURIER = {
  TCS: 'tcs',
  LEOPARDS: 'leopards',
  DHL: 'dhl',
  OTHER: 'other',
};

const COURIER_LABELS = {
  tcs: 'TCS',
  leopards: 'Leopards Courier',
  dhl: 'DHL',
  other: 'Other courier',
};

/** Default stock level at or below which a product counts as "low stock". */
const DEFAULT_LOW_STOCK_THRESHOLD = 10;

/**
 * How a storefront order is paid.
 *
 * `card` IS NO LONGER INFORMATIONAL, and that is the substantive change here.
 * It now means "paid through Stripe Checkout", and an order carrying it has
 * genuinely had money taken — see services/stripeService.js and the webhook.
 * The other two remain what they always were: a note to whoever fulfils the
 * order about how they will collect, with no processor involved.
 *
 * The old values are kept rather than replaced. Orders placed before Stripe
 * existed carry them, and rewriting history to say a demo order was paid by
 * card would be a lie told by a migration.
 */
const PAYMENT_METHOD = {
  COD: 'cod',
  CARD: 'card',
  BANK_TRANSFER: 'bank_transfer',
};

/** Which payment methods actually go through Stripe. */
const STRIPE_PAYMENT_METHODS = [PAYMENT_METHOD.CARD];

/**
 * Whether money has moved, tracked separately from how it was meant to move.
 *
 * `unpaid` is correct for a cash-on-delivery order AND for every order placed
 * before payments existed — in both cases this app has not seen a payment, and
 * saying so is more useful than a null nobody can interpret.
 */
const PAYMENT_STATUS = {
  UNPAID: 'unpaid',
  PAID: 'paid',
  REFUNDED: 'refunded',
  FAILED: 'failed',
};

/**
 * The lifecycle of a checkout that has been started but not yet paid for.
 *
 * This exists because of a rule stated plainly in the round-3 brief and worth
 * repeating at the definition: NO ORDER IS CREATED UNTIL THE WEBHOOK CONFIRMS
 * PAYMENT. Between "buyer clicked Pay" and "Stripe told us it worked" there is
 * a real interval, and something has to hold the intent across it without
 * reserving stock. That something is a PendingCheckout in `pending`.
 */
const PENDING_CHECKOUT_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'expired',
};

/**
 * The most rows one customer-import spreadsheet may contain.
 *
 * A ceiling for the same reason `MAX_ORDER_QTY` is one: without it, a single
 * upload is an unbounded number of writes against the database inside one
 * HTTP request, which on a serverless function means an unbounded amount of
 * time inside a function that has a hard execution limit either way — this
 * just turns "times out and leaves the import half-done with no summary" into
 * a clear, immediate "split this into smaller files" refusal.
 */
const MAX_CUSTOMER_IMPORT_ROWS = 1000;

/**
 * The most of one product a single storefront order may contain.
 *
 * A ceiling rather than a preference. Without one, a cart line's quantity is
 * unbounded — `existing.quantity += qty` on a repeated add climbs as far as
 * anyone cares to push it — and one request can lay claim to an entire line's
 * inventory. That is a denial-of-stock hole, not a UI detail.
 *
 * It lives here because three places have to agree on it and drift between them
 * is exactly the bug: the storefront publishes it so the quantity control can
 * offer the right range, the cart enforces it on write, and the checkout is the
 * last gate before stock actually moves.
 *
 * Staff-placed orders are NOT subject to it. A sales rep entering a wholesale
 * order for 500 units is doing their job, and the limit exists to bound what an
 * anonymous internet visitor can do.
 */
const MAX_ORDER_QTY = 20;

/**
 * The marketing subsystem's own enums and thresholds, spread in here so that
 * `require('../config/constants')` remains the single place anything imports a
 * shared constant from. See config/marketing.js for why they live in their own
 * file — readability, not a different import surface.
 */
const marketing = require('./marketing');

module.exports = {
  ...marketing,
  MAX_ORDER_QTY,
  ROLES,
  REQUESTABLE_ROLES,
  ROLE_VALUES: Object.values(ROLES),
  USER_STATUS,
  CHANGE_REQUEST_STATUS,
  CHANGE_REQUEST_STATUS_VALUES: Object.values(CHANGE_REQUEST_STATUS),
  USER_STATUS_VALUES: Object.values(USER_STATUS),
  CUSTOMER_STATUS,
  CUSTOMER_STATUS_VALUES: Object.values(CUSTOMER_STATUS),
  ORDER_STATUS,
  ORDER_STATUS_VALUES: Object.values(ORDER_STATUS),
  FULFILMENT_STATUS,
  FULFILMENT_STATUS_VALUES: Object.values(FULFILMENT_STATUS),
  FULFILMENT_SEQUENCE,
  FULFILMENT_LABELS,
  DELIVERY_SPEED,
  DELIVERY_SPEED_VALUES: Object.values(DELIVERY_SPEED),
  DELIVERY_OPTIONS,
  deliveryDaysFor,
  estimatedDeliveryFor,
  COURIER,
  COURIER_VALUES: Object.values(COURIER),
  COURIER_LABELS,
  DEFAULT_LOW_STOCK_THRESHOLD,
  PAYMENT_METHOD,
  PAYMENT_METHOD_VALUES: Object.values(PAYMENT_METHOD),
  STRIPE_PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES: Object.values(PAYMENT_STATUS),
  PENDING_CHECKOUT_STATUS,
  MAX_CUSTOMER_IMPORT_ROWS,
  PENDING_CHECKOUT_STATUS_VALUES: Object.values(PENDING_CHECKOUT_STATUS),
};
