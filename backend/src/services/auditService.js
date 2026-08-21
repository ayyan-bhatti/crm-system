const AuditLog = require('../models/AuditLog');
const { componentLogger } = require('../config/logger');

const log = componentLogger('audit');

/**
 * Writing audit entries.
 *
 * WHY CONTROLLERS CALL THIS EXPLICITLY, RATHER THAN A MONGOOSE HOOK
 *
 * A `post('save')` hook on every model would catch writes automatically and
 * never be forgotten, which sounds strictly better. It is not, for two reasons:
 *
 *   1. A model hook has no idea WHO made the request. Mongoose middleware sees
 *      the document, not the HTTP request, so the actor would have to be
 *      smuggled in through AsyncLocalStorage or stapled onto the document.
 *      Both work; both mean the most security-sensitive code in the app runs
 *      through indirection that is hard to follow and easy to break silently.
 *   2. Hooks fire on writes that are not user actions at all — seeding,
 *      migrations, the failed-login counter — and filtering those back out is
 *      guesswork.
 *
 * An explicit call is greppable: `grep recordAudit` lists every audited action.
 * The cost is that a new write handler could forget one, which is a real risk
 * and the reason there is a test asserting each write endpoint logs.
 *
 * NEVER FAILS THE REQUEST
 *
 * If the audit write throws, the error is logged and swallowed. Failing a
 * customer update because the audit trail was briefly unavailable would be a
 * worse outcome than a gap in the trail — and a loud one in the logs is a gap
 * you know about.
 */

/**
 * Fields that must never be written to the audit trail.
 *
 * The whole point of the collection is that it is kept, read by administrators,
 * and never overwritten — which makes it precisely the wrong place for a
 * password hash or a session token. An audit trail that quietly accumulates
 * secrets is a liability rather than a control.
 */
const REDACTED_FIELDS = new Set([
  'password',
  'tokenHash',
  'failedLoginAttempts',
  'lockUntil',
  '__v',
]);

/**
 * Turn a document into a plain, safe snapshot.
 *
 * Mongoose documents carry getters, virtuals and internal state that do not
 * belong in a stored record, so everything is flattened to JSON first.
 */
function snapshot(document) {
  if (!document) return null;

  const plain =
    typeof document.toObject === 'function'
      ? document.toObject({ depopulate: true, virtuals: false })
      : { ...document };

  const clean = {};
  for (const [key, value] of Object.entries(plain)) {
    if (REDACTED_FIELDS.has(key)) continue;
    clean[key] = value;
  }

  return clean;
}

/** Compare two values the way a reader would: by content, not by reference. */
function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  // ObjectIds and Dates both compare correctly once stringified.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The fields that actually changed.
 *
 * Only computed for updates: on a create everything is "new" and on a delete
 * everything is "gone", and listing every field in either case is noise that
 * hides the one entry that matters.
 */
function diff(before, after) {
  if (!before || !after) return [];

  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes = [];

  for (const field of fields) {
    if (field === '_id' || field === 'createdAt') continue;
    if (!sameValue(before[field], after[field])) {
      changes.push({ field, from: before[field] ?? null, to: after[field] ?? null });
    }
  }

  return changes;
}

/**
 * Record one write.
 *
 * @param {import('express').Request} req the request that caused it — supplies
 *   the actor and the request metadata, so no caller has to assemble them.
 * @param {object} options
 * @param {'create'|'update'|'delete'} options.action
 * @param {string} options.entity  'customer' | 'product' | 'order' | 'user'
 * @param {*} options.entityId
 * @param {string} [options.label]  human-readable name for the record
 * @param {object} [options.before] document state before the write
 * @param {object} [options.after]  document state after the write
 */
async function recordAudit(req, { action, entity, entityId, label, before, after }) {
  try {
    const beforeSnapshot = snapshot(before);
    const afterSnapshot = snapshot(after);

    await AuditLog.create({
      actor: {
        user: req.user?._id,
        // Snapshotted, not referenced — see the note in models/AuditLog.
        name: req.user?.name,
        email: req.user?.email,
        role: req.user?.role,
      },
      action,
      entity,
      entityId,
      entityLabel: label || afterSnapshot?.name || beforeSnapshot?.name || '',
      before: beforeSnapshot,
      after: afterSnapshot,
      changes: diff(beforeSnapshot, afterSnapshot),
      ip: req.ip || '',
      userAgent: String(req.get?.('user-agent') || '').slice(0, 255),
      method: req.method,
      path: req.originalUrl,
    });
  } catch (err) {
    // A gap in the trail is bad; refusing the user's write because of one is
    // worse. Logged loudly so the gap is at least known about.
    log.error({ err, action, entity, entityId }, 'failed to record an audit entry');
  }
}

module.exports = { recordAudit, snapshot, diff, REDACTED_FIELDS };
