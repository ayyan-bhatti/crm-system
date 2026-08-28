const { componentLogger } = require('../config/logger');
const aiClient = require('./aiClient');
const { parseAndValidate, string, enumValue } = require('./aiJson');

const log = componentLogger('ai-message-draft');

const MAX_SUBJECT = 120;
const MAX_BODY = 1200;

/**
 * A drafted follow-up message for a rep to review and send by hand.
 *
 * NEVER SENT BY THIS FEATURE. The model drafts text; nothing here has a mail
 * transport wired to it, and the response is meant to be read, edited and
 * sent by the person who asked for it — the same reason a customer's own
 * words are quoted rather than paraphrased when they matter.
 *
 * Three tones cover the situations a rep actually reaches for a template:
 * checking in with no particular news, proposing more business, or trying
 * to revive a relationship that has gone quiet. The tone is chosen by the
 * caller, not the model — this is the "bounded, schema-validated structured
 * choice" the AI discipline allows, and it is validated against the same
 * fixed list on the way in as the way out.
 */
const TONES = ['check-in', 'upsell', 'win-back'];

const TONE_GUIDANCE = {
  'check-in': 'A friendly, no-pressure check-in. No ask, just staying in touch.',
  upsell: 'Suggest more business — a larger order, a related product, or a recurring ' +
    'arrangement — grounded in what they have actually bought before.',
  'win-back': 'They have gone quiet. Acknowledge the gap without guilt-tripping them, and ' +
    'give them an easy, low-pressure way to pick things back up.',
};

function validateDraft(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const subject = string(raw.subject, MAX_SUBJECT);
  const body = string(raw.body, MAX_BODY);
  if (!subject || !body) return null;
  return { subject, body };
}

function buildSystemPrompt(tone) {
  return `You draft a short follow-up email for a sales rep at a CRM company to send to one
of their customers. You are given the customer's details and figures that have ALREADY
been calculated — never invent a number, and never reference a figure that is not given
to you. The rep will read this before sending it, so it must sound like a person wrote
it, not a template: specific, brief, and easy to edit.

Tone for this draft: ${TONE_GUIDANCE[tone]}

Respond with a JSON object only: {"subject": "<email subject>", "body": "<the email body>"}`;
}

function callModel(customer, metrics, tone, userId) {
  return aiClient.complete({
    feature: 'message-draft',
    userId,
    system: buildSystemPrompt(tone),
    user: JSON.stringify({
      customer: { name: customer.name, company: customer.company || null },
      calculatedFigures: {
        totalOrders: metrics.orderCount,
        totalRevenue: metrics.totalRevenue,
        daysSinceLastOrder: metrics.daysSinceLastOrder,
        trend: metrics.trend,
      },
    }),
    maxTokens: 500,
  });
}

/** A short, honest template when the AI path is unavailable. */
function fallbackDraft(customer, tone) {
  const name = customer.name;

  if (tone === 'win-back') {
    return {
      subject: `Checking in, ${name}`,
      body:
        `Hi ${name},\n\nIt's been a while since we last spoke, and I wanted to check in and ` +
        `see how things are going. No pressure at all — just let me know if there's anything ` +
        `I can help with.\n\nBest,`,
    };
  }

  if (tone === 'upsell') {
    return {
      subject: `A thought for ${name}`,
      body:
        `Hi ${name},\n\nBased on what you've ordered before, I thought it might be worth a ` +
        `quick chat about what else could help. Let me know if you'd like to hear more.\n\nBest,`,
    };
  }

  return {
    subject: `Just checking in, ${name}`,
    body:
      `Hi ${name},\n\nJust wanted to check in and see how everything's going on your end. ` +
      `Let me know if there's anything you need.\n\nBest,`,
  };
}

/**
 * Draft a follow-up message. Never throws.
 * `{ mode: 'ai'|'fallback', subject, body }`.
 */
async function draft(customer, metrics, tone, userId = null) {
  const chosenTone = enumValue(tone, TONES, 'check-in');

  if (!aiClient.isConfigured()) {
    return { mode: 'fallback', ...fallbackDraft(customer, chosenTone) };
  }

  let text;
  try {
    text = await callModel(customer, metrics, chosenTone, userId);
  } catch (err) {
    log.warn({ err }, 'model call failed — using the template draft');
    return { mode: 'fallback', ...fallbackDraft(customer, chosenTone) };
  }

  const result = parseAndValidate(text, validateDraft);
  if (!result.ok) return { mode: 'fallback', ...fallbackDraft(customer, chosenTone) };

  return { mode: 'ai', ...result.value };
}

module.exports = { draft, TONES, validateDraft };
