const mongoose = require('mongoose');
const {
  CONTACT_CHANNEL_VALUES,
  CAMPAIGN_STATUS,
  CAMPAIGN_STATUS_VALUES,
  CAMPAIGN_AUDIENCE_VALUES,
  CONTACT_SOURCE_VALUES,
  AUTO_SEGMENT_VALUES,
  MAX_CAMPAIGN_SUBJECT,
  MAX_CAMPAIGN_BODY,
  MAX_SMS_LENGTH,
  MAX_WHATSAPP_LENGTH,
  MAX_SOCIAL_POST,
} = require('../config/marketing');

/**
 * One marketing campaign: who it is for, what it says, and what happened.
 *
 * WHY THE AUDIENCE IS STORED AS A DEFINITION AND NOT AS A LIST OF PEOPLE
 *
 * The audience here is the FILTER — "at-risk customers", "source: storefront",
 * "tagged VIP" — not the resolved membership. The membership is written out
 * per person as `CampaignRecipient` rows at the moment of sending.
 *
 * Storing both is not duplication, it is the difference between two questions
 * that get asked at different times and must not be answered by the same data:
 *
 *   the definition  what did we MEAN to target? Still answerable in a year,
 *                   still meaningful after the underlying segments move.
 *   the rows        who did we ACTUALLY message? Fixed at send time and never
 *                   recomputed, because "at risk" means something different
 *                   today and re-resolving the filter would quietly rewrite
 *                   history.
 *
 * A campaign that stored only the filter could not answer "did this person get
 * it". One that stored only the rows could not answer "why were they in it".
 *
 * WHY CONTENT IS FOUR FIELDS AND NOT ONE
 *
 * The AI drafts an email subject and body, an SMS, a WhatsApp message and a
 * social post in ONE call, because they are four expressions of one idea and
 * generating them separately produces four campaigns wearing a trench coat.
 * Only the fields the chosen channel needs are sent; the rest are kept because
 * a staff member asked for them and will want to reuse them.
 *
 * The social post is TEXT FOR A HUMAN TO POST. Nothing in this app publishes
 * to a social platform — see the note on `socialPost` below.
 */

const audienceSchema = new mongoose.Schema(
  {
    /**
     * The named shortcut, if one was used: `all`, `at_risk`, `new`, `mine`…
     *
     * `all` is a value rather than the absence of a filter, deliberately.
     * "Everyone" has to be something a person chose and an approver can see
     * them having chosen, not what happens when a form is submitted empty.
     */
    preset: {
      type: String,
      enum: {
        values: CAMPAIGN_AUDIENCE_VALUES,
        message: '{VALUE} is not an audience',
      },
      required: [true, 'A campaign needs an audience'],
    },

    /** Narrow the preset further by where the contact came from. */
    source: {
      type: String,
      enum: {
        values: [...CONTACT_SOURCE_VALUES, ''],
        message: '{VALUE} is not a contact source',
      },
      default: '',
    },

    /** Narrow by a computed segment tag. */
    segment: {
      type: String,
      enum: {
        values: [...AUTO_SEGMENT_VALUES, ''],
        message: '{VALUE} is not a segment',
      },
      default: '',
    },

    /** Narrow by a hand-assigned tag such as "VIP". */
    tag: {
      type: String,
      trim: true,
      default: '',
      maxlength: 32,
    },
  },
  { _id: false }
);

const contentSchema = new mongoose.Schema(
  {
    subject: { type: String, trim: true, default: '', maxlength: MAX_CAMPAIGN_SUBJECT },
    body: { type: String, trim: true, default: '', maxlength: MAX_CAMPAIGN_BODY },
    sms: { type: String, trim: true, default: '', maxlength: MAX_SMS_LENGTH },
    whatsapp: { type: String, trim: true, default: '', maxlength: MAX_WHATSAPP_LENGTH },

    /**
     * A social media post, AS TEXT, for a staff member to copy and post.
     *
     * THIS APP DOES NOT POST TO ANY SOCIAL PLATFORM, and that is a deliberate
     * scope decision rather than an unfinished one. Actually publishing would
     * mean a per-platform OAuth app, review and approval by each platform,
     * stored refresh tokens with posting scope on the business's own accounts,
     * and a token-refresh failure mode whose symptom is silence. That is a
     * project, not a field. Generating strong copy for a person to paste is
     * the right-sized version of "social media marketing" for this round, and
     * it is the part the AI is actually good at.
     */
    socialPost: { type: String, trim: true, default: '', maxlength: MAX_SOCIAL_POST },

    /** Whether the model wrote this or the deterministic template did. */
    mode: {
      type: String,
      enum: ['ai', 'fallback', 'manual'],
      default: 'manual',
    },
  },
  { _id: false }
);

const campaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'A campaign needs a name'],
    trim: true,
    maxlength: [120, 'A campaign name cannot exceed 120 characters'],
  },

  /**
   * What the campaign is trying to achieve, in the sender's own words.
   *
   * Kept on the record rather than being a transient prompt input, for two
   * reasons: it is what the AI was given, so it explains the copy; and it is
   * what an ADMIN READS WHEN DECIDING WHETHER TO APPROVE. An approval queue
   * showing only "Campaign to 4,000 people" asks the approver to rubber-stamp.
   */
  goal: {
    type: String,
    trim: true,
    default: '',
    maxlength: [500, 'A goal cannot exceed 500 characters'],
  },

  channel: {
    type: String,
    enum: {
      values: CONTACT_CHANNEL_VALUES,
      message: `Channel must be one of: ${CONTACT_CHANNEL_VALUES.join(', ')}`,
    },
    required: [true, 'A campaign needs a channel'],
  },

  audience: {
    type: audienceSchema,
    required: true,
  },

  content: {
    type: contentSchema,
    default: () => ({}),
  },

  status: {
    type: String,
    enum: {
      values: CAMPAIGN_STATUS_VALUES,
      message: `Status must be one of: ${CAMPAIGN_STATUS_VALUES.join(', ')}`,
    },
    default: CAMPAIGN_STATUS.DRAFT,
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  /**
   * Set when a manager's campaign needed an admin, and by whom it was decided.
   *
   * Null on an admin's own campaign, which sends immediately — the same rule
   * as everywhere else in this system, and for the same reason: an approver
   * who approves their own requests is not an approver, and a queue that fills
   * with your own items is a queue you stop reading.
   */
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  approvedAt: {
    type: Date,
    default: null,
  },

  /** The `ChangeRequest` carrying this campaign's approval, if it needed one. */
  changeRequestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChangeRequest',
    default: null,
  },

  /* -------------------------------------------------------------------------
   * OUTCOME COUNTERS
   *
   * Denormalised from the recipient rows because every list screen shows them
   * for every campaign, and counting sub-documents per row is the query that
   * looks fine on ten campaigns and falls over on a thousand. The rows remain
   * the source of truth; these are a cache written once, at the end of a send,
   * from the rows themselves rather than from an intention.
   * ---------------------------------------------------------------------- */

  /** How many were actually messaged. */
  sentCount: { type: Number, default: 0 },

  /** How many the transport refused or errored on. */
  failureCount: { type: Number, default: 0 },

  /**
   * How many matched the audience and were dropped for lack of consent.
   *
   * SURFACED RATHER THAN SWALLOWED, because the brief is explicit that this
   * must not be a silent number mismatch — and because it is the single most
   * useful number on the screen. "Audience 500, sent 40" with no explanation
   * reads as a bug in the send; "460 had not opted in to email" reads as the
   * system working and a list that needs consent collecting.
   */
  skippedNoConsentCount: { type: Number, default: 0 },

  /** Size of the resolved audience before consent was applied. */
  audienceCount: { type: Number, default: 0 },

  sentAt: { type: Date, default: null },

  /** Why a dispatch failed outright, for the one who has to fix it. */
  failureReason: { type: String, default: '', maxlength: 500 },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

/* ---------------------------------------------------------------------------
 * INDEXES
 *
 * Same discipline as everywhere else in this codebase: one index per query
 * that actually runs, each ending in `_id` in the sort's direction because
 * `getSort` appends `_id` to make the ordering total — an index on
 * { createdAt: -1 } does NOT satisfy a sort of { createdAt: -1, _id: -1 }.
 * -------------------------------------------------------------------------*/

/** The campaign list, newest first. */
campaignSchema.index({ createdAt: -1, _id: -1 });

/** The list filtered by status — and the approval queue's own lookup. */
campaignSchema.index({ status: 1, createdAt: -1, _id: -1 });

/** "My campaigns" for a manager, who sees their own rather than everyone's. */
campaignSchema.index({ createdBy: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model('Campaign', campaignSchema);
