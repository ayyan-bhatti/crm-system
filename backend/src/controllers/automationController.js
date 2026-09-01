const OutboundMessage = require('../models/OutboundMessage');
const AutomationSettings = require('../models/AutomationSettings');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const postSaleService = require('../services/postSaleService');
const { recordAudit } = require('../services/auditService');
const { isAdmin } = require('../middleware/roles');
const {
  OUTBOUND_KIND,
  OUTBOUND_KIND_VALUES,
  REVIEW_REQUEST_DELAY_MIN,
  REVIEW_REQUEST_DELAY_MAX,
} = require('../config/marketing');

/**
 * The automation log and its settings.
 *
 * WHY THE LOG IS A SCREEN RATHER THAN A LOG FILE
 *
 * The brief asks that "did the reorder reminder actually go out this week"
 * have a real answer, and the reason that is worth a screen is specific to
 * automations: a scheduled job that stops running produces NO SIGNAL AT ALL.
 * A broken button gets reported within a day. A cron that silently stopped
 * firing in March is discovered in June, by somebody wondering why nobody
 * reviews anything any more.
 *
 * So the outbound rows the jobs write are exposed, filtered by kind, with the
 * last run's date at the top. An empty list with a stale date is the visible
 * version of the failure that otherwise has no symptom.
 */

/**
 * GET /api/automation/log?kind=review_request
 *
 * Visible to any signed-in staff member, deliberately. It is a record of
 * messages the BUSINESS sent, not of anyone's private data — the rows carry a
 * name, an address and an outcome, which is what an order already shows a rep
 * — and the value of "is the automation running" collapses if only
 * administrators can check.
 *
 * Configuring it is a different question and is admin-only, below.
 */
const listAutomationLog = asyncHandler(async (req, res) => {
  const query = {};

  if (req.query.kind) {
    if (!OUTBOUND_KIND_VALUES.includes(req.query.kind)) {
      throw ApiError.badRequest(`kind must be one of: ${OUTBOUND_KIND_VALUES.join(', ')}`);
    }
    query.kind = req.query.kind;
  } else {
    /*
     * Unfiltered means THE AUTOMATIONS, not everything. Campaign rows number in
     * the thousands and would bury the handful of automated sends this screen
     * exists to show — and there is a dedicated screen for campaigns.
     */
    query.kind = { $in: [OUTBOUND_KIND.REVIEW_REQUEST, OUTBOUND_KIND.REORDER_REMINDER] };
  }

  const limit = Math.min(Math.max(1, parseInt(req.query.limit, 10) || 100), 500);

  const messages = await OutboundMessage.find(query)
    .populate('order', 'orderNumber')
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit);

  /*
   * The most recent run of each job, which is the number the screen leads
   * with. Derived from the rows rather than stored separately: a "last run"
   * field written by the job would say the job ran even on a run that sent
   * nothing, which is exactly the case where you want to know whether it was
   * "nothing to do" or "nothing happened".
   */
  const lastRuns = {};
  for (const kind of [OUTBOUND_KIND.REVIEW_REQUEST, OUTBOUND_KIND.REORDER_REMINDER]) {
    const latest = await OutboundMessage.findOne({ kind }).sort({ createdAt: -1 }).select('createdAt');
    lastRuns[kind] = latest?.createdAt || null;
  }

  res.json({
    success: true,
    count: messages.length,
    data: messages,
    lastRuns,
    settings: await postSaleService.getSettings(),
    canConfigure: isAdmin(req.user),
  });
});

/** GET /api/automation/settings */
const getSettings = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await postSaleService.getSettings() });
});

/**
 * PATCH /api/automation/settings — admin only.
 *
 * The three things an administrator may change: whether each job runs, and how
 * long after delivery the review request goes. Audited, because turning off an
 * automation is a change somebody will need to account for when the reviews
 * stop arriving.
 */
const updateSettings = asyncHandler(async (req, res) => {
  const settings = await postSaleService.getSettings();
  const before = settings.toObject();

  if (typeof req.body.reviewRequestEnabled === 'boolean') {
    settings.reviewRequestEnabled = req.body.reviewRequestEnabled;
  }

  if (typeof req.body.reorderReminderEnabled === 'boolean') {
    settings.reorderReminderEnabled = req.body.reorderReminderEnabled;
  }

  if (req.body.reviewRequestDelayDays !== undefined) {
    const days = Number(req.body.reviewRequestDelayDays);

    /*
     * Checked here as well as by the schema so the message names the bounds.
     * A Mongoose validation error would reach the client as a 400 either way,
     * but "must be between 1 and 30" is actionable and the schema's phrasing
     * arrives wrapped in a path nobody reading a form cares about.
     */
    if (!Number.isInteger(days) || days < REVIEW_REQUEST_DELAY_MIN || days > REVIEW_REQUEST_DELAY_MAX) {
      throw ApiError.badRequest(
        `reviewRequestDelayDays must be a whole number between ${REVIEW_REQUEST_DELAY_MIN} ` +
          `and ${REVIEW_REQUEST_DELAY_MAX}`
      );
    }

    settings.reviewRequestDelayDays = days;
  }

  settings.updatedBy = req.user._id;
  settings.updatedAt = new Date();
  await settings.save();

  await recordAudit(req, {
    action: 'update',
    entity: 'automation-settings',
    entityId: settings._id,
    label: 'Post-sale automation',
    before,
    after: settings.toObject(),
  });

  res.json({ success: true, data: settings });
});

/**
 * POST /api/automation/run — admin only.
 *
 * Runs both jobs immediately, for testing and for the case where the
 * scheduler has been down. SAFE TO PRESS TWICE: the jobs claim each order
 * with a conditional update before sending, so a second run finds nothing left
 * to claim. That property is the reason this endpoint can exist at all —
 * without it, a manual trigger would be a button that mails people again.
 */
const runNow = asyncHandler(async (req, res) => {
  const result = await postSaleService.runAll();

  await recordAudit(req, {
    action: 'update',
    entity: 'automation-settings',
    entityId: null,
    label: 'Post-sale automation',
    note:
      `Ran manually. Review requests: ${result.reviewRequests.sent} sent. ` +
      `Reorder reminders: ${result.reorderReminders.sent} sent.`,
  });

  res.json({ success: true, data: result });
});

module.exports = { listAutomationLog, getSettings, updateSettings, runNow, AutomationSettings };
