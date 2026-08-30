const express = require('express');
const { subscribe } = require('../controllers/shopNewsletterController');
const { newsletterLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/*
 * Public and unauthenticated — a newsletter form that required an account would
 * be pointless, since anyone with an account is already reachable.
 *
 * Rate limited per IP because it is an unauthenticated write to a collection,
 * which is the shape of endpoint that gets filled with a million rows by a
 * script the week after launch. The limit is generous enough that a person
 * correcting a typo three times never notices it.
 */
router.post('/', newsletterLimiter, subscribe);

module.exports = router;
