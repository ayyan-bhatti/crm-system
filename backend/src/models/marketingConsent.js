const mongoose = require('mongoose');
const { CONTACT_CHANNEL_VALUES } = require('../config/marketing');

/**
 * Channel-by-channel marketing consent, defined ONCE and embedded in both
 * `Customer` and `Buyer`.
 *
 * WHY ONE DEFINITION RATHER THAN THE SAME FIELDS TWICE
 *
 * The two models describe the same human being from different directions — a
 * CRM record and a storefront account — and a person's consent must mean
 * exactly the same thing on both. Written out twice, the two copies drift: one
 * gains a default, the other does not, and the day they disagree is the day
 * somebody gets an email they refused. Defining the shape here makes that
 * impossible rather than merely unlikely.
 *
 * WHY IT IS KEYED BY CHANNEL RATHER THAN FLAT `emailOptIn` / `smsOptIn`
 *
 * Every consent check in this app asks the same question — "has this person
 * agreed to THIS channel" — with the channel arriving as a variable from a
 * campaign, a route parameter or a job. Flat fields force that into a built
 * string (`contact[`${channel}OptIn`]`), and a built field name is precisely
 * how a typo turns into `undefined`, which is falsy, which quietly means "not
 * consented"... until the day somebody writes the check the other way round
 * and `undefined` means "no record of refusal". Keyed access has no such
 * failure mode: an unknown channel is a missing sub-document, and the gate
 * validates the channel against the enum before it ever gets here.
 *
 * WHY EVERY DEFAULT IS `false`
 *
 * Consent is given, never assumed. A record created by any path at all — a rep
 * typing a customer in, a storefront registration, `matchOrCreateCustomer`
 * upserting from a checkout — starts with all three channels off. There is no
 * code path that can create a contact who is opted in by default, because the
 * schema itself refuses to express one.
 *
 * WHY THE TIMESTAMP IS NOT DECORATION
 *
 * "When did they agree" is the question asked when a complaint arrives, and a
 * boolean cannot answer it. `optInAt` is set when consent is GIVEN and left
 * alone when it is withdrawn — see `applyConsent` for why the withdrawal
 * timestamp is a separate field rather than an overwrite.
 */
const channelConsentSchema = new mongoose.Schema(
  {
    optIn: {
      type: Boolean,
      default: false,
    },
    /** When they said yes. Null if they never have. */
    optInAt: {
      type: Date,
      default: null,
    },
    /**
     * When they last said no, if they ever did.
     *
     * A SEPARATE FIELD RATHER THAN CLEARING `optInAt`, because the two answer
     * different questions and both get asked. "Did they ever consent, and
     * when" survives an unsubscribe — which is exactly what you need when
     * somebody claims they never signed up — while "when did they withdraw"
     * is what proves the unsubscribe link worked and how quickly.
     */
    optOutAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

/**
 * The embeddable consent block.
 *
 * Returned from a factory rather than shared as a single schema instance
 * because Mongoose mutates a schema when it is compiled into a parent, and the
 * same instance embedded in two models is a genuine source of cross-talk.
 * Building a fresh one per caller costs nothing and removes the question.
 */
function marketingConsentField() {
  return {
    type: new mongoose.Schema(
      {
        email: { type: channelConsentSchema, default: () => ({}) },
        sms: { type: channelConsentSchema, default: () => ({}) },
        whatsapp: { type: channelConsentSchema, default: () => ({}) },
      },
      { _id: false }
    ),
    default: () => ({}),
  };
}

/**
 * Has this contact agreed to be messaged on this channel?
 *
 * THE ONLY CORRECT WAY TO ASK. Every send path in the app routes through this
 * — the campaign dispatcher, the individual send, both post-sale jobs — so
 * there is exactly one expression of the rule to get right, and a test that
 * pins it pins all of them.
 *
 * Fails CLOSED in every ambiguous case: no document, no consent block, an
 * unrecognised channel, a channel sub-document that was never created. All of
 * those return false. The alternative — treating a missing record as "no
 * evidence they objected" — is how an opt-out list becomes a mailing list.
 *
 * @param {object|null} doc a Customer or Buyer document (or a plain object)
 * @param {string} channel one of CONTACT_CHANNEL_VALUES
 */
function hasConsent(doc, channel) {
  if (!doc) return false;
  if (!CONTACT_CHANNEL_VALUES.includes(channel)) return false;

  return Boolean(doc.marketing?.[channel]?.optIn);
}

/**
 * Apply a set of consent changes, stamping the right timestamps.
 *
 * Takes a partial map (`{ email: true, whatsapp: false }`) so a form can send
 * only the boxes it actually renders — a checkout that offers email and SMS
 * must not silently withdraw a WhatsApp consent it never showed. An absent
 * channel is LEFT ALONE, which is the difference between "they did not tick
 * it" and "they were never asked".
 *
 * ONLY TRANSITIONS ARE STAMPED. Re-submitting a form with email already ticked
 * does not move `optInAt` forward — the date consent was given is the date it
 * was given, and refreshing it on every save would erase the only evidence of
 * when the relationship actually started.
 *
 * Mutates and returns the document; the caller saves it. Returns the list of
 * channels that actually changed, which is what the audit note reports.
 *
 * @returns {string[]} channels whose value changed
 */
function applyConsent(doc, changes = {}, at = new Date()) {
  if (!doc || !changes || typeof changes !== 'object') return [];

  if (!doc.marketing) doc.marketing = {};

  const changed = [];

  for (const channel of CONTACT_CHANNEL_VALUES) {
    if (!(channel in changes)) continue;

    const wanted = Boolean(changes[channel]);

    if (!doc.marketing[channel]) doc.marketing[channel] = {};
    const current = Boolean(doc.marketing[channel].optIn);

    if (current === wanted) continue;

    doc.marketing[channel].optIn = wanted;
    if (wanted) {
      doc.marketing[channel].optInAt = at;
    } else {
      doc.marketing[channel].optOutAt = at;
    }

    changed.push(channel);
  }

  /*
   * Mongoose does not always notice a mutation inside a nested sub-document
   * reached by bracket access, so the path is marked explicitly. Without this
   * an unsubscribe can appear to work — the in-memory object is correct — and
   * silently not persist, which is the worst possible version of this bug.
   */
  if (changed.length && typeof doc.markModified === 'function') {
    doc.markModified('marketing');
  }

  return changed;
}

/**
 * Read consent out as the flat booleans the API and the spreadsheet speak.
 *
 * The stored shape is keyed by channel because that is what the code needs;
 * a UI checkbox and a spreadsheet column want `emailOptIn`. Converting in one
 * named place beats every caller reaching into the sub-document.
 */
function consentSummary(doc) {
  const summary = {};

  for (const channel of CONTACT_CHANNEL_VALUES) {
    const block = doc?.marketing?.[channel];
    summary[channel] = {
      optIn: Boolean(block?.optIn),
      optInAt: block?.optInAt || null,
      optOutAt: block?.optOutAt || null,
    };
  }

  return summary;
}

/**
 * Parse the consent map out of a request body.
 *
 * Accepts the flat names a form posts (`emailOptIn`, `smsOptIn`,
 * `whatsappOptIn`) and returns the channel-keyed partial `applyConsent` wants.
 * A field that is absent stays absent — see `applyConsent` on why "not ticked"
 * and "not asked" must not collapse into each other.
 *
 * ONLY A LITERAL `true` COUNTS AS CONSENT. Not "true", not 1, not "on". A
 * checkbox that arrives as the string "false" is truthy in JavaScript, and
 * that single coercion would opt in everybody who left the box alone on a form
 * that posts its default. Consent is the one place to be pedantic about types.
 */
function consentFromBody(body = {}) {
  const changes = {};

  for (const channel of CONTACT_CHANNEL_VALUES) {
    const key = `${channel}OptIn`;
    if (!(key in body)) continue;
    changes[channel] = body[key] === true;
  }

  return changes;
}

module.exports = {
  marketingConsentField,
  channelConsentSchema,
  hasConsent,
  applyConsent,
  consentSummary,
  consentFromBody,
};
