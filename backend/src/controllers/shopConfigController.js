const asyncHandler = require('../utils/asyncHandler');
const { PAYMENT_METHOD } = require('../config/constants');
const stripeService = require('../services/stripeService');

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
    },
  });
});

module.exports = { getStorefrontConfig };
