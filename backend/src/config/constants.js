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
  FULFILMENT_STATUS.SHIPPED,
  FULFILMENT_STATUS.OUT_FOR_DELIVERY,
  FULFILMENT_STATUS.DELIVERED,
];

/** Human wording, shared by the API's audit notes and the UI's badges. */
const FULFILMENT_LABELS = {
  processing: 'Processing',
  confirmed: 'Confirmed',
  shipped: 'Shipped',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
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

module.exports = {
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
  DEFAULT_LOW_STOCK_THRESHOLD,
  PAYMENT_METHOD,
  PAYMENT_METHOD_VALUES: Object.values(PAYMENT_METHOD),
  STRIPE_PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES: Object.values(PAYMENT_STATUS),
  PENDING_CHECKOUT_STATUS,
  PENDING_CHECKOUT_STATUS_VALUES: Object.values(PENDING_CHECKOUT_STATUS),
};
