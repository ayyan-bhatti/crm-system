const OutboundMessage = require('../models/OutboundMessage');
const asyncHandler = require('../utils/asyncHandler');
const { OUTBOUND_KIND, RECIPIENT_STATUS } = require('../config/marketing');

/**
 * A signed-in buyer's own notifications: the marketing campaigns actually
 * delivered to them — `/api/shop/messages`.
 *
 * ONLY `kind: campaign` AND `status: sent`, and both filters matter.
 *
 * `kind` — this is the buyer's promotions inbox, not a copy of the internal
 * automation log. A review request or reorder reminder is about a specific
 * order and already has its own place the buyer would look (their order
 * page); mixing it into a "notifications" feed would blur "here is an offer"
 * with "here is a nudge about something you bought", which read very
 * differently even though both are `OutboundMessage` rows under the hood.
 *
 * `status` — a `skipped_no_consent` or `failed` row exists so STAFF can see
 * what happened to a send; it does not mean the buyer received anything, and
 * showing it to them as a "notification" would be actively wrong: a person
 * who never opted in would see a campaign appear in their own inbox that
 * they, correctly, never got.
 *
 * WHY THE FULL SUBJECT/BODY COMES FROM `Campaign.content`, NOT THIS
 * COLLECTION
 *
 * `OutboundMessage.preview` is deliberately truncated to 300 characters (see
 * the model) — it exists so a STAFF member can recognise a message in a log,
 * not to be the buyer's actual reading copy. The full text lives once, on
 * the `Campaign` itself, so this reads it back through the `campaign` ref.
 * A sent campaign is never deletable (see `campaignController.deleteCampaign`),
 * so that ref is safe to depend on for any row with `status: sent`.
 */
const listMyMessages = asyncHandler(async (req, res) => {
  const messages = await OutboundMessage.find({
    buyer: req.buyer._id,
    kind: OUTBOUND_KIND.CAMPAIGN,
    status: RECIPIENT_STATUS.SENT,
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(100)
    .populate('campaign', 'name content channel')
    .lean();

  const data = messages
    // Defensive only — see the note above on why a sent campaign's `campaign`
    // ref should always resolve. A row that somehow cannot resolve one is
    // dropped rather than shown with blank content.
    .filter((message) => message.campaign)
    .map((message) => ({
      id: message._id,
      channel: message.channel,
      subject: message.campaign.content?.subject || message.subject || '',
      body:
        message.channel === 'email'
          ? message.campaign.content?.body
          : message.channel === 'sms'
            ? message.campaign.content?.sms || message.campaign.content?.body
            : message.campaign.content?.whatsapp || message.campaign.content?.body,
      campaignName: message.campaign.name,
      sentAt: message.createdAt,
    }));

  res.json({ success: true, data, count: data.length });
});

module.exports = { listMyMessages };
