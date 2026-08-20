const AuditLog = require('../src/models/AuditLog');
const { pruneAuditLog, countPrunable } = require('../src/services/auditRetention');
const { createManager } = require('./helpers');

/**
 * Audit-log retention.
 *
 * The behaviour that matters most here is the DEFAULT: with no retention period
 * configured, nothing is ever deleted. An audit trail that quietly expires on a
 * schedule nobody remembers setting is missing exactly when it is needed, which
 * is why this is opt-in rather than a TTL index like every other growing
 * collection in the project.
 */

describe('Audit retention', () => {
  let manager;

  beforeEach(async () => {
    manager = await createManager();
  });

  /** Write an audit entry stamped at a chosen age. */
  const entryAged = (daysAgo, label = 'Row') =>
    AuditLog.create({
      actor: {
        user: manager.user._id,
        name: manager.user.name,
        email: manager.user.email,
        role: 'manager',
      },
      action: 'update',
      entity: 'customer',
      entityId: manager.user._id,
      entityLabel: `${label} ${daysAgo}d`,
      createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    });

  describe('with no retention period configured', () => {
    /**
     * The default, and the whole design decision. Nothing is deleted, however
     * old it is.
     */
    it('deletes nothing at all', async () => {
      await entryAged(5000);
      await entryAged(1);

      const result = await pruneAuditLog(null);

      expect(result).toMatchObject({ deleted: 0, enabled: false });
      expect(await AuditLog.countDocuments({})).toBe(2);
    });

    it('reports that pruning is not enabled rather than guessing a default', async () => {
      await entryAged(5000);

      expect(await countPrunable(null)).toMatchObject({ eligible: 0, enabled: false });
    });
  });

  describe('with a retention period', () => {
    it('deletes entries older than the period', async () => {
      await entryAged(400, 'old');
      await entryAged(500, 'older');
      await entryAged(10, 'recent');

      const result = await pruneAuditLog(365);

      expect(result.deleted).toBe(2);
      expect(result.enabled).toBe(true);
    });

    /** The point of a retention period is that recent history survives it. */
    it('keeps everything inside the period', async () => {
      await entryAged(400);
      await entryAged(10);
      await entryAged(364);

      await pruneAuditLog(365);

      const remaining = await AuditLog.find({});
      expect(remaining).toHaveLength(2);
      expect(remaining.every((row) => row.entityLabel.match(/10d|364d/))).toBe(true);
    });

    it('is exact at the boundary', async () => {
      await entryAged(366);
      await entryAged(364);

      await pruneAuditLog(365);

      expect(await AuditLog.countDocuments({})).toBe(1);
    });

    it('does nothing when nothing is old enough', async () => {
      await entryAged(10);
      await entryAged(20);

      expect((await pruneAuditLog(365)).deleted).toBe(0);
      expect(await AuditLog.countDocuments({})).toBe(2);
    });
  });

  describe('counting before deleting', () => {
    /**
     * Deleting audit records cannot be undone, and a retention period typed
     * with the wrong number of zeroes looks exactly like a correct one until it
     * runs. The prune script reports before it acts, and this is what it uses.
     */
    it('reports what would be deleted without deleting it', async () => {
      await entryAged(400);
      await entryAged(500);
      await entryAged(10);

      const { eligible, cutoff, enabled } = await countPrunable(365);

      expect(eligible).toBe(2);
      expect(enabled).toBe(true);
      expect(cutoff).toBeInstanceOf(Date);
      // Nothing was touched.
      expect(await AuditLog.countDocuments({})).toBe(3);
    });

    it('agrees with what the prune actually removes', async () => {
      await entryAged(400);
      await entryAged(500);
      await entryAged(10);

      const { eligible } = await countPrunable(365);
      const { deleted } = await pruneAuditLog(365);

      expect(deleted).toBe(eligible);
    });
  });

  /**
   * The record of a prune is written to the application log, not into the audit
   * collection. Putting it there would be neater and slightly dishonest: the
   * evidence that entries were deleted would itself be subject to the deletion
   * policy.
   */
  it('does not write its own record into the collection it prunes', async () => {
    await entryAged(400);

    await pruneAuditLog(365);

    expect(await AuditLog.countDocuments({})).toBe(0);
  });
});
