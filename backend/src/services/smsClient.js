const env = require('../config/env');
const { componentLogger } = require('../config/logger');

const log = componentLogger('sms');

/**
 * Sending an SMS, through whichever transport is configured.
 *
 * DELIBERATELY THE SAME SHAPE AS services/mailer.js, and the sameness is the
 * feature. Three channels that behave identically means one mental model
 * rather than three, one place to learn how a transport is swapped, and no
 * chance of the SMS path quietly acquiring a retry policy that the mail path
 * lacks. Anywhere the two differ below, it is because the medium genuinely
 * differs — not because this was written on a different day.
 *
 *   console  the default. Writes the message to the log. NOT a stub that
 *            silently drops it: the full text is there, so the campaign flow,
 *            the consent gate and the automation jobs are all exercisable end
 *            to end with no account anywhere and no money spent.
 *   twilio   POSTs to Twilio's Messages endpoint with the account SID and auth
 *            token as HTTP Basic credentials. Real sending, one env var away.
 *
 * WHY TWILIO IS SHAPED IN RATHER THAN ABSTRACTED
 *
 * Twilio's send endpoint takes form-encoded `To`/`From`/`Body` and answers
 * JSON — which is not what a generic webhook transport would post, so unlike
 * mail there is no honest "point it at a URL" option. Naming the provider is
 * more truthful than a generic transport that only ever works with one
 * provider's payload. Another provider is one more branch here and nothing
 * else in the codebase.
 *
 * WHAT IT DOES NOT DO
 *
 * No retry, no queue. A failed message returns `{ delivered: false }` and the
 * caller records it — see the outcome column on every `OutboundMessage`. That
 * matches mail, and it matters more here: an SMS costs money per attempt, so
 * an automatic retry is an automatic charge for a message that may have been
 * refused for a permanent reason (an unreachable number is not transient).
 */

const TWILIO_API = 'https://api.twilio.com/2010-04-01';

/** Bounded, because a campaign send waits on each message in its batch. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Is a real transport configured?
 *
 * Reported by `/api/health` alongside the payments block, for exactly the
 * reason that block exists: a channel that looks configured and is not is a
 * campaign that reports success and reaches nobody.
 */
function isConfigured() {
  if (env.smsTransport !== 'twilio') return false;
  return Boolean(env.twilioAccountSid && env.twilioAuthToken && env.twilioFrom);
}

/** Which transport a send would actually use right now. */
function activeTransport() {
  return env.smsTransport === 'twilio' ? 'twilio' : 'console';
}

/**
 * Deliver one SMS.
 *
 * Never throws — same contract as `mailer.sendMail`, and for the same reason:
 * one unreachable recipient in a batch of two hundred must not abort the other
 * hundred and ninety-nine, and a failed send is data the caller records rather
 * than an exception it has to catch.
 *
 * @param {{ to: string, text: string }} message
 * @returns {Promise<{ delivered: boolean, transport: string, error?: string }>}
 */
async function sendSms({ to, text }) {
  const transport = activeTransport();

  if (!to) {
    // A contact with no phone number is a completely ordinary thing to find in
    // a CRM, and it is not an error in the send — it is a fact about the
    // contact. Reported as a failed delivery with a reason a human can act on.
    return { delivered: false, transport, error: 'no phone number on this contact' };
  }

  try {
    if (transport === 'twilio') {
      return await sendViaTwilio({ to, text });
    }

    return sendViaConsole({ to, text });
  } catch (err) {
    log.error({ err, transport }, 'sms delivery failed');
    return { delivered: false, transport, error: err.message };
  }
}

function sendViaConsole({ to, text }) {
  if (env.isProduction) {
    log.warn(
      'SMS_TRANSPORT is not configured, so this message was only written to the log and ' +
        'no SMS was sent. Set SMS_TRANSPORT=twilio with TWILIO_ACCOUNT_SID, ' +
        'TWILIO_AUTH_TOKEN and TWILIO_FROM to deliver it.'
    );
  }

  log.info({ to, body: text }, 'sms (console transport)');

  return { delivered: true, transport: 'console' };
}

async function sendViaTwilio({ to, text }) {
  if (!isConfigured()) {
    throw new Error(
      'SMS_TRANSPORT=twilio but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_FROM is not set'
    );
  }

  /*
   * Form-encoded, not JSON. Twilio's REST API predates the convention and
   * still requires `application/x-www-form-urlencoded`; posting JSON gets a
   * 400 whose message does not mention the content type.
   */
  const body = new URLSearchParams({ To: to, From: env.twilioFrom, Body: text });

  const credentials = Buffer.from(
    `${env.twilioAccountSid}:${env.twilioAuthToken}`
  ).toString('base64');

  const response = await fetch(
    `${TWILIO_API}/Accounts/${encodeURIComponent(env.twilioAccountSid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${credentials}`,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    /*
     * Twilio's error body carries a `message` and a `code` that name the real
     * problem — an unverified sending number, a number that is not SMS-capable,
     * a region the account is not enabled for. The status alone is 400 for all
     * of them, and the difference between them is an afternoon.
     */
    const detail = await response
      .text()
      .then((raw) => raw.trim().slice(0, 300))
      .catch(() => '');

    throw new Error(`twilio responded ${response.status}${detail ? ` — ${detail}` : ''}`);
  }

  return { delivered: true, transport: 'twilio' };
}

module.exports = { sendSms, isConfigured, activeTransport };
