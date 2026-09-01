const mailer = require('./mailer');
const smsClient = require('./smsClient');
const whatsappClient = require('./whatsappClient');
const OutboundMessage = require('../models/OutboundMessage');
const { unsubscribeUrl } = require('./unsubscribeService');
const { componentLogger } = require('../config/logger');
const {
  CONTACT_CHANNEL,
  CONTACT_CHANNEL_VALUES,
  RECIPIENT_STATUS,
  OUTBOUND_KIND,
} = require('../config/marketing');

const log = componentLogger('messaging');

/**
 * THE ONLY WAY A MESSAGE LEAVES THIS APPLICATION.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ============================================================================
 *
 * The rule this round is built around is short — nobody is messaged on a
 * channel they have not opted in to — and it has exactly one dangerous
 * property: it has to hold on EVERY path, forever, including the ones written
 * next year by somebody who has not read the brief.
 *
 * Checking consent in the campaign dispatcher, again in the individual-send
 * controller, again in the review-request job and again in the reorder job is
 * four implementations of one rule. Four is not four times safer; it is four
 * places for the rule to be subtly different, and the one that is wrong is by
 * definition the one nobody looked at. The failure mode is not a crash. It is
 * a real person receiving a marketing message they explicitly refused, which
 * is a legal problem, and finding out about it from them.
 *
 * So there is one gate. `mailer.sendMail`, `smsClient.sendSms` and
 * `whatsappClient.sendWhatsApp` are never called for a marketing message from
 * anywhere else in the codebase — every caller goes through `sendToContact`
 * below, and consent is checked HERE, before the transport is selected.
 *
 * The transactional paths — a password reset, a change-request outcome — still
 * call `mailer` directly, and that is correct rather than an exception being
 * carved out. Consent governs MARKETING. Telling somebody their order was
 * cancelled is not marketing, needs no opt-in, and gating it behind one would
 * mean a customer who declined our newsletter never hears that their refund
 * went through.
 *
 * ============================================================================
 * WHAT THE GATE DOES WITH A REFUSAL
 * ============================================================================
 *
 * It records it. A contact who is in the audience and has not consented gets
 * an `OutboundMessage` row with `skipped_no_consent`, and the campaign's
 * counter goes up. This is why the numbers on a campaign add up and why "sent
 * to 40 of 60" is never a mystery. See the note in models/OutboundMessage.js.
 */

/** How much of the body to keep on the log row. See the model's `preview`. */
const PREVIEW_LENGTH = 280;

/**
 * The footer appended to every MARKETING email.
 *
 * Appended here rather than written into each template, because a footer that
 * an author has to remember is a footer that will eventually be forgotten —
 * and the one email that goes out without it is the one that becomes a
 * complaint. Composed at send time because the link is per-recipient.
 */
function withUnsubscribeFooter(body, email) {
  return (
    `${body}\n\n` +
    `—\n` +
    `You are receiving this because you opted in to marketing emails from us.\n` +
    `Unsubscribe: ${unsubscribeUrl(email, CONTACT_CHANNEL.EMAIL)}`
  );
}

/**
 * Is this kind of message marketing, for consent purposes?
 *
 * All four are, and that is the deliberate answer rather than a shortcut. It
 * is tempting to class a post-delivery review request as transactional — it is
 * about an order they placed, after all — and that reasoning is exactly how
 * consent regimes get eroded one reasonable-sounding exception at a time. A
 * message sent because we would like something from the customer is marketing,
 * whatever it is about. A message sent because they need to know something is
 * transactional, and those do not come through this file.
 */
function requiresConsent() {
  return true;
}

/**
 * Send one message to one contact, on one channel.
 *
 * @param {object} options
 * @param {object} options.contact   a resolved contact from contactService —
 *   needs `email`, `name`, `phone`, `consent`, `customerId`, `buyerId`
 * @param {string} options.channel   one of CONTACT_CHANNEL_VALUES
 * @param {string} options.kind      one of OUTBOUND_KIND_VALUES
 * @param {string} [options.subject] email only
 * @param {string} options.body      the message text
 * @param {*} [options.campaignId]
 * @param {*} [options.orderId]
 * @param {*} [options.actorId]      the staff member, or null for automation
 * @param {boolean} [options.record] write the log row (default true)
 *
 * @returns {Promise<{ status: string, transport: string, error: string }>}
 *   Never throws. A send that fails is an outcome the caller records and
 *   counts, not an exception that aborts the other two hundred messages in
 *   the batch.
 */
async function sendToContact({
  contact,
  channel,
  kind = OUTBOUND_KIND.DIRECT,
  subject = '',
  body,
  campaignId = null,
  orderId = null,
  actorId = null,
  record = true,
}) {
  if (!CONTACT_CHANNEL_VALUES.includes(channel)) {
    throw new Error(`"${channel}" is not a messaging channel`);
  }

  const outcome = {
    status: RECIPIENT_STATUS.PENDING,
    transport: '',
    error: '',
  };

  /* ------------------------------------------------------------------------
   * THE GATE. Everything above this line is preparation; nothing below it
   * runs for a contact who has not agreed.
   *
   * Note what is NOT consulted: whether they matched the audience, whether a
   * staff member picked them by hand, whether the campaign was approved by an
   * administrator. None of those is consent, and none of them may override it.
   * An admin approving a campaign is agreeing that the campaign should go to
   * the people who agreed to receive it.
   * --------------------------------------------------------------------- */
  if (requiresConsent(kind) && !contact?.consent?.[channel]?.optIn) {
    outcome.status = RECIPIENT_STATUS.SKIPPED_NO_CONSENT;
    outcome.error = `no ${channel} opt-in`;

    if (record) await recordOutcome({ contact, channel, kind, subject, body, campaignId, orderId, actorId, outcome });

    return outcome;
  }

  /* ---- Dispatch ------------------------------------------------------- */
  let result;

  try {
    if (channel === CONTACT_CHANNEL.EMAIL) {
      result = await mailer.sendMail({
        to: contact.email,
        subject,
        text: withUnsubscribeFooter(body, contact.email),
      });
    } else if (channel === CONTACT_CHANNEL.SMS) {
      result = await smsClient.sendSms({ to: contact.phone, text: body });
    } else {
      result = await whatsappClient.sendWhatsApp({ to: contact.phone, text: body });
    }
  } catch (err) {
    /*
     * All three transports promise never to throw. This catch is here anyway,
     * because "promises not to throw" is a property of today's code and a
     * campaign half-sent because one transport broke its contract is a bad way
     * to find out it changed.
     */
    log.error({ err, channel, kind }, 'transport threw — treating as a failed send');
    result = { delivered: false, transport: channel, error: err.message };
  }

  outcome.transport = result.transport || '';
  outcome.status = result.delivered ? RECIPIENT_STATUS.SENT : RECIPIENT_STATUS.FAILED;
  outcome.error = result.delivered ? '' : String(result.error || 'delivery failed').slice(0, 500);

  if (record) {
    await recordOutcome({ contact, channel, kind, subject, body, campaignId, orderId, actorId, outcome });
  }

  return outcome;
}

/**
 * Write the log row.
 *
 * NEVER FAILS THE SEND, exactly as `auditService.recordAudit` never fails the
 * write it describes. The message has already left by the time this runs; a
 * database hiccup here must not turn a delivered message into a reported
 * failure, because the caller would then be entitled to retry it and the
 * recipient would get it twice.
 *
 * A duplicate-key error is swallowed quietly rather than logged as a fault: it
 * is the partial unique index on (order, kind) doing its job, which means the
 * automation double-send guard caught something the claim step missed. That is
 * the index working, not an error.
 */
async function recordOutcome({
  contact,
  channel,
  kind,
  subject,
  body,
  campaignId,
  orderId,
  actorId,
  outcome,
}) {
  try {
    await OutboundMessage.create({
      kind,
      channel,
      campaign: campaignId,
      customer: contact.customerId || null,
      buyer: contact.buyerId || null,
      toAddress: channel === CONTACT_CHANNEL.EMAIL ? contact.email : contact.phone || contact.email,
      toName: contact.name || '',
      order: orderId,
      status: outcome.status,
      subject: channel === CONTACT_CHANNEL.EMAIL ? String(subject || '').slice(0, 200) : '',
      preview: String(body || '').slice(0, PREVIEW_LENGTH),
      transport: outcome.transport,
      error: outcome.error,
      sentBy: actorId,
    });
  } catch (err) {
    if (err?.code === 11000) return;
    log.error({ err, kind, channel }, 'could not record an outbound message');
  }
}

/**
 * Which channels this deployment can actually deliver on right now.
 *
 * Published by `/api/health` and read by the campaign builder, for the same
 * reason the storefront asks the server whether card payment works rather than
 * assuming: whether SMS goes anywhere depends on a secret only the server
 * holds. A builder that offered a channel the deployment cannot send on would
 * be repeating the "Pay by card — unavailable" bug in a new place.
 *
 * `console` counts as available and says so. It genuinely delivers — to the
 * log — which is what makes the whole feature demonstrable with no accounts,
 * and pretending otherwise would hide a working path.
 */
function channelStatus() {
  return {
    email: {
      available: true,
      transport: process.env.MAIL_TRANSPORT || 'console',
      live: (process.env.MAIL_TRANSPORT || 'console') !== 'console',
    },
    sms: {
      available: true,
      transport: smsClient.activeTransport(),
      live: smsClient.isConfigured(),
    },
    whatsapp: {
      available: true,
      transport: whatsappClient.activeTransport(),
      live: whatsappClient.isConfigured(),
    },
  };
}

module.exports = {
  sendToContact,
  channelStatus,
  withUnsubscribeFooter,
  PREVIEW_LENGTH,
};
