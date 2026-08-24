const asyncHandler = require('../utils/asyncHandler');
const changeRequestService = require('../services/changeRequestService');
const { recordAudit } = require('../services/auditService');

/**
 * The administrator's approval queue for customer and order changes.
 *
 * Separate from the ACCOUNT approvals in userController, deliberately. They
 * look alike and are answered by the same person, but they are different
 * decisions: one is "should this person have access", the other is "should this
 * record change". Merging them into one queue would mean an admin skimming past
 * a customer deletion while looking for a colleague's signup.
 */

/**
 * GET /api/change-requests
 *
 * Everything waiting on a decision, oldest first. A queue is worked from the
 * front; newest-first would leave the longest wait permanently at the bottom.
 */
const listChangeRequests = asyncHandler(async (req, res) => {
  const data = await changeRequestService.listPending();

  res.json({ success: true, count: data.length, data });
});

/**
 * PATCH /api/change-requests/:id/approve
 *
 * Applies the change. The response carries the affected record, so the caller
 * can show what actually happened rather than only that something did.
 */
const approveChangeRequest = asyncHandler(async (req, res) => {
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

module.exports = { listChangeRequests, approveChangeRequest, rejectChangeRequest };
