const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { unsubscribe, verifyToken } = require('../services/unsubscribeService');
const { newsletterLimiter } = require('../middleware/rateLimit');
const { CONTACT_CHANNEL_LABELS } = require('../config/marketing');

const router = express.Router();

/**
 * Unsubscribing. PUBLIC, and it has to be.
 *
 * Requiring a login to stop receiving marketing is a dark pattern, and for a
 * guest contact — somebody who checked out before accounts were mandatory and
 * has no account at all — it is not a pattern, it is an impossibility. The
 * signed token IS the authorisation: holding it proves you received the
 * message it came in. See services/unsubscribeService.js.
 *
 * WHY CSRF DOES NOT APPLY HERE
 *
 * CSRF is an attack on AMBIENT authority — a cookie the browser attaches
 * automatically, which an attacker's page can therefore ride. This endpoint
 * has none: it is authorised entirely by a token in the request that an
 * attacker would have to already possess, and if they possess it they have
 * the victim's email and do not need the victim's browser. The router is
 * excluded from the staff CSRF pair in app.js for that reason, and so that a
 * staff member who happens to be signed in can still click their own
 * unsubscribe link.
 *
 * Rate limited, because it is an unauthenticated POST that writes. The limiter
 * is the newsletter one — same shape of endpoint, same reasoning, no need for
 * a fourth bucket.
 */

/**
 * GET /api/unsubscribe/:token
 *
 * What this token would do, WITHOUT doing it. The landing page reads this
 * first so it can say "unsubscribe from marketing emails?" rather than a bare
 * confirmation for something the reader has to guess at.
 *
 * Safe for a mail client to prefetch, which is exactly why the actual change
 * is a POST — several mail clients and security scanners fetch every link in a
 * message before a human sees it, and an unsubscribe that happened on GET
 * would be an unsubscribe nobody asked for.
 */
router.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const verified = verifyToken(req.params.token);

    res.json({
      success: true,
      data: {
        valid: Boolean(verified),
        channel: verified?.channel || '',
        channelLabel: verified ? CONTACT_CHANNEL_LABELS[verified.channel] : '',
      },
    });
  })
);

/**
 * POST /api/unsubscribe — body: { token }
 *
 * Does it. Idempotent: a second click reports success and changes nothing.
 *
 * `changed: false` with `ok: true` is a real and useful pair — it is somebody
 * who had already unsubscribed, and telling them it FAILED would send a person
 * who is already off the list looking for a way to get off the list.
 */
router.post(
  '/',
  newsletterLimiter,
  asyncHandler(async (req, res) => {
    const result = await unsubscribe(req.body.token);

    if (!result.ok) {
      /*
       * 200 with `success: false`, not a 400.
       *
       * The person reading this followed a link from an email; whether the
       * token was mangled by their mail client or is simply not one of ours,
       * what they need is a page telling them what to do next. An HTTP error
       * would render as a generic failure in the client's error handling and
       * lose that. The distinction is for the recipient's benefit, not the
       * caller's.
       */
      return res.json({
        success: false,
        message:
          'That unsubscribe link is not valid. It may have been broken up by your email ' +
          'program — try copying the whole link into your browser, or reply to the ' +
          'message and we will take you off the list.',
      });
    }

    return res.json({
      success: true,
      changed: result.changed,
      channel: result.channel,
      message: result.changed
        ? `You have been unsubscribed from marketing ${
            CONTACT_CHANNEL_LABELS[result.channel] || result.channel
          } messages.`
        : 'You were already unsubscribed. Nothing further to do.',
    });
  })
);

module.exports = router;
