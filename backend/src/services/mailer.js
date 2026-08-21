const env = require('../config/env');
const { componentLogger } = require('../config/logger');

const log = componentLogger('mail');

/**
 * Sending mail, through whichever transport is configured.
 *
 * WHY THIS IS AN INTERFACE RATHER THAN AN INTEGRATION
 *
 * The password-reset flow needs to deliver a link. Which service does that —
 * SendGrid, Postmark, SES, a company SMTP relay — is a deployment decision, not
 * an application one, and hard-wiring one of them would mean this project
 * carries an SDK and a vendor account for a single email.
 *
 * So the flow is complete and real, and delivery is a seam:
 *
 *   console   the default. Writes the message to the log, including the reset
 *             link, so the whole flow is exercisable locally and in tests with
 *             nothing configured. NOT a stub that silently drops mail — the
 *             link is genuinely there to click.
 *   webhook   POSTs { from, to, subject, text } to MAIL_WEBHOOK_URL, with
 *             MAIL_WEBHOOK_AUTH as the Authorization header. Enough to connect
 *             a provider or a queue without this project depending on one.
 *
 * That body is deliberately the shape Resend's send endpoint already takes, so
 * the common case needs no relay in between:
 *
 *   MAIL_TRANSPORT=webhook
 *   MAIL_WEBHOOK_URL=https://api.resend.com/emails
 *   MAIL_WEBHOOK_AUTH=Bearer re_...
 *   MAIL_FROM=SimpleCRM <no-reply@your-verified-domain.com>
 *
 * A provider whose payload differs (Postmark uses From/To/TextBody) needs a
 * small relay, or one more branch here — nothing else in the codebase changes.
 *
 * WHY THE CONSOLE TRANSPORT LOGS THE LINK
 *
 * It is a genuine security trade-off, so it is stated rather than hidden: in
 * production, a reset link in the application log is a credential in the log.
 * That is why the console transport WARNS when it runs outside development, and
 * why a real deployment is expected to configure a transport. Refusing to run
 * without one would make the feature impossible to develop against, which is a
 * worse default for a project someone is going to clone and run.
 */

/**
 * Deliver one message.
 *
 * Never throws. A failed send must not fail the request that triggered it —
 * see the note in the password-reset controller about why the response is
 * identical either way.
 *
 * @returns {Promise<{ delivered: boolean, transport: string }>}
 */
async function sendMail({ to, subject, text }) {
  const transport = env.mailTransport;

  try {
    if (transport === 'webhook') {
      return await sendViaWebhook({ to, subject, text });
    }

    return sendViaConsole({ to, subject, text });
  } catch (err) {
    log.error({ err, transport }, 'mail delivery failed');
    return { delivered: false, transport };
  }
}

function sendViaConsole({ to, subject, text }) {
  if (env.isProduction) {
    log.warn(
      'MAIL_TRANSPORT is not configured, so this message is only written to the log. In ' +
        'production that means a reset link is sitting in your log output. Set ' +
        'MAIL_TRANSPORT=webhook and MAIL_WEBHOOK_URL to deliver it properly.'
    );
  }

  /*
   * The body is logged with the message as a field.
   *
   * It contains a one-time link, which is the entire point of the console
   * transport — a developer needs to click it — and also the reason the
   * production warning above exists.
   */
  log.info({ to, subject, body: text }, 'mail (console transport)');

  return { delivered: true, transport: 'console' };
}

async function sendViaWebhook({ to, subject, text }) {
  if (!env.mailWebhookUrl) {
    throw new Error('MAIL_TRANSPORT=webhook but MAIL_WEBHOOK_URL is not set');
  }

  const headers = { 'Content-Type': 'application/json' };

  /*
   * Without this header the transport can only ever talk to an endpoint that
   * accepts anonymous POSTs — so in practice, a relay you wrote yourself. Every
   * hosted provider rejects an unauthenticated request, which made "point
   * MAIL_WEBHOOK_URL at your email provider" quietly untrue.
   */
  if (env.mailWebhookAuth) {
    headers.Authorization = env.mailWebhookAuth;
  }

  const response = await fetch(env.mailWebhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ to, subject, text, from: env.mailFrom }),
    // Bounded, because this runs inside a request the user is waiting on.
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    /*
     * The body is read and included because the status alone is rarely enough
     * to act on — a 422 from a mail provider is usually "that From address is
     * not a verified sender", which is a five-minute fix if you can see it and
     * an afternoon if all you have is the number.
     *
     * Truncated: an error path is not the place to put an unbounded response
     * into the log. Read failures are swallowed for the same reason — the
     * status is the finding, and losing it to a secondary error would be a bad
     * trade.
     */
    const detail = await response
      .text()
      .then((body) => body.trim().slice(0, 500))
      .catch(() => '');

    throw new Error(
      `webhook responded ${response.status}${detail ? ` — ${detail}` : ''}`
    );
  }

  return { delivered: true, transport: 'webhook' };
}

module.exports = { sendMail };
