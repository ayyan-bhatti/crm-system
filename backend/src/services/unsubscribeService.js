const crypto = require('crypto');
const env = require('../config/env');
const Customer = require('../models/Customer');
const Buyer = require('../models/Buyer');
const { CONTACT_CHANNEL_VALUES } = require('../config/marketing');
const { applyConsent } = require('../models/marketingConsent');
const { componentLogger } = require('../config/logger');

const log = componentLogger('unsubscribe');

/**
 * The unsubscribe link in a marketing email, and what happens when it is
 * clicked.
 *
 * THE LINK GENUINELY WORKS. That is the whole point of this file, and it is
 * stated because a decorative unsubscribe link is a common and serious lie: it
 * looks like compliance, satisfies a reviewer glancing at a rendered email,
 * and does nothing. Clicking the link produced here flips the opt-in off, in
 * the database, on every record belonging to that person, before the page it
 * lands on renders.
 *
 * WHY THE TOKEN IS SIGNED RATHER THAN STORED
 *
 * The obvious design is a random token per recipient, stored, looked up on
 * click. It works, and it costs a row per recipient per campaign that exists
 * only to be clicked by the two per cent who unsubscribe — plus a decision
 * about when to expire them, and a bug the day one expires while a message is
 * still in somebody's inbox.
 *
 * An HMAC over (email, channel) needs no storage, never expires, and cannot be
 * forged without the server's secret. Unsubscribe links SHOULD be effectively
 * permanent: people act on emails months old, and the worst outcome of an old
 * link working is that somebody who wanted to leave a list leaves it.
 *
 * WHY IT IS KEYED ON EMAIL RATHER THAN A RECORD ID
 *
 * A contact is a merged view of up to two records — a `Customer` and a `Buyer`
 * — and email is the key they are merged on. Keyed on one record's id, the
 * unsubscribe would turn off consent on that record and leave the other one
 * saying yes, so the next campaign would find a consented record for the same
 * human and mail them again. Unsubscribing has to mean "this person", and the
 * only identifier this system has for a person is their email address.
 *
 * WHY THE LINK IS NOT AUTHENTICATED
 *
 * Requiring a login to unsubscribe is a dark pattern and, for a guest contact
 * who has no account at all, an impossibility. The token IS the authorisation:
 * holding it proves you received the message. The exposure is that somebody
 * who intercepts a marketing email could unsubscribe its recipient — which is
 * a nuisance, is reversible by ticking the box again, and is a far smaller
 * harm than making it hard to stop unwanted mail.
 */

/**
 * Sign an unsubscribe token for one person and one channel.
 *
 * Channel-specific, because consent is: unsubscribing from email must not
 * silently withdraw a consent for SMS the person deliberately gave. The
 * channel is inside the signature, so it cannot be swapped in the URL.
 */
function signToken(email, channel) {
  const normalised = String(email).toLowerCase().trim();
  const payload = `${normalised}:${channel}`;

  const signature = crypto
    .createHmac('sha256', env.jwtSecret)
    .update(payload)
    .digest('base64url');

  return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

/**
 * Verify a token and return what it authorises.
 *
 * Returns null for anything that does not verify — a tampered payload, an
 * unknown channel, a truncated token. Fails closed and says nothing about
 * WHICH part was wrong, because the caller renders the result to whoever
 * followed the link and a precise error is a probing oracle.
 *
 * @returns {{ email: string, channel: string }|null}
 */
function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;

  let payload;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = crypto
    .createHmac('sha256', env.jwtSecret)
    .update(payload)
    .digest('base64url');

  /*
   * Constant-time comparison. The strings are the same length whenever both
   * are real HMACs, but a forged token can be any length at all, and
   * `timingSafeEqual` throws on a length mismatch rather than returning false
   * — so the length is checked first and a mismatch is simply a rejection.
   */
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const separator = payload.lastIndexOf(':');
  if (separator === -1) return null;

  const email = payload.slice(0, separator);
  const channel = payload.slice(separator + 1);

  if (!email || !CONTACT_CHANNEL_VALUES.includes(channel)) return null;

  return { email, channel };
}

/** The full link that goes in a message footer. */
function unsubscribeUrl(email, channel) {
  return `${env.appUrl}/unsubscribe?token=${encodeURIComponent(signToken(email, channel))}`;
}

/**
 * Turn a consent off, everywhere that person exists.
 *
 * BOTH RECORDS, ALWAYS, and this is the half that a per-record implementation
 * gets wrong. A person who is a CRM customer and a storefront buyer has two
 * documents carrying their consent; withdrawing it on one leaves the other
 * saying yes, and the merged contact would still resolve as consented — so the
 * unsubscribe would appear to work and the next campaign would reach them
 * anyway. That is the exact failure the definition of done asks to be proven
 * against, so it is done here in one place and tested directly.
 *
 * Idempotent: unsubscribing twice is a no-op the second time, which matters
 * because mail clients pre-fetch links and a person may well click it again.
 *
 * @returns {Promise<{ ok: boolean, changed: boolean, channel: string }>}
 */
async function unsubscribe(token) {
  const verified = verifyToken(token);
  if (!verified) return { ok: false, changed: false, channel: '' };

  const { email, channel } = verified;
  const at = new Date();
  let changed = false;

  const [customers, buyers] = await Promise.all([
    Customer.find({ email }),
    Buyer.find({ email }),
  ]);

  for (const doc of [...customers, ...buyers]) {
    const touched = applyConsent(doc, { [channel]: false }, at);
    if (touched.length) {
      await doc.save();
      changed = true;
    }
  }

  log.info(
    { channel, records: customers.length + buyers.length, changed },
    'unsubscribe processed'
  );

  /*
   * `ok` is true even when nothing changed, and the distinction is deliberate.
   * A valid token for somebody who has already unsubscribed is a SUCCESS from
   * their point of view — they are off the list, which is what they asked for.
   * Reporting "failed" because there was nothing left to do would send someone
   * who is already unsubscribed looking for a way to unsubscribe.
   */
  return { ok: true, changed, channel };
}

/**
 * Set consent on every record for one email address.
 *
 * The write half of the same rule the merge reads: consent belongs to a
 * person, so it is written to every record that person has. Used by the staff
 * contact screen and by the buyer's own preferences, so that neither can
 * create the split-brain state `contactService` would then have to reconcile.
 *
 * @param {string} email
 * @param {object} changes partial map, e.g. `{ email: true, sms: false }`
 * @returns {Promise<string[]>} the channels that actually changed
 */
async function setConsentEverywhere(email, changes, at = new Date()) {
  const normalised = String(email).toLowerCase().trim();

  const [customers, buyers] = await Promise.all([
    Customer.find({ email: normalised }),
    Buyer.find({ email: normalised }),
  ]);

  const changed = new Set();

  for (const doc of [...customers, ...buyers]) {
    const touched = applyConsent(doc, changes, at);
    if (touched.length) {
      await doc.save();
      touched.forEach((channel) => changed.add(channel));
    }
  }

  return [...changed];
}

module.exports = {
  signToken,
  verifyToken,
  unsubscribeUrl,
  unsubscribe,
  setConsentEverywhere,
};
