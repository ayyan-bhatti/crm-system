const asyncHandler = require('../utils/asyncHandler');
const {
  PAYMENT_METHOD,
  DELIVERY_OPTIONS,
  estimatedDeliveryFor,
} = require('../config/constants');
const {
  CONTACT_CHANNEL_VALUES,
  CONTACT_CHANNEL_LABELS,
} = require('../config/marketing');
const stripeService = require('../services/stripeService');

/**
 * What each opt-in box promises, in the shopper's words rather than ours.
 *
 * Wording matters legally as well as commercially: a box saying "marketing"
 * with no indication of what arrives or how often is the kind of consent that
 * does not survive being questioned. Each line says what the channel is for
 * and, implicitly, that it is optional.
 */
/**
 * The consent boxes say MARKETING, not just the channel name.
 *
 * The storefront registration form has an "Email" field on it, so a checkbox
 * also labelled "Email" is ambiguous — to a screen reader reading them in
 * sequence, and to anyone glancing at the form and reading it as "is this
 * address right". Naming what they are agreeing to RECEIVE is also the more
 * honest label: "Email" describes a channel, "Marketing emails" describes the
 * thing being consented to.
 */
const MARKETING_LABELS = {
  email: 'Marketing emails',
  sms: 'Marketing text messages',
  whatsapp: 'Marketing WhatsApp messages',
};

const MARKETING_HINTS = {
  email: 'Occasional emails about new products and offers. Unsubscribe any time.',
  sms: 'Text messages about orders you might want to repeat. Reply STOP to end them.',
  whatsapp: 'WhatsApp messages about new products. You can opt out whenever you like.',
};

/**
 * GET /api/shop/config
 *
 * What the storefront needs to know about this deployment before it can draw a
 * correct checkout page. Public, cheap, and free of anything an anonymous
 * caller should not have.
 *
 * WHY THIS EXISTS AT ALL — a bug worth recording rather than quietly fixing.
 *
 * `config/env.js` states, in a comment, that "a shop that OFFERS a card button
 * leading nowhere is worse than both, so the button is gated on this rather
 * than shown optimistically". That was true of the API and false of the UI:
 * nothing in the frontend ever asked whether Stripe was configured, so the
 * checkout page offered "Pay by card" — as the DEFAULT, pre-selected option —
 * and only found out it was dead when the buyer filled the form in, chose an
 * address, pressed Pay, and got a red banner telling them to pick something
 * else. The one screen where a shop must not look broken is the one where
 * somebody is trying to give it money.
 *
 * A capability the server owns has to be published by the server. Deriving it
 * on the client from anything else — the presence of a publishable key, a build
 * flag — reintroduces the same class of drift in a quieter form.
 */
const getStorefrontConfig = asyncHandler(async (req, res) => {
  const card = stripeService.isEnabled();

  res.json({
    success: true,
    data: {
      /*
       * Ordered as the checkout should present them, so the UI does not encode
       * a second opinion about which method leads. `available: false` is sent
       * rather than the method being omitted, because "we take cards, just not
       * right now" and "we never take cards" deserve different words on screen
       * and the client cannot tell them apart from an absence.
       */
      paymentMethods: [
        {
          value: PAYMENT_METHOD.CARD,
          label: 'Pay by card',
          hint: 'Secure payment through Stripe. You will be redirected.',
          available: card,
          unavailableReason: card
            ? null
            : 'Card payment is not set up on this store yet.',
        },
        {
          value: PAYMENT_METHOD.COD,
          label: 'Cash on delivery',
          hint: 'Pay the courier when your order arrives.',
          available: true,
          unavailableReason: null,
        },
        {
          value: PAYMENT_METHOD.BANK_TRANSFER,
          label: 'Bank transfer',
          hint: 'We will send account details with your confirmation.',
          available: true,
          unavailableReason: null,
        },
      ],

      /*
       * How fast the shop can get it there, published for the same reason the
       * payment methods are: the checkout has to draw a real choice with a real
       * date on it, and both the wording and the day count are the server's to
       * decide. A hard-coded "3–5 days" in the frontend is a promise the
       * backend has no idea it is making.
       */
      deliveryOptions: DELIVERY_OPTIONS.map((option) => ({
        ...option,
        // The actual date each choice would produce, resolved now, so the
        // shopper compares dates rather than doing arithmetic on "days".
        estimatedDate: estimatedDeliveryFor(option.value),
      })),

      /*
       * The marketing opt-in boxes, published rather than hard-coded in the
       * storefront — same reasoning as everything else on this endpoint.
       *
       * THREE SEPARATE CHECKBOXES, NEVER ONE. Somebody may want email and not
       * WhatsApp, and bundling them means the only way to stop the WhatsApp
       * messages is to stop the emails too. That is a product decision the
       * server owns, and publishing the list is what stops a future form
       * quietly rendering a single "yes to marketing" box.
       *
       * `defaultChecked` is absent on purpose and is not an oversight: there
       * is no shape of this response that can pre-tick a box. A pre-ticked
       * consent checkbox is not consent, and the way to guarantee the client
       * never renders one is to give it nothing to render one from.
       */
      marketingChannels: CONTACT_CHANNEL_VALUES.map((value) => ({
        value,
        label: MARKETING_LABELS[value] || CONTACT_CHANNEL_LABELS[value],
        hint: MARKETING_HINTS[value],
      })),
    },
  });
});

module.exports = { getStorefrontConfig };
