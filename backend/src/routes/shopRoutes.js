const express = require('express');
const { issueShopCsrfToken, verifyShopCsrf } = require('../middleware/shopCsrf');
const shopAuthRoutes = require('./shopAuthRoutes');
const shopProductRoutes = require('./shopProductRoutes');
const shopCartRoutes = require('./shopCartRoutes');
const shopCheckoutRoutes = require('./shopCheckoutRoutes');
const shopOrderRoutes = require('./shopOrderRoutes');
const shopNewsletterRoutes = require('./shopNewsletterRoutes');
const { getStorefrontConfig } = require('../controllers/shopConfigController');

/**
 * The storefront's route tree, mounted once at `/api/shop` in app.js.
 *
 * The buyer CSRF pair is applied here, once, rather than on each sub-router —
 * every route under `/api/shop` is either public (a guest browsing, or the
 * buyer login/register endpoints themselves, where `verifyShopCsrf` is a
 * no-op because there is no shop session cookie yet) or buyer-authenticated,
 * and either way it needs the same pair in front of it. Later phases add
 * `router.use('/products', ...)`, `/cart`, `/checkout`, `/orders` alongside
 * `/auth` here, not as separate top-level mounts in app.js — this file is the
 * one place that has to change to add a new piece of the storefront API.
 */
const router = express.Router();

router.use(issueShopCsrfToken);
router.use(verifyShopCsrf);

/*
 * Public and unauthenticated: the storefront reads this before it can draw a
 * correct checkout, so gating it behind a buyer session would mean the page
 * that most needs to be right is the one drawn blind.
 */
router.get('/config', getStorefrontConfig);

router.use('/auth', shopAuthRoutes);
router.use('/products', shopProductRoutes);
router.use('/cart', shopCartRoutes);
router.use('/checkout', shopCheckoutRoutes);
router.use('/orders', shopOrderRoutes);
router.use('/newsletter', shopNewsletterRoutes);

/*
 * NOTE: `/api/shop/stripe/webhook` is NOT mounted here, and cannot be.
 *
 * It needs the raw, unparsed request body to verify Stripe's signature, so it
 * is registered in app.js BEFORE `express.json()` runs. It also has no business
 * behind the buyer CSRF pair applied at the top of this file: Stripe is a
 * server, not a browser, holds no cookie, and could never present a CSRF token.
 * Both constraints point the same way — see the mount and its comment in app.js.
 */

module.exports = router;
