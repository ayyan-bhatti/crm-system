const env = require('../config/env');
const { componentLogger } = require('../config/logger');

const log = componentLogger('whatsapp');

/**
 * Sending a WhatsApp message, through whichever transport is configured.
 *
 * Same shape as services/mailer.js and services/smsClient.js — see the note in
 * the latter on why the three are deliberately identical.
 *
 *   console  the default. Writes the message to the log; the whole flow works
 *            with no Meta account, no Business verification and no template.
 *   meta     POSTs to the WhatsApp Cloud API graph endpoint.
 *
 * ============================================================================
 * THE 24-HOUR WINDOW, AND WHY MARKETING IS ALWAYS OUTSIDE IT
 * ============================================================================
 *
 * This is a platform rule, not an implementation detail, and it is the single
 * thing most likely to make someone think this integration is broken when it
 * is working exactly as WhatsApp requires.
 *
 * Meta permits a business to send FREE-FORM text only within 24 hours of the
 * customer's own most recent message to that business. That window is called
 * the customer service window. Outside it, the API accepts one thing and one
 * thing only: a MESSAGE TEMPLATE that Meta has reviewed and approved in
 * advance, referenced by name, with variables filled in.
 *
 * Marketing is outside the window by definition. Nobody messages a shop asking
 * to be marketed at, so a campaign, a review request and a reorder nudge are
 * all sent to people who have not written to the business today. Sending them
 * as free-form text does not fail loudly — it returns an error that reads like
 * a permissions problem, and the message simply never arrives.
 *
 * So this transport sends a TEMPLATE whenever one is configured, and refuses
 * to send at all when the Meta transport is on without one. Refusing is the
 * honest behaviour: the alternative is reporting a successful send for a
 * message the platform discarded.
 *
 * WHAT HAS TO HAPPEN ON META'S SIDE BEFORE THIS CAN GO LIVE
 *
 *   1. A Meta Business account, with the business verified.
 *   2. A WhatsApp Business Account with a phone number registered to it. The
 *      number cannot already be on the consumer WhatsApp app.
 *   3. A message template submitted in WhatsApp Manager under the MARKETING
 *      category, and APPROVED. Review takes anywhere from minutes to days, and
 *      templates are rejected for promotional wording that Meta considers
 *      spam-like. A template's variables are positional: {{1}}, {{2}}.
 *   4. A permanent access token from a System User with `whatsapp_business_
 *      messaging` permission. The token from the Getting Started panel expires
 *      in 24 hours and is for testing only.
 *   5. Recipients must have opted in through a channel Meta recognises, and
 *      Meta audits this. The consent model in this app is what that opt-in
 *      means here — see models/marketingConsent.js.
 *
 * Marketing templates are also billed per conversation and rate-limited by a
 * quality score that falls when people block or report the business. That is
 * the commercial reason to respect the consent gate, on top of the legal one.
 */

const GRAPH_API = 'https://graph.facebook.com/v21.0';

const REQUEST_TIMEOUT_MS = 8000;

/** Is a real transport configured, template included? */
function isConfigured() {
  if (env.whatsappTransport !== 'meta') return false;
  return Boolean(
    env.whatsappPhoneNumberId && env.whatsappAccessToken && env.whatsappTemplateName
  );
}

function activeTransport() {
  return env.whatsappTransport === 'meta' ? 'meta' : 'console';
}

/**
 * Deliver one WhatsApp message. Never throws — see `smsClient.sendSms`.
 *
 * @param {{ to: string, text: string, templateParams?: string[] }} message
 *   `text` is used verbatim by the console transport and as the single
 *   template variable by the Meta one, unless `templateParams` says otherwise.
 * @returns {Promise<{ delivered: boolean, transport: string, error?: string }>}
 */
async function sendWhatsApp({ to, text, templateParams = null }) {
  const transport = activeTransport();

  if (!to) {
    return { delivered: false, transport, error: 'no phone number on this contact' };
  }

  try {
    if (transport === 'meta') {
      return await sendViaMeta({ to, text, templateParams });
    }

    return sendViaConsole({ to, text });
  } catch (err) {
    log.error({ err, transport }, 'whatsapp delivery failed');
    return { delivered: false, transport, error: err.message };
  }
}

function sendViaConsole({ to, text }) {
  if (env.isProduction) {
    log.warn(
      'WHATSAPP_TRANSPORT is not configured, so this message was only written to the log ' +
        'and nothing was sent. Set WHATSAPP_TRANSPORT=meta with WHATSAPP_PHONE_NUMBER_ID, ' +
        'WHATSAPP_ACCESS_TOKEN and an APPROVED WHATSAPP_TEMPLATE_NAME to deliver it.'
    );
  }

  log.info({ to, body: text }, 'whatsapp (console transport)');

  return { delivered: true, transport: 'console' };
}

async function sendViaMeta({ to, text, templateParams }) {
  if (!env.whatsappPhoneNumberId || !env.whatsappAccessToken) {
    throw new Error(
      'WHATSAPP_TRANSPORT=meta but WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN is not set'
    );
  }

  /*
   * REFUSING RATHER THAN FALLING BACK TO FREE-FORM TEXT.
   *
   * The tempting alternative is to send a plain text message when no template
   * is configured. It would be worse than this error in every case that
   * matters: Meta rejects it outside the service window, and the rejection
   * arrives as a generic failure that looks like a bad token. Someone would
   * spend an afternoon rotating credentials to fix a missing template.
   */
  if (!env.whatsappTemplateName) {
    throw new Error(
      'WHATSAPP_TEMPLATE_NAME is not set. Marketing messages are always outside the ' +
        '24-hour customer service window, so WhatsApp only accepts a Meta-APPROVED ' +
        'template — free-form text would be discarded. Create and approve a template in ' +
        'WhatsApp Manager, then set its name here.'
    );
  }

  const parameters = (templateParams || [text]).map((value) => ({
    type: 'text',
    text: String(value),
  }));

  const response = await fetch(
    `${GRAPH_API}/${encodeURIComponent(env.whatsappPhoneNumberId)}/messages`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.whatsappAccessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        // Meta wants E.164 WITHOUT the leading '+' here, unlike Twilio.
        to: String(to).replace(/^\+/, ''),
        type: 'template',
        template: {
          name: env.whatsappTemplateName,
          language: { code: env.whatsappTemplateLanguage },
          components: parameters.length
            ? [{ type: 'body', parameters }]
            : [],
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    /*
     * Graph API errors carry a `message` naming the actual cause — a template
     * that is not approved, a variable count that does not match the approved
     * body, a recipient who has not opted in on Meta's side. All of them are
     * 400s and all of them mean something different.
     */
    const detail = await response
      .text()
      .then((raw) => raw.trim().slice(0, 300))
      .catch(() => '');

    throw new Error(`meta responded ${response.status}${detail ? ` — ${detail}` : ''}`);
  }

  return { delivered: true, transport: 'meta' };
}

module.exports = { sendWhatsApp, isConfigured, activeTransport };
