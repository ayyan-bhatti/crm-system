const Campaign = require('../models/Campaign');
const OutboundMessage = require('../models/OutboundMessage');
const ApiError = require('../utils/ApiError');
const { componentLogger } = require('../config/logger');
const contactService = require('./contactService');
const messagingService = require('./messagingService');
const { personalise } = require('./campaignContentService');
const { isAdmin } = require('../middleware/roles');
const {
  CAMPAIGN_STATUS,
  CONTACT_CHANNEL,
  RECIPIENT_STATUS,
  OUTBOUND_KIND,
  MAX_CAMPAIGN_RECIPIENTS,
  CAMPAIGN_BATCH_SIZE,
} = require('../config/marketing');

const log = componentLogger('campaigns');

/**
 * Sending a campaign: who it reaches, who has to agree first, and what is
 * recorded about it.
 *
 * ============================================================================
 * THE APPROVAL RULE, AND WHY IT IS EVALUATED AT SEND TIME
 * ============================================================================
 *
 * An admin's campaign sends immediately. A manager's sends immediately if
 * every recipient is inside their own scope, and otherwise queues for an admin
 * — the same "manager proposes, admin approves for anything beyond their own
 * scope" shape the customer and order edits already use, carried by the same
 * `ChangeRequest` model rather than by a second approval mechanism.
 *
 * The decision is made when the campaign is DISPATCHED, not when it is
 * drafted, and that is the load-bearing choice here. An audience is a filter,
 * not a list: "at-risk customers" is a different set of people this morning
 * from last Tuesday. Deciding at draft time would mean a campaign approved
 * when it matched forty of the manager's own contacts could go out a week
 * later to four hundred strangers, having passed the check honestly. The
 * check has to see the people who will actually be messaged.
 *
 * A manager whose campaign needs approval is told so BEFORE it queues, with
 * the count that made the difference — an approval gate that silently
 * swallows a send is one people route around.
 *
 * ============================================================================
 * CONSENT IS NOT CHECKED HERE
 * ============================================================================
 *
 * Deliberately. Every message goes through `messagingService.sendToContact`,
 * which is the one gate, and filtering the audience here as well would be a
 * second implementation of the rule — the exact thing that file exists to
 * prevent. What this service does is COUNT the refusals, from the outcomes the
 * gate returns, so the campaign can report them.
 */

/** Turn a resolved contact and a campaign into the text that person receives. */
function renderFor(campaign, contact) {
  const { channel, content } = campaign;

  if (channel === CONTACT_CHANNEL.EMAIL) {
    return {
      subject: personalise(content.subject, contact),
      body: personalise(content.body, contact),
    };
  }

  if (channel === CONTACT_CHANNEL.SMS) {
    return { subject: '', body: personalise(content.sms || content.body, contact) };
  }

  return { subject: '', body: personalise(content.whatsapp || content.body, contact) };
}

/**
 * Does this campaign need an administrator's agreement before it goes?
 *
 * @returns {Promise<{ required: boolean, outsideScope: number, total: number }>}
 */
async function assessApproval(campaign, actor, contacts) {
  if (isAdmin(actor)) {
    return { required: false, outsideScope: 0, total: contacts.length };
  }

  const outside = contacts.filter(
    (contact) => !contactService.isWithinOwnScope(contact, actor)
  ).length;

  return { required: outside > 0, outsideScope: outside, total: contacts.length };
}

/**
 * Resolve a campaign's audience, as the person who created it.
 *
 * AS THE CREATOR, not as whoever is dispatching. When an admin approves a
 * manager's campaign, the audience must still be the one the manager defined
 * and the admin reviewed — resolving it against the admin's wider visibility
 * would silently widen the campaign at the moment of approval, which is the
 * opposite of what approving it means.
 */
async function resolveRecipients(campaign) {
  const User = require('../models/User');

  const creator = await User.findById(campaign.createdBy).select('_id role');
  if (!creator) {
    throw ApiError.conflict(
      'The person who created this campaign no longer has an account, so its audience ' +
        'cannot be resolved. Recreate it under a current user.'
    );
  }

  return contactService.resolveAudience(campaign.audience, creator);
}

/**
 * Send a campaign to everyone its audience resolves to.
 *
 * @param {object} campaign a Campaign document
 * @param {object} actor    who is causing the send (creator, or the approver)
 * @returns {Promise<object>} the updated campaign
 */
async function dispatch(campaign, actor) {
  if (campaign.status === CAMPAIGN_STATUS.SENT) {
    /*
     * Terminal, and refusing is the whole point. Re-sending a campaign is how
     * a list gets messaged twice, and "it looked like it failed so I pressed
     * it again" is exactly how that happens. A repeat is a NEW campaign, with
     * its own recipient rows and its own audit trail.
     */
    throw ApiError.badRequest('This campaign has already been sent. Duplicate it to send again.');
  }

  if (campaign.status === CAMPAIGN_STATUS.SENDING) {
    throw ApiError.conflict('This campaign is already being sent.');
  }

  const contacts = await resolveRecipients(campaign);

  if (!contacts.length) {
    throw ApiError.badRequest(
      'This audience currently matches nobody, so there is nothing to send. Check the ' +
        'segment and source filters.'
    );
  }

  /*
   * The blast-radius ceiling. REFUSES rather than truncating — a campaign that
   * silently reached the first five thousand of a larger list is worse than
   * one that did not go, because the remainder look like they were excluded on
   * purpose and nobody can tell where the line fell.
   */
  if (contacts.length > MAX_CAMPAIGN_RECIPIENTS) {
    throw ApiError.badRequest(
      `This audience resolves to ${contacts.length} contacts, over the ${MAX_CAMPAIGN_RECIPIENTS} ` +
        'limit for a single campaign. Narrow it with a segment or source filter.'
    );
  }

  campaign.status = CAMPAIGN_STATUS.SENDING;
  campaign.audienceCount = contacts.length;
  await campaign.save();

  const tally = { sent: 0, failed: 0, skipped: 0 };

  try {
    /*
     * BATCHED, rather than one `Promise.all` over the whole list.
     *
     * Every transport at the other end rate limits, and a burst of five
     * hundred simultaneous requests trips that limit — failing messages that
     * would have gone out perfectly well a second later. Sequential batches of
     * a couple of dozen keep the concurrency bounded without making a
     * thousand-recipient send take a thousand round trips.
     */
    for (let i = 0; i < contacts.length; i += CAMPAIGN_BATCH_SIZE) {
      const batch = contacts.slice(i, i + CAMPAIGN_BATCH_SIZE);

      const outcomes = await Promise.all(
        batch.map((contact) => {
          const { subject, body } = renderFor(campaign, contact);

          return messagingService.sendToContact({
            contact,
            channel: campaign.channel,
            kind: OUTBOUND_KIND.CAMPAIGN,
            subject,
            body,
            campaignId: campaign._id,
            actorId: actor?._id || null,
          });
        })
      );

      for (const outcome of outcomes) {
        if (outcome.status === RECIPIENT_STATUS.SENT) tally.sent += 1;
        else if (outcome.status === RECIPIENT_STATUS.SKIPPED_NO_CONSENT) tally.skipped += 1;
        else tally.failed += 1;
      }
    }
  } catch (err) {
    /*
     * `sendToContact` promises not to throw, so reaching here means something
     * structural broke — the database went away mid-send, most likely. The
     * campaign is marked failed with the reason attached rather than being
     * left stuck in `sending` forever, which is the state that makes somebody
     * press the button again.
     */
    campaign.status = CAMPAIGN_STATUS.FAILED;
    campaign.failureReason = String(err.message || 'dispatch failed').slice(0, 500);
    campaign.sentCount = tally.sent;
    campaign.failureCount = tally.failed;
    campaign.skippedNoConsentCount = tally.skipped;
    await campaign.save();

    log.error({ err, campaignId: campaign._id }, 'campaign dispatch failed');
    throw err;
  }

  campaign.status = CAMPAIGN_STATUS.SENT;
  campaign.sentAt = new Date();
  campaign.sentCount = tally.sent;
  campaign.failureCount = tally.failed;
  campaign.skippedNoConsentCount = tally.skipped;
  await campaign.save();

  log.info(
    {
      campaignId: campaign._id,
      channel: campaign.channel,
      audience: contacts.length,
      ...tally,
    },
    'campaign sent'
  );

  return campaign;
}

/**
 * Ask to send a campaign: dispatch it, or queue it for an admin.
 *
 * The single entry point the controller calls, so the approval rule cannot be
 * skipped by reaching for `dispatch` directly from a route.
 *
 * @returns {Promise<{ queued: boolean, campaign: object, outsideScope?: number }>}
 */
async function requestSend(campaign, actor) {
  if (campaign.status === CAMPAIGN_STATUS.PENDING_APPROVAL) {
    throw ApiError.conflict('This campaign is already waiting for an administrator.');
  }

  const contacts = await resolveRecipients(campaign);
  const approval = await assessApproval(campaign, actor, contacts);

  if (!approval.required) {
    return { queued: false, campaign: await dispatch(campaign, actor) };
  }

  /*
   * Queued through the EXISTING change-request model rather than a second
   * approval queue. An admin should have one place to look; two queues means
   * one of them stops being read, and the round's brief is explicit that this
   * follows the pattern already established.
   */
  const changeRequestService = require('./changeRequestService');

  const request = await changeRequestService.submit(
    {
      entity: 'campaign',
      entityId: campaign._id,
      action: 'send',
      payload: {},
      label: `${campaign.name} — ${campaign.channel} to ${approval.total} contacts`,
    },
    actor
  );

  campaign.status = CAMPAIGN_STATUS.PENDING_APPROVAL;
  campaign.changeRequestId = request._id;
  campaign.audienceCount = approval.total;
  await campaign.save();

  log.info(
    {
      campaignId: campaign._id,
      requestId: request._id,
      outsideScope: approval.outsideScope,
      total: approval.total,
    },
    'campaign queued for approval'
  );

  return { queued: true, campaign, outsideScope: approval.outsideScope };
}

/**
 * Dispatch a campaign an admin has just approved.
 *
 * Called from `changeRequestService.applyChange`. The approver is passed as
 * the actor so the outbound rows name the person who released the send, which
 * is the accountable party — the manager wrote it, the admin sent it.
 */
async function dispatchApproved(campaignId, approver) {
  const campaign = await Campaign.findById(campaignId);

  if (!campaign) {
    throw ApiError.conflict(
      'The campaign this approval refers to no longer exists. Reject the request instead.'
    );
  }

  campaign.approvedBy = approver._id;
  campaign.approvedAt = new Date();
  await campaign.save();

  return dispatch(campaign, approver);
}

/** Put a rejected campaign back where its author can edit and resubmit it. */
async function markRejected(campaignId) {
  await Campaign.updateOne(
    { _id: campaignId, status: CAMPAIGN_STATUS.PENDING_APPROVAL },
    { status: CAMPAIGN_STATUS.DRAFT, changeRequestId: null }
  );
}

/**
 * Who a campaign actually reached, and what happened to each of them.
 *
 * The recipient rows, not a count — which is the difference between a report
 * and a number. "Sent to 40" cannot answer "did Ayesha get it", and that is
 * the question somebody always asks.
 */
async function recipients(campaignId, { limit = 500 } = {}) {
  return OutboundMessage.find({ campaign: campaignId })
    .sort({ status: 1, createdAt: 1 })
    .limit(limit)
    .lean();
}

/**
 * A preview of what a send would do, without sending anything.
 *
 * Exists because the consent gate makes an audience size misleading on its
 * own: "4,000 contacts" is not 4,000 messages, and finding that out AFTER
 * pressing send is how the skipped count reads as a bug. Shown in the builder
 * next to the button.
 */
async function previewAudience(audience, actor) {
  const contacts = await contactService.resolveAudience(audience, actor);

  const byChannel = {};
  for (const channel of Object.values(CONTACT_CHANNEL)) {
    byChannel[channel] = contacts.filter((c) => c.consent[channel]?.optIn).length;
  }

  const outsideScope = isAdmin(actor)
    ? 0
    : contacts.filter((c) => !contactService.isWithinOwnScope(c, actor)).length;

  return {
    total: contacts.length,
    reachable: byChannel,
    outsideScope,
    needsApproval: !isAdmin(actor) && outsideScope > 0,
  };
}

module.exports = {
  requestSend,
  dispatch,
  dispatchApproved,
  markRejected,
  recipients,
  previewAudience,
  assessApproval,
  renderFor,
};
