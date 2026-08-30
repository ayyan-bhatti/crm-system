const express = require('express');
const { checkout, getCheckoutSession } = require('../controllers/shopCheckoutController');
const { reconcileSession } = require('../controllers/stripeWebhookController');
const { protectBuyer } = require('../middleware/buyerAuth');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

/*
 * `protectBuyer`, NOT `attachBuyerIfPresent` — and that swap is the whole of
 * "there is no guest checkout" as far as the server is concerned.
 *
 * The previous version deliberately admitted both a guest and a signed-in
 * buyer, because guest checkout was a feature. It is not any more, and the
 * removal is enforced at the route rather than by a conditional inside the
 * handler: an unauthenticated POST here is a 401 before any controller code
 * runs, so there is no code path to accidentally leave open later. The
 * `attachBuyerIfPresent` middleware has been deleted outright rather than left
 * unused, so nothing can quietly reintroduce the old behaviour by importing it.
 *
 * Browsing, searching and the cart are all still completely open to a visitor
 * with no account — see shopProductRoutes and CartContext. Only buying changed.
 *
 * `idempotency` runs after authentication so a buyer's key is scoped to their
 * own id rather than falling back to their IP.
 */
router.post('/', protectBuyer, idempotency, checkout);

/**
 * What the confirmation page reads after Stripe sends the buyer back.
 *
 * Two endpoints rather than one, because they do different things and only one
 * of them is safe to call repeatedly from a polling loop:
 *
 *   GET  .../session/:id            reports what we already know. Cheap, no
 *                                   outbound network call, poll it freely.
 *   POST .../session/:id/reconcile  asks STRIPE directly, for when the redirect
 *                                   beat the webhook. Costs an API call, so the
 *                                   page uses it once rather than in a loop.
 *
 * The POST is a POST because it can create an order as a side effect (via the
 * same idempotent handler the webhook uses). A GET that changes state is a trap
 * for anything that prefetches links.
 */
router.get('/session/:sessionId', protectBuyer, getCheckoutSession);
router.post('/session/:sessionId/reconcile', protectBuyer, reconcileSession);

module.exports = router;
