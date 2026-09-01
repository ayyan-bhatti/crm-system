const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const {
  CAMPAIGN_AUDIENCE_LABELS,
  MAX_CAMPAIGN_SUBJECT,
  MAX_CAMPAIGN_BODY,
  MAX_SMS_LENGTH,
  MAX_WHATSAPP_LENGTH,
  MAX_SOCIAL_POST,
} = require('../config/marketing');

const log = componentLogger('ai-campaign-content');

/**
 * Drafting a campaign's copy: an email, an SMS, a WhatsApp message and a
 * social post, from one goal and one audience.
 *
 * WHY ALL FOUR IN ONE CALL RATHER THAN FOUR CALLS
 *
 * They are four expressions of the same idea, and generating them separately
 * produces four campaigns wearing a trench coat: the email offers a discount
 * the SMS does not mention, the social post announces something the email does
 * not. One call, one idea, four lengths — plus it costs a quarter as much and
 * the caller waits once instead of four times.
 *
 * NOTHING SENDS WITHOUT A HUMAN READING IT, IN THIS ROUND.
 *
 * This service returns text. It has no transport, it does not know what a
 * recipient is, and the campaign it drafts for starts life as a `draft` that
 * a person has to review and dispatch. That is a stated constraint of the
 * round rather than a limitation of the model, and it is the right one: the
 * blast radius of a bad generated sentence is one customer when a rep sends
 * it by hand and the entire list when a scheduler does.
 *
 * THE SOCIAL POST IS TEXT TO COPY, NOT A POST.
 *
 * Nothing here talks to a social platform. See the note on `content.socialPost`
 * in models/Campaign.js for the full reasoning — briefly: real auto-posting
 * means a per-platform OAuth app, platform review, stored tokens with posting
 * scope on the business's own accounts, and a silent failure mode. That is a
 * project, not a field.
 *
 * WHAT THE MODEL IS AND IS NOT TRUSTED WITH
 *
 * Same discipline as every other AI feature here. It writes prose. It is never
 * given a customer list, never asked to decide who receives anything, and
 * never asked to compute a figure — the audience size it is told is already
 * counted, and it is told it only so the copy can be pitched at the right
 * scale. A failed or unparseable call degrades to a written template, not to
 * an error, because a campaign builder that cannot open when the AI is down is
 * a campaign builder nobody relies on.
 */

/** Bounded so one odd response cannot put a wall of text in a form field. */
const LIMITS = {
  subject: MAX_CAMPAIGN_SUBJECT,
  body: MAX_CAMPAIGN_BODY,
  sms: MAX_SMS_LENGTH,
  whatsapp: MAX_WHATSAPP_LENGTH,
  socialPost: MAX_SOCIAL_POST,
};

function validateContent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const content = {
    subject: string(raw.subject, LIMITS.subject),
    body: string(raw.body, LIMITS.body),
    sms: string(raw.sms, LIMITS.sms),
    whatsapp: string(raw.whatsapp, LIMITS.whatsapp),
    socialPost: string(raw.socialPost, LIMITS.socialPost),
  };

  /*
   * The email subject and body are required; the other three are not.
   *
   * Rejecting the whole response because the model skipped the social post
   * would throw away three good fields to punish a missing fourth, and the
   * caller would fall back to a template for all of them. A partial answer is
   * genuinely useful here in a way it is not for, say, a search filter — the
   * output is a form a person is about to edit.
   */
  if (!content.subject || !content.body) return null;

  content.sms = content.sms || '';
  content.whatsapp = content.whatsapp || '';
  content.socialPost = content.socialPost || '';

  return content;
}

function buildSystemPrompt() {
  return `You write marketing copy for a small business that sells physical products
through an online shop. You are given a GOAL and a description of the AUDIENCE, and you
write one campaign in four forms.

Rules, all of which matter:
- Never invent a discount, an offer, a deadline or a product name. You have not been
  told about any, so there are none. Copy that promises something the business did not
  agree to is worse than no copy.
- Never invent a figure. Do not state how many customers there are, how long since they
  ordered, or what anything costs.
- No false urgency, no guilt, no "we miss you" if the audience is not lapsed.
- Write like a person at a small company, not like a marketing department. Short
  sentences. No exclamation marks stacked up.
- Address the reader as "you". Use {{name}} where the recipient's first name should go;
  it is substituted before sending.
- Do not write a subscript, footer, unsubscribe line or signature. Those are added
  automatically and yours would be a duplicate.

The four forms:
  subject     an email subject line, under 80 characters, no emoji
  body        the email body, two or three short paragraphs
  sms         the same message in under 300 characters, plain text, no links unless
              the goal mentions one
  whatsapp    the same message, slightly warmer than the SMS, under 600 characters
  socialPost  a public post about the same thing, written for the business's own
              followers rather than addressed to one person, so no {{name}}

Respond with a JSON object only:
{"subject": "...", "body": "...", "sms": "...", "whatsapp": "...", "socialPost": "..."}`;
}

/**
 * Describe the audience to the model in words rather than as data.
 *
 * It is given the SHAPE of the audience — "customers who have gone quiet",
 * "people who first ordered in the last month" — and a count. It is never
 * given the list. Nothing in a campaign's copy should depend on any individual
 * recipient, because one message goes to all of them, so handing over the
 * names would be a privacy cost with no upside at all.
 */
function describeAudience(audience, audienceCount) {
  const label = CAMPAIGN_AUDIENCE_LABELS[audience.preset] || 'Selected contacts';

  const narrowing = [
    audience.segment ? `segment: ${audience.segment}` : '',
    audience.source ? `source: ${audience.source}` : '',
    audience.tag ? `tagged "${audience.tag}"` : '',
  ].filter(Boolean);

  return {
    audience: label,
    narrowedBy: narrowing.length ? narrowing : null,
    approximateSize: audienceCount,
  };
}

function callModel({ goal, channel, audience, audienceCount }, userId) {
  return aiClient.complete({
    feature: 'campaign-content',
    userId,
    system: buildSystemPrompt(),
    user: JSON.stringify({
      goal,
      primaryChannel: channel,
      ...describeAudience(audience, audienceCount),
    }),
    maxTokens: 1200,
  });
}

/**
 * The written template, used whenever the model is unavailable or unusable.
 *
 * DELIBERATELY PLAIN AND DELIBERATELY HONEST. It does not pretend to be
 * generated copy: it is a scaffold with the goal in it, and the campaign
 * builder labels it as a template so nobody sends it thinking a model wrote
 * it. Its job is to make the feature usable with no API key at all, which is
 * the same standard every other AI feature in this app is held to.
 *
 * It contains no offer, no urgency and no claim about the recipient, because
 * a fallback that guesses is worse than one that is bland.
 */
function fallbackContent(goal, audience) {
  const topic = goal ? goal.trim().replace(/\.$/, '') : 'an update from us';
  const label = (CAMPAIGN_AUDIENCE_LABELS[audience.preset] || 'our customers').toLowerCase();

  return {
    subject: `A quick note about ${topic}`,
    body:
      `Hi {{name}},\n\n` +
      `We wanted to get in touch about ${topic}.\n\n` +
      `If it is useful to you, just reply to this email and we will pick it up from ` +
      `there. If not, no problem at all.\n\n` +
      `Thanks for shopping with us.`,
    sms: `Hi {{name}}, a quick note from us about ${topic}. Reply to this message if you would like to know more.`,
    whatsapp:
      `Hi {{name}} — a quick note from us about ${topic}. ` +
      `Reply here if you would like to know more, and thanks for shopping with us.`,
    socialPost: `A quick update for ${label}: ${topic}. Get in touch if you would like to know more.`,
  };
}

/**
 * Draft a campaign's content. Never throws.
 *
 * @returns {Promise<{ mode: 'ai'|'fallback', subject, body, sms, whatsapp, socialPost }>}
 */
async function draft({ goal, channel, audience, audienceCount = 0 }, userId = null) {
  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', ...fallbackContent(goal, audience) };
  }

  let text;
  try {
    text = await callModel({ goal, channel, audience, audienceCount }, userId);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the template copy');
    return { mode: 'fallback', ...fallbackContent(goal, audience) };
  }

  const result = parseAndValidate(text, validateContent);
  if (!result.ok) {
    log.warn({ reason: result.reason }, 'model reply rejected — using the template copy');
    return { mode: 'fallback', ...fallbackContent(goal, audience) };
  }

  return { mode: 'ai', ...result.value };
}

/**
 * Substitute the per-recipient placeholders.
 *
 * ONE PLACEHOLDER, `{{name}}`, and the smallness of that list is the point. A
 * template language in a marketing tool is a feature that grows until somebody
 * can address a field the recipient should not see, and every additional token
 * is another way for a send to go out with a literal `{{lastOrderTotal}}` in
 * it because the data was missing for one person.
 *
 * The fallback for a missing name is "there" rather than an empty string,
 * because "Hi ," is unmistakably a broken mail-merge and "Hi there," is a
 * perfectly ordinary greeting.
 *
 * The FIRST name only: "Hi Muhammad Ayyan Bhatti," reads like a summons.
 */
function personalise(text, contact) {
  const first = String(contact?.name || '').trim().split(/\s+/)[0] || 'there';
  return String(text || '').replace(/\{\{\s*name\s*\}\}/g, first);
}

module.exports = { draft, personalise, validateContent, fallbackContent };
