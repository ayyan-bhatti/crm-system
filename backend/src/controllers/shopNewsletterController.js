const NewsletterSignup = require('../models/NewsletterSignup');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { componentLogger } = require('../config/logger');

const log = componentLogger('newsletter');

/**
 * POST /api/shop/newsletter — public.
 *
 * Stores an email address from the storefront footer. It does NOT subscribe
 * anyone to anything: no provider is connected, nothing is sent, and no
 * confirmation is requested. That was the brief's explicit scope, and it is
 * repeated here so the limit is discoverable from the code rather than from
 * waiting for an email that never comes. See models/NewsletterSignup.js for
 * what would have to be added alongside a real provider (double opt-in).
 *
 * A REPEAT SIGN-UP IS A SUCCESS, NOT A CONFLICT.
 *
 * Someone typing their address twice has done nothing wrong and should not be
 * told they have. `upsert` makes the second submission a no-op that answers
 * exactly like the first — which also means the response leaks nothing about
 * whether an address was already on the list, and a rejected duplicate would
 * have turned this into a membership oracle for any address an attacker cares
 * to try.
 */
const subscribe = asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!email) {
    throw ApiError.badRequest('Enter an email address');
  }

  // Shape-checked here as well as on the schema so the message is about the
  // field the person just typed rather than a Mongoose validation string.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw ApiError.badRequest('That does not look like an email address');
  }

  await NewsletterSignup.updateOne(
    { email },
    { $setOnInsert: { email, source: 'footer', createdAt: new Date() } },
    { upsert: true }
  );

  log.info({ email }, 'newsletter address captured');

  res.status(201).json({
    success: true,
    message: 'Thanks — we have your address.',
  });
});

module.exports = { subscribe };
