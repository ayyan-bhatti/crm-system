const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string } = require('./aiJson');
const { MAX_CAMPAIGN_SUBJECT, MAX_SMS_LENGTH } = require('../config/marketing');

const log = componentLogger('ai-post-sale');

/**
 * The wording of the two automated post-sale messages.
 *
 * WHY THIS IS NOT `messageDraftService` WITH TWO MORE TONES
 *
 * That service drafts a follow-up FOR A REP TO SEND BY HAND, in the rep's
 * voice, to one customer they are working. These two messages are sent by a
 * scheduler, in the business's voice, to whoever qualifies, with nobody
 * reading them first. Same model, same JSON discipline, materially different
 * job — and the difference has a concrete consequence: these need a short
 * version for SMS and WhatsApp, which a rep's email draft never does.
 *
 * Widening the existing service's `TONES` enum would also have changed the
 * tone list the frontend's `DraftMessageCard` mirrors, putting "review
 * request" in a dropdown next to "upsell" on a rep's screen — an option that
 * would send nothing and mean nothing there.
 *
 * ============================================================================
 * WHAT THE MODEL IS FORBIDDEN TO DO, AND WHY IT MATTERS MORE HERE
 * ============================================================================
 *
 * Nobody reads these before they go out. That removes the safety net every
 * other AI feature in this app has, so the prompt is correspondingly strict
 * and the fallback correspondingly plain:
 *
 *   no invented incentive   "leave a review and get 10% off" is a promise the
 *                           business never made and would have to honour
 *   no fabricated praise    "we know you loved it" — it has not been said
 *   no pressure             no deadlines, no "last chance", no guilt
 *   no invented figures     it is told the product name and nothing numeric
 *
 * If the model returns anything that fails validation, the deterministic
 * template below is used instead. That template is what the round's brief was
 * asked about and what was chosen: warm and plain, no incentives, no urgency.
 */

const MAX_BODY = 900;

function validateMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const subject = string(raw.subject, MAX_CAMPAIGN_SUBJECT);
  const body = string(raw.body, MAX_BODY);
  if (!subject || !body) return null;

  return {
    subject,
    body,
    // Optional: a missing short form falls back to a trimmed body rather than
    // failing the whole draft. See campaignContentService for the same call.
    short: string(raw.short, MAX_SMS_LENGTH) || '',
  };
}

const SHARED_RULES = `
Rules, all of which matter more than usual because NOBODY READS THIS BEFORE IT IS SENT:
- Never offer a discount, voucher, free delivery, prize or incentive of any kind. None
  has been authorised, and the business would have to honour whatever you invent.
- Never claim to know what the customer thought of anything.
- Never invent a figure, a date, a deadline or a product detail you were not given.
- No urgency, no scarcity, no guilt, no "last chance", no exclamation marks stacked up.
- Write like one person at a small shop writing to another person. Short sentences.
- Use {{name}} where the customer's first name goes. Do not write a signature, a footer
  or an unsubscribe line — those are added automatically.`;

function reviewSystemPrompt() {
  return `You write a short message asking a customer how a recent delivery went.

The purpose is genuinely to hear from them — good or bad. It is not to collect a
five-star review, and it must not read as though a particular answer is wanted.
${SHARED_RULES}

Respond with a JSON object only:
{"subject": "<email subject>", "body": "<the message>", "short": "<the same in under 300 characters>"}`;
}

function reorderSystemPrompt() {
  return `You write a short message to a customer who is coming up to the point where they
usually reorder.

They are NOT late and nothing is wrong — this is a helpful nudge, not a chase. It must
not imply they have forgotten something or that we have noticed their absence. If they
do not need anything, that is a completely fine outcome and the message should say so.
${SHARED_RULES}

Respond with a JSON object only:
{"subject": "<email subject>", "body": "<the message>", "short": "<the same in under 300 characters>"}`;
}

/**
 * The deterministic templates.
 *
 * These are the wording the round confirmed: warm and plain. They are not
 * placeholders — with no API key configured they ARE the product, and both
 * automations work end to end without one, which is the standard every AI
 * feature in this app is held to.
 */
function fallbackReview({ productName }) {
  const what = productName ? `your ${productName}` : 'your order';

  return {
    subject: 'How did it go?',
    body:
      `Hi {{name}},\n\n` +
      `${what.charAt(0).toUpperCase()}${what.slice(1)} arrived a few days ago, and we ` +
      `wanted to check how you got on with it.\n\n` +
      `If you have a minute, we would genuinely like to know — whether it went well or ` +
      `not. Just reply to this message and it comes straight to us.\n\n` +
      `Thanks for shopping with us.`,
    short:
      `Hi {{name}}, ${what} arrived a few days ago — how did you get on with it? ` +
      `Reply here and let us know, good or bad.`,
  };
}

function fallbackReorder({ productName }) {
  const what = productName ? productName : 'what you ordered last time';

  return {
    subject: 'Running low?',
    body:
      `Hi {{name}},\n\n` +
      `It is around the time you usually reorder, so we thought we would check in about ` +
      `${what}.\n\n` +
      `If you are running low, everything is where you left it and reordering takes a ` +
      `minute. If you are fine for now, ignore this — no need to reply.\n\n` +
      `Thanks for shopping with us.`,
    short:
      `Hi {{name}}, it is about the time you usually reorder ${what}. ` +
      `If you are running low we are here; if not, ignore this one.`,
  };
}

async function generate(kind, context, systemPrompt, fallback) {
  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', ...fallback(context) };
  }

  let text;
  try {
    text = await aiClient.complete({
      feature: kind,
      userId: null,
      system: systemPrompt,
      /*
       * The model is given the PRODUCT NAME and nothing else about the person.
       * Not their spend, not their order count, not how long since they last
       * bought — none of which it needs to write two warm sentences, and all
       * of which would be a privacy cost paid for nothing. The name is
       * substituted after generation, so it is never sent either.
       */
      user: JSON.stringify({ product: context.productName || null }),
      maxTokens: 700,
    });
  } catch (err) {
    log.warn({ err, kind }, 'model call failed — using the template');
    return { mode: 'fallback', ...fallback(context) };
  }

  const result = parseAndValidate(text, validateMessage);
  if (!result.ok) {
    log.warn({ kind, reason: result.reason }, 'model reply rejected — using the template');
    return { mode: 'fallback', ...fallback(context) };
  }

  const value = result.value;
  return {
    mode: 'ai',
    subject: value.subject,
    body: value.body,
    short: value.short || value.body.slice(0, MAX_SMS_LENGTH),
  };
}

/** Ask how a delivered order went. Never throws. */
function draftReviewRequest(context = {}) {
  return generate('review-request', context, reviewSystemPrompt(), fallbackReview);
}

/** Nudge somebody approaching their usual reorder point. Never throws. */
function draftReorderReminder(context = {}) {
  return generate('reorder-reminder', context, reorderSystemPrompt(), fallbackReorder);
}

module.exports = {
  draftReviewRequest,
  draftReorderReminder,
  validateMessage,
  fallbackReview,
  fallbackReorder,
};
