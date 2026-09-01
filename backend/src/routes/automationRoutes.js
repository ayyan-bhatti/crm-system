const express = require('express');
const { protect } = require('../middleware/auth');
const { requireRole } = require('../middleware/roles');
const { ROLES } = require('../config/constants');
const {
  listAutomationLog,
  getSettings,
  updateSettings,
  runNow,
} = require('../controllers/automationController');

const router = express.Router();

router.use(protect);

/**
 * READING is open to any staff member; CHANGING is admin only.
 *
 * The split matters. "Is the reorder reminder still running" is a question a
 * manager should be able to answer without an administrator, because the
 * failure mode of a stopped automation is total silence — nobody notices for
 * months, and the more people who can see the last-run date, the shorter that
 * is. Deciding that it should run five days after delivery rather than three
 * is a policy decision, and the round's RBAC table puts that with the admin.
 */
router.get('/log', listAutomationLog);
router.get('/settings', getSettings);

router.patch('/settings', requireRole(ROLES.ADMIN), updateSettings);

/**
 * The manual trigger.
 *
 * Admin only, and safe to press twice — the jobs claim each order with a
 * conditional update before sending anything, so a second run finds nothing
 * left to claim. That property is what makes this endpoint safe to exist;
 * without it, a "run now" button would be a button that mails people again.
 */
router.post('/run', requireRole(ROLES.ADMIN), runNow);

module.exports = router;
