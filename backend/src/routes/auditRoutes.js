const express = require('express');
const {
  listAuditLogs,
  getAuditLog,
  getAuditDigest,
} = require('../controllers/auditController');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { aiSearchLimiter, aiPerUserLimiter } = require('../middleware/rateLimit');
const { ROLES } = require('../config/constants');

const router = express.Router();

/*
 * Admin only, for the whole router.
 *
 * Applied with router.use rather than per route so a handler added later is
 * protected by default — an audit endpoint that someone forgot to guard would
 * expose a copy of every field of every record in the system, bypassing every
 * other permission rule. See the note in the controller.
 *
 * There are no write routes here, and that is deliberate: an audit trail that
 * can be edited or deleted through the API is not evidence of anything.
 */
router.use(protect, requireRole(ROLES.ADMIN));

router.get('/', listAuditLogs);
// Before `/:id`, or "digest" is parsed as an id. Rate-limited like every
// other endpoint that makes a paid model call.
router.get('/digest', aiSearchLimiter, aiPerUserLimiter, getAuditDigest);
router.get('/:id', getAuditLog);

module.exports = router;
