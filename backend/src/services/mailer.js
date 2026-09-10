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
 *   brevo     POSTs to Brevo's transactional endpoint with BREVO_API_KEY. Real
 *             sending on a free tier that does not expire, which is why it is
 *             named here rather than left to the webhook transport.
 *   webhook   POSTs { from, to, subject, text } to MAIL_WEBHOOK_URL, with
 *             MAIL_WEBHOOK_AUTH as the Authorization header. Enough to connect
 *             a provider or a queue without this project depending on one.
 *
 * WHY BREVO IS SHAPED IN RATHER THAN POINTED AT
 *
 * The webhook transport's body is Resend's shape, and the note below says a
 * provider whose payload differs "needs a small relay, or one more branch
 * here". Brevo is that case twice over: it authenticates with an `api-key`
 * header rather than `Authorization`, and it wants a nested
 * `{ sender: { name, email }, to: [{ email }] }` body rather than a flat pair
 * of strings. So MAIL_WEBHOOK_URL=https://api.brevo.com/... cannot be made to
 * work by configuration, and this is the branch, exactly as smsClient.js names
 * Twilio for the same reason.
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

const BREVO_API = 'https://api.brevo.com/v3/smtp/email';

/** Bounded, because a campaign send waits on each message in its batch. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Which transport a send would actually use right now.
 *
 * Mirrors smsClient/whatsappClient, which have had this pair from the start.
 * Mail predates both and had neither, so `channelStatus()` was reading
 * `process.env.MAIL_TRANSPORT` directly to answer the same question.
 */
function activeTransport() {
  const transport = env.mailTransport;
  return transport === 'brevo' || transport === 'webhook' ? transport : 'console';
}

/**
 * Is a real transport configured — meaning a send would actually leave the
 * machine?
 *
 * The credential check is the entire point, and it is why this cannot be
 * `transport !== 'console'`. `MAIL_TRANSPORT=brevo` with no BREVO_API_KEY, or
 * `webhook` with no MAIL_WEBHOOK_URL, is a deployment that reports a live
 * email channel and delivers nothing — the exact "Pay by card, unavailable"
 * failure the campaign builder's own comment sets out to avoid.
 */
function isConfigured() {
  const transport = activeTransport();
  if (transport === 'brevo') return Boolean(env.brevoApiKey);
  if (transport === 'webhook') return Boolean(env.mailWebhookUrl);
  return false;
}

/**
 * Deliver one message.
 *
 * Never throws. A failed send must not fail the request that triggered it —
 * see the note in the password-reset controller about why the response is
 * identical either way.
 *
 * @returns {Promise<{ delivered: boolean, transport: string, error?: string }>}
 */
async function sendMail({ to, subject, text }) {
  const transport = activeTransport();

  try {
    if (transport === 'brevo') {
      return await sendViaBrevo({ to, subject, text });
    }

    if (transport === 'webhook') {
      return await sendViaWebhook({ to, subject, text });
    }

    return sendViaConsole({ to, subject, text });
  } catch (err) {
    log.error({ err, transport }, 'mail delivery failed');
    /*
     * The reason is returned as well as logged, matching sendSms. A campaign
     * records the outcome per recipient, and "failed" without a reason is a
     * row nobody can act on — the reason is usually "sender not verified",
     * which is a two-minute fix once it is visible.
     */
    return { delivered: false, transport, error: err.message };
  }
}

function sendViaConsole({ to, subject, text }) {
  if (env.isProduction) {
    log.warn(
      'MAIL_TRANSPORT is not configured, so this message is only written to the log. In ' +
        'production that means a reset link is sitting in your log output. Set ' +
        'MAIL_TRANSPORT=brevo with BREVO_API_KEY, or MAIL_TRANSPORT=webhook with ' +
        'MAIL_WEBHOOK_URL, to deliver it properly.'
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

/**
 * Split `MAIL_FROM` into the pair Brevo wants.
 *
 * The setting is one RFC 5322 string ("SimpleCRM <no-reply@example.com>")
 * because that is what the webhook transport and every mail header take. Brevo
 * wants the name and the address as separate fields, so this is a translation
 * at the boundary rather than a second setting — two sender settings that
 * could disagree is a worse problem than one parse.
 *
 * A bare address with no display name is valid and stays valid: `name` is
 * omitted and Brevo falls back to the account default.
 */
function parseSender(from) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { email: from.trim() };

  const [, name, email] = match;
  return name ? { name, email } : { email };
}

async function sendViaBrevo({ to, subject, text }) {
  if (!env.brevoApiKey) {
    throw new Error('MAIL_TRANSPORT=brevo but BREVO_API_KEY is not set');
  }

  const response = await fetch(BREVO_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
      // Brevo's own header. NOT `Authorization` — an Authorization header is
      // ignored here and the request comes back 401 without saying why.
      'api-key': env.brevoApiKey,
    },
    body: JSON.stringify({
      sender: parseSender(env.mailFrom),
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    /*
     * Read for the same reason the webhook transport reads it: Brevo answers
     * 400 with a `code` that names the real problem, and the two most common
     * are "sender not verified" and "IP not whitelisted" — both a few minutes
     * to fix when visible and a long afternoon when all you have is the status.
     */
    const detail = await response
      .text()
      .then((raw) => raw.trim().slice(0, 300))
      .catch(() => '');

    throw new Error(`brevo responded ${response.status}${detail ? ` — ${detail}` : ''}`);
  }

  return { delivered: true, transport: 'brevo' };
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

module.exports = { sendMail, isConfigured, activeTransport };
