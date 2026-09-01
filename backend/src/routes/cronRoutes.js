const crypto = require('crypto');
const express = require('express');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const postSaleService = require('../services/postSaleService');
const { componentLogger } = require('../config/logger');

const log = componentLogger('cron');

const router = express.Router();

/**
 * The scheduler's way in. Machine-to-machine, no user session.
 *
 * ============================================================================
 * WHY THIS IS NOT BEHIND `protect`
 * ============================================================================
 *
 * A scheduler has no login. Vercel Cron issues a plain HTTP GET from its own
 * infrastructure: no cookie, no CSRF token, nobody to prompt for a password.
 * The three ways to authenticate that are:
 *
 *   a service account   a real `User` row whose password sits in an
 *                       environment variable. It is a shared secret wearing a
 *                       costume, and a worse one — it also appears in the user
 *                       list, can be granted more permissions by accident, and
 *                       shows up as a person in the audit trail.
 *   an IP allow-list    does not work on serverless. The app sees the edge
 *                       network's addresses, not a stable one. Same reason
 *                       `/api/internal` is admin-gated rather than IP-gated.
 *   a shared secret     what this is.
 *
 * ============================================================================
 * IT FAILS CLOSED
 * ============================================================================
 *
 * With `CRON_SECRET` unset, every request here is refused. That is the
 * important half: an automation endpoint reachable without credentials is a
 * URL anyone can use to make the business send real messages to real people,
 * repeatedly. Defaulting to "open when unconfigured" would mean a deployment
 * that forgot one variable has an open trigger and no error to tell it so.
 *
 * The endpoint being unavailable is a visible failure — the automations do not
 * run, the log's last-run date goes stale, and the automation screen shows it.
 * That is the failure worth having.
 */

/**
 * Compare the presented secret in constant time.
 *
 * A naive `!==` leaks the secret's length and, in principle, its prefix
 * through timing. It is a remote comparison over a network, so the signal is
 * buried in noise — but this is three lines, and the alternative is a
 * judgement call about how much noise is enough.
 */
function secretMatches(presented) {
  if (!env.cronSecret || !presented) return false;

  const a = Buffer.from(String(presented));
  const b = Buffer.from(env.cronSecret);

  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Accepts the secret two ways, and both are needed.
 *
 *   x-cron-secret            what a curl, a test or another scheduler sends
 *   authorization: Bearer …  what Vercel Cron sends, using the project's own
 *                            CRON_SECRET, which is not configurable
 *
 * Supporting only the first would mean Vercel's own scheduler — the shape this
 * is built for — could never authenticate.
 */
function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (secretMatches(req.get('x-cron-secret')) || secretMatches(bearer)) return next();

  log.warn(
    { ip: req.ip, configured: Boolean(env.cronSecret) },
    'rejected a scheduled-job request'
  );

  /*
   * 401 with a message that does not distinguish "wrong secret" from "no
   * secret configured on the server". The distinction is useful to an operator
   * and equally useful to somebody probing, and the operator has the logs —
   * where the `configured` flag above says exactly which it was.
   */
  return next(ApiError.unauthorized('Not authorised'));
}

router.use(authenticate);

/**
 * POST /api/cron/post-sale — and GET, because Vercel Cron only issues GETs.
 *
 * Both verbs, same handler. Purists will note that a GET should not have side
 * effects, and they are right in general — this is the case where the platform
 * decides the verb and the alternative is not running the job at all. The
 * endpoint is idempotent in the way that matters (running it twice sends
 * nothing twice), which is the property the rule about GETs is really
 * protecting.
 */
const handler = asyncHandler(async (req, res) => {
  const started = Date.now();
  const result = await postSaleService.runAll();

  log.info({ ...result, ms: Date.now() - started }, 'scheduled post-sale run finished');

  res.json({ success: true, data: result });
});

router.get('/post-sale', handler);
router.post('/post-sale', handler);

module.exports = router;
