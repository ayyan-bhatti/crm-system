const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const changeRequestService = require('../services/changeRequestService');
const { recordAudit } = require('../services/auditService');
const { isAdmin } = require('../middleware/roles');
const ChangeRequest = require('../models/ChangeRequest');

/**
 * The administrator's approval queue for customer and order changes — and,
 * since the storefront was added, a manager's queue for BUYER-initiated ones
 * specifically. See the long note in `routes/changeRequestRoutes.js` for why
 * the split is per-request rather than a second route tree: a manager may
 * see and decide a buyer's cancellation, never a colleague's customer edit.
 *
 * Separate from the ACCOUNT approvals in userController, deliberately. They
 * look alike and are answered by the same person, but they are different
 * decisions: one is "should this person have access", the other is "should this
 * record change". Merging them into one queue would mean an admin skimming past
 * a customer deletion while looking for a colleague's signup.
 */

/** A manager may only act on a request nobody on staff could have self-approved. */
function assertMayDecide(user, request) {
  if (isAdmin(user)) return;
  if (request.requestedByModel === 'Buyer') return;

  throw ApiError.forbidden(
    'Only an administrator can decide a request made by a colleague.'
  );
}

/**
 * GET /api/change-requests
 *
 * Everything waiting on a decision, oldest first, for an admin. A manager
 * sees the same queue filtered to buyer-initiated requests only — the ones
 * they are actually allowed to act on, so the list is not full of rows a
 * click would only 403 on.
 */
const listChangeRequests = asyncHandler(async (req, res) => {
  const data = await changeRequestService.listPending();
  const visible = isAdmin(req.user)
    ? data
    : data.filter((request) => request.requestedByModel === 'Buyer');

  res.json({ success: true, count: visible.length, data: visible });
});

/**
 * PATCH /api/change-requests/:id/approve
 *
 * Applies the change. The response carries the affected record, so the caller
 * can show what actually happened rather than only that something did.
 */
const approveChangeRequest = asyncHandler(async (req, res) => {
  const pending = await ChangeRequest.findById(req.params.id).select('requestedByModel');
  if (!pending) throw ApiError.notFound('Change request not found');
  assertMayDecide(req.user, pending);

  const { request, result } = await changeRequestService.approve(req.params.id, req.user);

  /*
   * Audited against the ENTITY, not against the request.
   *
   * The trail is read by asking "what happened to this customer" — so an
   * approved change has to appear in that record's history, not in a parallel
   * history of approvals that nobody thinks to look at. The note carries who
   * asked for it, which is the part the diff cannot express.
   */
  await recordAudit(req, {
    action: request.action,
    entity: request.entity,
    entityId: result?._id ?? request.entityId,
    label: request.label,
    after: request.action === 'delete' ? null : result,
    note: `approved a ${request.action} requested by ${
      request.requestedBy?.name || 'a colleague'
    }`,
  });

  res.json({
    success: true,
    message: 'Approved, and the change has been made.',
    data: { request, result },
  });
});

/**
 * PATCH /api/change-requests/:id/reject
 *
 * Body: { "note": "why" } — optional.
 *
 * Nothing is undone, because nothing was ever applied. That is the whole reason
 * the change is stored rather than written and reverted.
 */
const rejectChangeRequest = asyncHandler(async (req, res) => {
  const pending = await ChangeRequest.findById(req.params.id).select('requestedByModel');
  if (!pending) throw ApiError.notFound('Change request not found');
  assertMayDecide(req.user, pending);

  const request = await changeRequestService.reject(req.params.id, req.user, req.body?.note);

  /*
   * A rejection is audited too. "What did we decide not to do" is a question an
   * audit of an internal system gets asked, and a trail that only records the
   * approvals answers it with silence.
   */
  await recordAudit(req, {
    action: 'update',
    entity: request.entity,
    entityId: request.entityId,
    label: request.label,
    note: `rejected a ${request.action}${request.reviewNote ? `: ${request.reviewNote}` : ''}`,
  });

  res.json({ success: true, message: 'Rejected. Nothing was changed.', data: request });
});

/**
 * GET /api/change-requests/:id/summary
 *
 * A plain-English sentence for a pending request's field-level diff, so an
 * admin (or a manager deciding a buyer's request) is not parsing raw
 * before/after JSON to decide. Same visibility rule as approve/reject:
 * `assertMayDecide` refuses a manager trying to preview a colleague's
 * staff-initiated request, exactly as deciding it is refused.
 *
 * See services/changeRequestSummaryService.js for why the diff itself is
 * the same code the audit trail uses.
 */
const summarizeChangeRequest = asyncHandler(async (req, res) => {
  const request = await ChangeRequest.findById(req.params.id);
  if (!request) throw ApiError.notFound('Change request not found');
  assertMayDecide(req.user, request);

  const { summarize } = require('../services/changeRequestSummaryService');
  const result = await summarize(request);

  if (!result) {
    return res.json({
      success: true,
      mode: 'fallback',
      data: { summary: 'The record this refers to no longer exists.', changes: [] },
    });
  }

  res.json({
    success: true,
    mode: result.mode,
    data: { summary: result.summary, changes: result.changes },
  });
});

module.exports = {
  listChangeRequests,
  approveChangeRequest,
  rejectChangeRequest,
  summarizeChangeRequest,
};
