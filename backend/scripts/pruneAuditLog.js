/**
 * Delete audit entries older than the configured retention period.
 *
 *   npm run prune-audit           # report what would be deleted, delete nothing
 *   npm run prune-audit -- --yes  # actually delete
 *
 * Does nothing unless `AUDIT_RETENTION_DAYS` is set. See
 * src/services/auditRetention.js for why this is a deliberate, run-on-demand
 * job rather than a TTL index that quietly deletes evidence on a schedule
 * nobody remembers setting.
 *
 * The two-step default — report first, delete only with `--yes` — is because
 * deleting audit records cannot be undone, and a retention period typed with
 * the wrong number of zeroes looks exactly like a correct one until it runs.
 */
const path = require('path');

process.chdir(path.resolve(__dirname, '..'));

const env = require('./../src/config/env');
const { connectDB, disconnectDB } = require('./../src/config/db');
const { pruneAuditLog, countPrunable } = require('./../src/services/auditRetention');

require('./../src/models/AuditLog');

const confirmed = process.argv.includes('--yes');

async function main() {
  if (!env.isConfigValid) {
    console.error('[audit] Refusing to run with an invalid configuration (see above).');
    process.exit(1);
  }

  if (!env.auditRetentionDays) {
    console.log(
      '[audit] No retention period configured, so nothing will be deleted.\n' +
        '        Set AUDIT_RETENTION_DAYS to enable pruning — deliberately opt-in, because\n' +
        '        an audit trail that deletes itself is useless on the day you need it.'
    );
    return;
  }

  await connectDB();

  const { eligible, cutoff } = await countPrunable();

  console.log(
    `[audit] Retention: ${env.auditRetentionDays} days. ` +
      `${eligible} entries predate ${cutoff.toISOString()}.`
  );

  if (!eligible) {
    console.log('[audit] Nothing to do.');
    await disconnectDB();
    return;
  }

  if (!confirmed) {
    console.log(
      '[audit] Dry run — nothing was deleted. Re-run with --yes to delete these entries.'
    );
    await disconnectDB();
    return;
  }

  const { deleted } = await pruneAuditLog();
  console.log(`[audit] Deleted ${deleted} entries.`);

  await disconnectDB();
}

main().catch((err) => {
  console.error(`[audit] Prune failed: ${err.message}`);
  process.exit(1);
});
