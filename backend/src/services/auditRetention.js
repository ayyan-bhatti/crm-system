const AuditLog = require('../models/AuditLog');
const env = require('../config/env');

/**
 * Pruning the audit trail, on an explicit policy.
 *
 * WHY THIS IS NOT A TTL INDEX
 *
 * Every other growing collection in this project (refresh tokens, idempotency
 * keys, rate-limit counters) expires its rows automatically, and none of that
 * is controversial — those rows stop being useful the moment they expire.
 *
 * An audit trail is different, and the difference is the whole point of having
 * one. It is read when something has gone wrong, usually about a period nobody
 * was paying attention to at the time. A TTL index deletes evidence silently,
 * on a schedule nobody remembers setting, and the deletion is discovered on the
 * day it matters. That is worse than a large collection.
 *
 * So the default is KEEP EVERYTHING, and pruning requires someone to state a
 * retention period on purpose:
 *
 *   AUDIT_RETENTION_DAYS unset  ->  nothing is ever deleted (the default)
 *   AUDIT_RETENTION_DAYS=365    ->  entries older than a year can be pruned
 *
 * Even then it is not automatic: `npm run prune-audit` runs it, so a deletion
 * is a deliberate operational act with a log line, not a background process.
 * Regulated environments usually need to prove BOTH that they kept records for
 * a period and that they did not keep them longer — a documented, run-on-demand
 * job supports both claims; a silent TTL supports neither.
 */

/**
 * How many entries would be removed by the current policy, without removing
 * anything.
 *
 * Exists so the prune script can report what it is about to do before doing it.
 * Deleting audit records is not reversible, and a dry run is the cheapest way
 * to catch a retention period entered with the wrong number of zeroes.
 */
async function countPrunable(retentionDays = env.auditRetentionDays) {
  if (!retentionDays) return { eligible: 0, cutoff: null, enabled: false };

  const cutoff = cutoffDate(retentionDays);
  const eligible = await AuditLog.countDocuments({ createdAt: { $lt: cutoff } });

  return { eligible, cutoff, enabled: true };
}

/**
 * Delete audit entries older than the retention period.
 *
 * Refuses to do anything when no period is configured — an unconfigured prune
 * that silently deleted "old" entries by some built-in default would be exactly
 * the surprise this design exists to avoid.
 *
 * @param {number} [retentionDays]
 * @returns {Promise<{ deleted: number, cutoff: Date|null, enabled: boolean }>}
 */
async function pruneAuditLog(retentionDays = env.auditRetentionDays) {
  if (!retentionDays) {
    return { deleted: 0, cutoff: null, enabled: false };
  }

  const cutoff = cutoffDate(retentionDays);
  const { deletedCount } = await AuditLog.deleteMany({ createdAt: { $lt: cutoff } });

  /*
   * The prune is itself recorded, in the log stream rather than in the audit
   * collection.
   *
   * Writing it INTO the audit trail would be neater to read and slightly
   * dishonest: the record of a deletion would then be subject to the same
   * deletion policy, so the evidence that entries were removed would eventually
   * be removed too. The application log is outside the thing being pruned.
   */
  if (!env.isTest) {
    console.log(
      `[audit] Pruned ${deletedCount} entries older than ${retentionDays} days ` +
        `(before ${cutoff.toISOString()}).`
    );
  }

  return { deleted: deletedCount, cutoff, enabled: true };
}

function cutoffDate(retentionDays) {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
}

module.exports = { pruneAuditLog, countPrunable };
