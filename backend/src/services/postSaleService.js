const Order = require('../models/Order');
const Customer = require('../models/Customer');
const AutomationSettings = require('../models/AutomationSettings');
const contactService = require('./contactService');
const messagingService = require('./messagingService');
const postSaleContentService = require('./postSaleContentService');
const { personalise } = require('./campaignContentService');
const { typicalGapDays } = require('./churnRisk');
const { computeMetricsForCustomers } = require('./customerMetrics');
const { componentLogger } = require('../config/logger');
const {
  CONTACT_CHANNEL,
  CONTACT_CHANNEL_VALUES,
  OUTBOUND_KIND,
  RECIPIENT_STATUS,
  POST_SALE_WINDOW_DAYS,
  REORDER_NUDGE_FROM_GAPS,
  REORDER_NUDGE_TO_GAPS,
} = require('../config/marketing');
const { FULFILMENT_STATUS, ORDER_STATUS } = require('../config/constants');

const log = componentLogger('post-sale');

/**
 * The two scheduled post-sale automations.
 *
 * ============================================================================
 * IDEMPOTENCE IS THE WHOLE PROBLEM
 * ============================================================================
 *
 * Everything else here is straightforward. The one thing an automation must
 * never do is send the same message to the same person twice, and there are
 * three separate ways that happens if you do not design against each of them:
 *
 *   1. THE JOB RUNS TWICE. A scheduler retries on a timeout it could not tell
 *      from a failure; somebody triggers it by hand; two instances wake at the
 *      same minute on a serverless platform. Defended by CLAIMING each order
 *      with a conditional update before anything is sent — `findOneAndUpdate`
 *      with the flag still null in the filter. MongoDB arbitrates, exactly one
 *      caller gets the document back, and the loser gets null and moves on.
 *
 *   2. THE FLAG IS SET AFTER SENDING. The obvious ordering, and it leaves the
 *      whole send window open: both runs read null, both send, both then write
 *      the flag. Claiming FIRST is what closes it. The cost is that a send
 *      which then fails has already consumed the claim — handled by releasing
 *      it, below.
 *
 *   3. THE FIRST RUN MAILS THE ARCHIVE. Every order ever placed has a null
 *      flag, so "delivered and not yet asked" matches years of history the
 *      first time this runs. Defended by POST_SALE_WINDOW_DAYS: the query only
 *      ever looks back a month. Anything older is skipped rather than mailed.
 *      This one is not a race and would not show up in testing — it shows up
 *      on the day the feature is deployed to a real database.
 *
 * A fourth defence sits under all of these, in the database: a partial unique
 * index on (order, kind) over settled outcomes. See models/OutboundMessage.js.
 *
 * ============================================================================
 * CONSENT
 * ============================================================================
 *
 * Not checked here. Every message goes through `messagingService.sendToContact`
 * which is the one gate — see that file on why there is exactly one. What this
 * service decides is WHICH CHANNEL to try, and a contact who has opted in to
 * nothing is claimed, recorded as skipped, and never revisited.
 */

/** Most orders one run will process, per job. */
const MAX_PER_RUN = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The settings document, created with its defaults on first read. */
async function getSettings() {
  const existing = await AutomationSettings.findOne({ key: 'automation' });
  if (existing) return existing;

  /*
   * Created on read rather than by a migration, so a deployment that has never
   * opened the settings screen still behaves correctly. `upsert` rather than
   * `create` because two cold requests can arrive together and the unique key
   * would make the loser throw.
   */
  return AutomationSettings.findOneAndUpdate(
    { key: 'automation' },
    { $setOnInsert: { key: 'automation' } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

/**
 * Which channel to send an automated message on.
 *
 * EMAIL FIRST WHEN MORE THAN ONE IS AVAILABLE, which the brief specifies and
 * which is right for a further reason worth stating: email is the only one of
 * the three that carries a working unsubscribe link, is not billed per
 * message, and does not interrupt somebody's evening. When a person has
 * agreed to several, the least intrusive is the courteous default.
 *
 * @returns {string|null} the channel, or null if they have consented to none
 */
function preferredChannel(contact) {
  const order = [CONTACT_CHANNEL.EMAIL, CONTACT_CHANNEL.SMS, CONTACT_CHANNEL.WHATSAPP];

  for (const channel of order) {
    if (!contact.consent?.[channel]?.optIn) continue;

    /*
     * A consent for SMS or WhatsApp is worth nothing without a number to send
     * it to, and treating "opted in but unreachable" as a send produces a
     * failed row every single run. Falling through to the next channel they
     * agreed to is what they would want.
     */
    if (channel !== CONTACT_CHANNEL.EMAIL && !contact.phone) continue;

    return channel;
  }

  return null;
}

/**
 * Send one automated message about one order.
 *
 * Shared by both jobs because the sequence is identical and the only
 * differences are the query that selected the order, the flag that claims it
 * and the words. Written once so that a fix to the claim/release logic cannot
 * land in one automation and not the other.
 *
 * @returns {Promise<string>} the recipient status recorded
 */
async function sendForOrder({ order, contact, kind, flagField, draft }) {
  const channel = preferredChannel(contact);

  /*
   * Consented to nothing. Recorded as a skip and NOT released, so tomorrow's
   * run does not reconsider them. That is deliberate: their consent is a
   * settled fact rather than a transient failure, and re-evaluating every
   * qualifying order every day for a month would fill the log with the same
   * refusal repeated thirty times.
   *
   * If they later opt in, they are reached by the NEXT order's automation —
   * which is the right granularity. Retro-sending a review request for a
   * parcel that arrived three weeks ago because consent arrived yesterday
   * would be strange.
   *
   * The channel recorded is email, because that is the one the message would
   * have gone on had they agreed to anything.
   */
  if (!channel) {
    await messagingService.sendToContact({
      contact,
      channel: CONTACT_CHANNEL.EMAIL,
      kind,
      subject: '',
      body: '',
      orderId: order._id,
    });

    return RECIPIENT_STATUS.SKIPPED_NO_CONSENT;
  }

  const content = await draft();

  const body =
    channel === CONTACT_CHANNEL.EMAIL
      ? personalise(content.body, contact)
      : personalise(content.short || content.body, contact);

  const outcome = await messagingService.sendToContact({
    contact,
    channel,
    kind,
    subject: channel === CONTACT_CHANNEL.EMAIL ? personalise(content.subject, contact) : '',
    body,
    orderId: order._id,
  });

  /*
   * RELEASE THE CLAIM ON A FAILURE.
   *
   * Claiming before sending closes the double-send race and opens a smaller
   * one: a transport that errors has consumed the order's only chance. Putting
   * the flag back lets tomorrow's run try again — which is safe, because the
   * message demonstrably did not arrive, and the partial unique index would
   * still stop a duplicate if it somehow had.
   *
   * Only on FAILED. A skip is a settled outcome, not a retryable one.
   */
  if (outcome.status === RECIPIENT_STATUS.FAILED) {
    await Order.updateOne({ _id: order._id }, { [flagField]: null });
  }

  return outcome.status;
}

/** The contact behind an order, or null if there is nobody to write to. */
async function contactForOrder(order) {
  const customer = await Customer.findById(order.customer).select('email').lean();
  if (!customer?.email) return null;

  return contactService.findContactByEmail(customer.email);
}

/** A product name for the message to mention, or empty. */
function productNameFor(order) {
  return order.items?.[0]?.productName || '';
}

/* ===========================================================================
 * JOB 1 — the post-delivery review request
 * ======================================================================== */

/**
 * Ask customers how a delivery went, N days after it arrived.
 *
 * @returns {Promise<{ considered, sent, skipped, failed, disabled? }>}
 */
async function runReviewRequests(now = new Date()) {
  const settings = await getSettings();

  if (!settings.reviewRequestEnabled) {
    return { considered: 0, sent: 0, skipped: 0, failed: 0, disabled: true };
  }

  const readyBefore = new Date(now.getTime() - settings.reviewRequestDelayDays * DAY_MS);
  const windowStart = new Date(now.getTime() - POST_SALE_WINDOW_DAYS * DAY_MS);

  const candidates = await Order.find({
    fulfilment: FULFILMENT_STATUS.DELIVERED,
    /*
     * Both bounds matter. The upper one is the delay — it has not been long
     * enough yet. The LOWER one is the archive guard, and it is the one that
     * stops the first run of this job mailing every customer the business has
     * ever had. See the note at the top of this file.
     */
    deliveredAt: { $ne: null, $lte: readyBefore, $gte: windowStart },
    reviewRequestSentAt: null,
  })
    .sort({ deliveredAt: 1 })
    .limit(MAX_PER_RUN);

  const tally = { considered: candidates.length, sent: 0, skipped: 0, failed: 0 };

  for (const candidate of candidates) {
    /*
     * THE CLAIM. Conditional on the flag still being null, so two overlapping
     * runs cannot both take the same order — the second gets null back and
     * skips it. This is the primary double-send defence.
     */
    const order = await Order.findOneAndUpdate(
      { _id: candidate._id, reviewRequestSentAt: null },
      { reviewRequestSentAt: now },
      { new: true }
    );

    if (!order) continue;

    const contact = await contactForOrder(order);
    if (!contact) {
      // No contact record at all: nothing to send to, and nothing to retry.
      tally.skipped += 1;
      continue;
    }

    const status = await sendForOrder({
      order,
      contact,
      kind: OUTBOUND_KIND.REVIEW_REQUEST,
      flagField: 'reviewRequestSentAt',
      draft: () =>
        postSaleContentService.draftReviewRequest({ productName: productNameFor(order) }),
    });

    if (status === RECIPIENT_STATUS.SENT) tally.sent += 1;
    else if (status === RECIPIENT_STATUS.FAILED) tally.failed += 1;
    else tally.skipped += 1;
  }

  log.info(tally, 'review-request run complete');

  return tally;
}

/* ===========================================================================
 * JOB 2 — the reorder reminder
 * ======================================================================== */

/**
 * Nudge customers who are APPROACHING their own reorder point.
 *
 * ============================================================================
 * HOW THIS DIFFERS FROM CHURN RISK, WHICH IT SHARES ALL ITS ARITHMETIC WITH
 * ============================================================================
 *
 * Both measure the same thing: how many of a customer's own typical gaps have
 * elapsed since they last ordered. `typicalGapDays` is imported from
 * churnRisk rather than recalculated, so the two can never disagree about what
 * a customer's cadence is.
 *
 * They differ in WHICH PART OF THE CURVE they act on, and the two windows are
 * deliberately disjoint:
 *
 *      0.8 ────────── 1.2                 1.5 ──────────────►
 *      this job: coming due               churn risk: gone quiet
 *
 * Below 0.8 they are not due yet and a nudge is just noise. Past 1.2 they are
 * late, which is churn's territory and a different message — one a rep sends
 * by hand, because "you are overdue" is a conversation, not a broadcast.
 *
 * The gap between 1.2 and 1.5 is empty on purpose. A customer must never be
 * both "coming up for a reorder" and "at risk of churn" in the same week, and
 * two automated messages a few days apart saying opposite things is precisely
 * how a CRM announces that nobody is actually reading it.
 *
 * Customers with fewer than two completed orders are excluded outright:
 * `typicalGapDays` returns null for them, because one order establishes no
 * cadence, and guessing one would mean nudging somebody on a rhythm they have
 * never demonstrated.
 */
async function runReorderReminders(now = new Date()) {
  const settings = await getSettings();

  if (!settings.reorderReminderEnabled) {
    return { considered: 0, sent: 0, skipped: 0, failed: 0, disabled: true };
  }

  /*
   * The candidate set is bounded at the database by "has a recent-ish last
   * order", then filtered in memory by cadence. The cadence test cannot be a
   * query: it compares each customer's own average gap against their own
   * elapsed time, which is two derived numbers per customer and not a field
   * MongoDB can index. Same shape as the delivery board's ranking, and bounded
   * the same way — the expensive part is narrowed first.
   */
  const windowStart = new Date(now.getTime() - POST_SALE_WINDOW_DAYS * 12 * DAY_MS);

  const recentCustomerIds = await Order.distinct('customer', {
    status: ORDER_STATUS.COMPLETED,
    createdAt: { $gte: windowStart },
  });

  const metricsById = await computeMetricsForCustomers(recentCustomerIds);

  const due = [];

  for (const [customerId, metrics] of metricsById) {
    const gap = typicalGapDays(metrics);
    if (gap === null) continue;

    const gapsElapsed = metrics.daysSinceLastOrder / gap;
    if (gapsElapsed < REORDER_NUDGE_FROM_GAPS || gapsElapsed >= REORDER_NUDGE_TO_GAPS) continue;

    due.push(customerId);
    if (due.length >= MAX_PER_RUN) break;
  }

  const tally = { considered: due.length, sent: 0, skipped: 0, failed: 0 };

  for (const customerId of due) {
    /*
     * The marker lives on the customer's MOST RECENT order — the one whose age
     * triggered this. See the field's own note in models/Order.js for why that
     * is the right anchor: it is the fact being measured, so it is the fact
     * that says "already acted on".
     */
    const latest = await Order.findOne({ customer: customerId })
      .sort({ createdAt: -1 })
      .select('_id');

    if (!latest) continue;

    const order = await Order.findOneAndUpdate(
      { _id: latest._id, reorderReminderSentAt: null },
      { reorderReminderSentAt: now },
      { new: true }
    );

    if (!order) continue;

    const contact = await contactForOrder(order);
    if (!contact) {
      tally.skipped += 1;
      continue;
    }

    const status = await sendForOrder({
      order,
      contact,
      kind: OUTBOUND_KIND.REORDER_REMINDER,
      flagField: 'reorderReminderSentAt',
      draft: () =>
        postSaleContentService.draftReorderReminder({ productName: productNameFor(order) }),
    });

    if (status === RECIPIENT_STATUS.SENT) tally.sent += 1;
    else if (status === RECIPIENT_STATUS.FAILED) tally.failed += 1;
    else tally.skipped += 1;
  }

  log.info(tally, 'reorder-reminder run complete');

  return tally;
}

/** Both jobs, in the order the scheduler calls them. */
async function runAll(now = new Date()) {
  return {
    reviewRequests: await runReviewRequests(now),
    reorderReminders: await runReorderReminders(now),
    ranAt: now,
  };
}

module.exports = {
  runAll,
  runReviewRequests,
  runReorderReminders,
  getSettings,
  preferredChannel,
  MAX_PER_RUN,
  CONTACT_CHANNEL_VALUES,
};
