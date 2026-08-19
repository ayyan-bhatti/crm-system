const AuditLog = require('../models/AuditLog');
const asyncHandler = require('../utils/asyncHandler');
const {
  getPagination,
  getSort,
  paginatedResponse,
  getDateRange,
} = require('../utils/queryHelpers');

const SORTABLE_FIELDS = ['createdAt', 'action', 'entity'];

/**
 * GET /api/audit-logs — admin only.
 *
 * Filters: ?entity= ?action= ?actor= ?entityId= ?from= ?to=
 * Paging:  ?page= ?limit= ?sort=
 *
 * Each filter exists because it answers a question someone actually asks of an
 * audit trail, and each is backed by an index on the model:
 *
 *   entity + date   "what happened to customers this week?"
 *   actor           "what has this person been doing?"
 *   entityId        "show me the full history of THIS record"
 *
 * ADMIN ONLY, ENFORCED ON THE ROUTE
 *
 * An audit trail is a record of everyone's actions, including managers' — so
 * exposing it to managers would let the people most worth auditing read their
 * own trail and see exactly what was captured. It is also, by construction, the
 * one collection holding a copy of every field of every record, which makes it
 * a way around every other permission rule in the app: a sales rep who could
 * read it would see customers they have no access to. Restricting it to admins
 * is not caution, it is the only setting that does not undo the rest of the
 * authorisation model.
 */
const listAuditLogs = asyncHandler(async (req, res) => {
  const { entity, action, actor, entityId, from, to } = req.query;
  const { page, limit, skip } = getPagination(req.query);

  const filter = {};

  if (entity) filter.entity = entity;
  if (action) filter.action = action;
  if (actor) filter['actor.user'] = actor;
  if (entityId) filter.entityId = entityId;

  const createdAt = getDateRange(from, to);
  if (createdAt) filter.createdAt = createdAt;

  const [data, total] = await Promise.all([
    AuditLog.find(filter)
      .sort(getSort(req.query, SORTABLE_FIELDS))
      .skip(skip)
      .limit(limit),
    AuditLog.countDocuments(filter),
  ]);

  res.json(paginatedResponse({ data, total, page, limit }));
});

/**
 * GET /api/audit-logs/:id — one entry, with its full before/after documents.
 *
 * Separate from the list because the whole point of a detail view is the two
 * complete snapshots, and shipping those for every row of a 25-row list page
 * would make the list heavy for data almost nobody expands.
 */
const getAuditLog = asyncHandler(async (req, res) => {
  const log = await AuditLog.findById(req.params.id);

  if (!log) {
    return res.status(404).json({ success: false, message: 'Audit log entry not found' });
  }

  return res.json({ success: true, data: log });
});

module.exports = { listAuditLogs, getAuditLog };
