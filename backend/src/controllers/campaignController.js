const Campaign = require('../models/Campaign');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const campaignService = require('../services/campaignService');
const campaignContentService = require('../services/campaignContentService');
const contactService = require('../services/contactService');
const messagingService = require('../services/messagingService');
const { recordAudit } = require('../services/auditService');
const { isAdmin } = require('../middleware/roles');
const {
  CONTACT_CHANNEL_VALUES,
  CAMPAIGN_STATUS,
  CAMPAIGN_AUDIENCE_VALUES,
  CAMPAIGN_AUDIENCE_LABELS,
  CONTACT_SOURCE_VALUES,
  AUTO_SEGMENT_VALUES,
} = require('../config/marketing');

/**
 * Campaigns: drafting them, previewing who they reach, and sending them.
 *
 * The permission story in one place, since it is spread across three checks:
 *
 *   reaching this router at all   admin or manager (`requireManagerOrAdmin` on
 *                                 the routes). A sales rep cannot launch a bulk
 *                                 send, though they may message one contact.
 *   whose campaigns you can see   an admin sees every campaign; a manager sees
 *                                 their own. A manager reading other people's
 *                                 marketing plans is not something the role
 *                                 needs, and the approval queue is where an
 *                                 admin sees theirs.
 *   whether a send needs approval decided at dispatch, from the resolved
 *                                 audience. See services/campaignService.js.
 */

/** Validate and normalise an audience definition off a request body. */
function parseAudience(raw = {}) {
  const preset = raw.preset || '';

  if (!CAMPAIGN_AUDIENCE_VALUES.includes(preset)) {
    throw ApiError.badRequest(
      `audience.preset must be one of: ${CAMPAIGN_AUDIENCE_VALUES.join(', ')}`
    );
  }

  if (raw.source && !CONTACT_SOURCE_VALUES.includes(raw.source)) {
    throw ApiError.badRequest(`audience.source must be one of: ${CONTACT_SOURCE_VALUES.join(', ')}`);
  }

  if (raw.segment && !AUTO_SEGMENT_VALUES.includes(raw.segment)) {
    throw ApiError.badRequest(`audience.segment must be one of: ${AUTO_SEGMENT_VALUES.join(', ')}`);
  }

  return {
    preset,
    source: raw.source || '',
    segment: raw.segment || '',
    tag: String(raw.tag || '').trim().slice(0, 32),
  };
}

/** Which campaigns this user may read. See the note at the top of the file. */
function scopeFor(user) {
  return isAdmin(user) ? {} : { createdBy: user._id };
}

/** GET /api/campaigns */
const listCampaigns = asyncHandler(async (req, res) => {
  const query = scopeFor(req.user);

  if (req.query.status) {
    if (!Object.values(CAMPAIGN_STATUS).includes(req.query.status)) {
      throw ApiError.badRequest('Unknown campaign status');
    }
    query.status = req.query.status;
  }

  const campaigns = await Campaign.find(query)
    .populate('createdBy', 'name email')
    .populate('approvedBy', 'name email')
    .sort({ createdAt: -1, _id: -1 })
    .limit(200);

  res.json({
    success: true,
    count: campaigns.length,
    data: campaigns,
    options: {
      channels: CONTACT_CHANNEL_VALUES,
      channelStatus: messagingService.channelStatus(),
      audiences: CAMPAIGN_AUDIENCE_VALUES.map((value) => ({
        value,
        label: CAMPAIGN_AUDIENCE_LABELS[value],
      })),
      sources: CONTACT_SOURCE_VALUES,
      segments: AUTO_SEGMENT_VALUES,
    },
  });
});

/** Load a campaign the caller may act on. */
async function loadOwn(user, id) {
  const campaign = await Campaign.findOne({ _id: id, ...scopeFor(user) })
    .populate('createdBy', 'name email')
    .populate('approvedBy', 'name email');

  if (!campaign) throw ApiError.notFound('Campaign not found');
  return campaign;
}

/** GET /api/campaigns/:id */
const getCampaign = asyncHandler(async (req, res) => {
  const campaign = await loadOwn(req.user, req.params.id);

  res.json({
    success: true,
    data: {
      campaign,
      // The per-person outcomes. A count cannot answer "did Ayesha get it".
      recipients: await campaignService.recipients(campaign._id),
    },
  });
});

/**
 * POST /api/campaigns/preview — body: { audience }
 *
 * How many this audience matches, and how many of those can actually be
 * reached on each channel.
 *
 * THE SECOND NUMBER IS THE POINT. An audience of four thousand is not four
 * thousand messages, and discovering that only after pressing send makes the
 * skipped-for-consent count read as a bug in the sender. Shown next to the
 * button, it reads as what it is: a list that needs consent collecting.
 *
 * Also reports whether the send would need approval, so a manager finds that
 * out while they are still writing rather than at the moment they expected it
 * to go.
 */
const previewAudience = asyncHandler(async (req, res) => {
  const audience = parseAudience(req.body.audience);

  res.json({
    success: true,
    data: await campaignService.previewAudience(audience, req.user),
  });
});

/**
 * POST /api/campaigns/draft — body: { goal, channel, audience }
 *
 * Generate copy without creating anything. Separate from `create` so a user
 * can redraft as many times as they like before committing a record, and so a
 * failed AI call does not leave a half-made campaign behind.
 */
const draftContent = asyncHandler(async (req, res) => {
  const audience = parseAudience(req.body.audience);

  const { channel } = req.body;
  if (!CONTACT_CHANNEL_VALUES.includes(channel)) {
    throw ApiError.badRequest(`channel must be one of: ${CONTACT_CHANNEL_VALUES.join(', ')}`);
  }

  const contacts = await contactService.resolveAudience(audience, req.user);

  const content = await campaignContentService.draft(
    {
      goal: String(req.body.goal || '').slice(0, 500),
      channel,
      audience,
      audienceCount: contacts.length,
    },
    req.user._id.toString()
  );

  res.json({ success: true, data: content });
});

/**
 * POST /api/campaigns
 *
 * Creates a DRAFT. Never sends — sending is a separate, deliberate act
 * against an existing campaign, so that no single request can both invent a
 * campaign and put it in front of four thousand people.
 */
const createCampaign = asyncHandler(async (req, res) => {
  const audience = parseAudience(req.body.audience);

  const { channel } = req.body;
  if (!CONTACT_CHANNEL_VALUES.includes(channel)) {
    throw ApiError.badRequest(`channel must be one of: ${CONTACT_CHANNEL_VALUES.join(', ')}`);
  }

  const content = req.body.content || {};

  if (channel === 'email' && !(content.subject && content.body)) {
    throw ApiError.badRequest('An email campaign needs a subject and a body');
  }
  if (channel === 'sms' && !(content.sms || content.body)) {
    throw ApiError.badRequest('An SMS campaign needs message text');
  }
  if (channel === 'whatsapp' && !(content.whatsapp || content.body)) {
    throw ApiError.badRequest('A WhatsApp campaign needs message text');
  }

  const campaign = await Campaign.create({
    name: String(req.body.name || '').trim(),
    goal: String(req.body.goal || '').trim(),
    channel,
    audience,
    content: {
      subject: content.subject || '',
      body: content.body || '',
      sms: content.sms || '',
      whatsapp: content.whatsapp || '',
      socialPost: content.socialPost || '',
      mode: content.mode || 'manual',
    },
    status: CAMPAIGN_STATUS.DRAFT,
    createdBy: req.user._id,
  });

  await recordAudit(req, {
    action: 'create',
    entity: 'campaign',
    entityId: campaign._id,
    label: campaign.name,
    after: campaign,
  });

  res.status(201).json({ success: true, data: campaign });
});

/** PATCH /api/campaigns/:id — edit a draft. */
const updateCampaign = asyncHandler(async (req, res) => {
  const campaign = await loadOwn(req.user, req.params.id);

  /*
   * Only a draft is editable, and the refusal matters most for a campaign
   * waiting on an admin: editing the copy after somebody agreed to send it
   * would mean the approved thing and the sent thing were different
   * documents. That is the entire failure mode an approval queue exists to
   * prevent, so it is refused rather than merely discouraged.
   */
  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) {
    throw ApiError.badRequest(
      `A campaign can only be edited while it is a draft — this one is ${campaign.status}.`
    );
  }

  const before = campaign.toObject();

  if (req.body.name !== undefined) campaign.name = String(req.body.name).trim();
  if (req.body.goal !== undefined) campaign.goal = String(req.body.goal).trim();
  if (req.body.audience) campaign.audience = parseAudience(req.body.audience);

  if (req.body.channel) {
    if (!CONTACT_CHANNEL_VALUES.includes(req.body.channel)) {
      throw ApiError.badRequest(`channel must be one of: ${CONTACT_CHANNEL_VALUES.join(', ')}`);
    }
    campaign.channel = req.body.channel;
  }

  if (req.body.content) {
    for (const field of ['subject', 'body', 'sms', 'whatsapp', 'socialPost', 'mode']) {
      if (req.body.content[field] !== undefined) {
        campaign.content[field] = req.body.content[field];
      }
    }
  }

  await campaign.save();

  await recordAudit(req, {
    action: 'update',
    entity: 'campaign',
    entityId: campaign._id,
    label: campaign.name,
    before,
    after: campaign,
  });

  res.json({ success: true, data: campaign });
});

/**
 * POST /api/campaigns/:id/send
 *
 * Sends it, or queues it for an admin. Which of those happened is in the
 * response as `queued`, with the number of out-of-scope contacts that caused
 * it — a manager pressing send and getting a generic 200 would reasonably
 * assume it went.
 */
const sendCampaign = asyncHandler(async (req, res) => {
  const campaign = await loadOwn(req.user, req.params.id);

  const result = await campaignService.requestSend(campaign, req.user);

  await recordAudit(req, {
    action: 'update',
    entity: 'campaign',
    entityId: campaign._id,
    label: campaign.name,
    note: result.queued
      ? `Campaign submitted for approval — ${result.outsideScope} contacts outside the sender's own scope`
      : `Campaign sent: ${result.campaign.sentCount} delivered, ` +
        `${result.campaign.skippedNoConsentCount} skipped for consent, ` +
        `${result.campaign.failureCount} failed`,
  });

  res.json({
    success: true,
    queued: result.queued,
    outsideScope: result.outsideScope ?? 0,
    data: result.campaign,
  });
});

/** DELETE /api/campaigns/:id — drafts only. */
const deleteCampaign = asyncHandler(async (req, res) => {
  const campaign = await loadOwn(req.user, req.params.id);

  /*
   * A sent campaign is a record of something that happened to real people, so
   * it is not deletable — the same reasoning that keeps a cancelled order's
   * document in place. Its recipient rows are what answer "why did I get
   * this", and deleting the campaign would orphan them.
   */
  if (campaign.status !== CAMPAIGN_STATUS.DRAFT) {
    throw ApiError.badRequest(
      'Only a draft can be deleted. A campaign that has been sent or is awaiting ' +
        'approval is a record of something that happened.'
    );
  }

  await campaign.deleteOne();

  await recordAudit(req, {
    action: 'delete',
    entity: 'campaign',
    entityId: campaign._id,
    label: campaign.name,
    before: campaign,
  });

  res.json({ success: true, message: 'Campaign deleted' });
});

module.exports = {
  listCampaigns,
  getCampaign,
  previewAudience,
  draftContent,
  createCampaign,
  updateCampaign,
  sendCampaign,
  deleteCampaign,
};
