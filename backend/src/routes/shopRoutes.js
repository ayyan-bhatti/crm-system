const express = require('express');
const { issueShopCsrfToken, verifyShopCsrf } = require('../middleware/shopCsrf');
const shopAuthRoutes = require('./shopAuthRoutes');

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

router.use('/auth', shopAuthRoutes);

module.exports = router;
