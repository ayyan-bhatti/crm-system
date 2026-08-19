const Customer = require('../src/models/Customer');
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');
const AuditLog = require('../src/models/AuditLog');
const { createManager, createRep, createCustomer } = require('./helpers');
const { customerScopeFilter } = require('../src/controllers/customerController');

/**
 * Indexes.
 *
 * Asserting that an index EXISTS is nearly worthless on its own — it passes
 * just as happily when the index is unused. So these tests do two things:
 *
 *   1. pin the index list, so removing one is a deliberate act with a failing
 *      test attached rather than a silent performance regression
 *   2. ask MongoDB, via explain(), whether the real queries actually USE them
 *
 * The second is what earns the file. It caught a genuine bug: appending `_id`
 * to every sort (for pagination determinism) meant the existing indexes no
 * longer satisfied those sorts, and every list query fell back to an in-memory
 * sort. Nothing failed and no answer changed — it just got slower.
 */

/**
 * Build the indexes before asserting anything about them.
 *
 * Mongoose creates schema indexes LAZILY — on the model's first use, not when
 * the schema is defined. So a test that only reads `collection.indexes()`
 * without writing anything first sees just the default `_id` index and fails
 * for a reason that has nothing to do with the index definitions.
 *
 * Worth knowing beyond the tests: the same laziness applies in production. The
 * indexes appear when the app first touches each collection, which means the
 * very first queries after a deploy can run unindexed. `syncIndexes()` as a
 * deploy step is the way to make that deterministic.
 */
beforeAll(async () => {
  await Promise.all([Customer.init(), Product.init(), Order.init(), AuditLog.init()]);
});

/** The keys of every index on a collection, as comparable strings. */
async function indexKeys(Model) {
  const indexes = await Model.collection.indexes();
  return indexes.map((index) => JSON.stringify(index.key));
}

/**
 * The winning query plan, flattened to a string.
 *
 * Stringified rather than walked as a tree: MongoDB reports the plan
 * differently between its classic and SBE engines (`inputStage` vs
 * `queryPlan`), and a walker assuming one shape silently reports "no index" on
 * the other — making these tests fail for a reason unrelated to the indexes.
 */
async function plan(query) {
  const explained = await query.explain('queryPlanner');
  return JSON.stringify(explained.queryPlanner.winningPlan);
}

const usesIndex = (p) => p.includes('IXSCAN');
const scansCollection = (p) => p.includes('COLLSCAN');
/** An in-memory SORT stage means no index satisfied the ordering. */
const sortsInMemory = (p) => p.includes('"stage":"SORT"');

/**
 * Enough documents that the planner prefers an index.
 *
 * On a nearly empty collection MongoDB correctly chooses a collection scan —
 * reading four documents beats consulting an index — so an explain() assertion
 * against an empty collection proves nothing at all.
 */
async function seed(Model, makeDoc, count = 200) {
  const docs = Array.from({ length: count }, (_, i) => makeDoc(i));
  await Model.insertMany(docs, { ordered: false });
}

describe('Customer indexes', () => {
  it('indexes both branches of the sales-rep scope filter', async () => {
    const keys = await indexKeys(Customer);

    // An $or cannot be served by one compound index — MongoDB evaluates each
    // branch separately — so each branch needs its own.
    expect(keys).toContain(JSON.stringify({ assignedTo: 1, createdAt: -1, _id: -1 }));
    expect(keys).toContain(JSON.stringify({ createdBy: 1, createdAt: -1, _id: -1 }));
  });

  it('indexes the default newest-first ordering', async () => {
    expect(await indexKeys(Customer)).toContain(JSON.stringify({ createdAt: -1, _id: -1 }));
  });

  it('indexes the status filter together with the sort', async () => {
    expect(await indexKeys(Customer)).toContain(
      JSON.stringify({ status: 1, createdAt: -1, _id: -1 })
    );
  });

  /**
   * The removed index. Nothing in the codebase issues a `$text` query — both
   * the list and the AI keyword fallback build regexes — so it was maintained
   * on every write and read by nothing.
   */
  it('no longer carries an unused text index', async () => {
    const indexes = await Customer.collection.indexes();
    const textIndexes = indexes.filter((index) => Object.values(index.key).includes('text'));

    expect(textIndexes).toHaveLength(0);
  });

  describe('are actually used', () => {
    let manager;

    beforeEach(async () => {
      manager = await createManager();
      await seed(Customer, (i) => ({
        name: `Customer ${String(i).padStart(4, '0')}`,
        email: `idx${i}@test.com`,
        createdBy: manager.user._id,
        assignedTo: manager.user._id,
        status: i % 3 === 0 ? 'active' : 'lead',
      }));
    });

    /**
     * The assertion that caught the real bug in this item.
     *
     * An index on { createdAt: -1 } does NOT satisfy a sort of
     * { createdAt: -1, _id: -1 }. MongoDB fetches every match and sorts it in
     * memory instead — the index still exists, the answer is still correct, it
     * is only slower. Exactly the regression nobody notices until the
     * collection is large.
     */
    it('serves the default list ordering from an index, with no in-memory sort', async () => {
      const p = await plan(Customer.find({}).sort({ createdAt: -1, _id: -1 }).limit(25));

      expect(usesIndex(p)).toBe(true);
      expect(sortsInMemory(p)).toBe(false);
    });

    /**
     * The regression that motivated the whole item: a sales rep's list used to
     * scan the entire collection, because `createdBy` had no index at all.
     */
    it('serves a scoped sales-rep list from an index', async () => {
      const rep = await createRep();

      const p = await plan(
        Customer.find(customerScopeFilter(rep.user)).sort({ createdAt: -1, _id: -1 })
      );

      expect(scansCollection(p)).toBe(false);
    });

    it('serves the status filter and its sort from one index', async () => {
      const p = await plan(Customer.find({ status: 'active' }).sort({ createdAt: -1, _id: -1 }));

      expect(usesIndex(p)).toBe(true);
      expect(sortsInMemory(p)).toBe(false);
    });

    it('serves the name sort used by the picker', async () => {
      const p = await plan(Customer.find({}).sort({ name: 1, _id: 1 }).limit(20));

      expect(usesIndex(p)).toBe(true);
      expect(sortsInMemory(p)).toBe(false);
    });

    /**
     * The honest one, and more precise than "a regex cannot use an index".
     *
     * An unanchored case-insensitive regex cannot SEEK — there is no prefix to
     * jump to — so MongoDB scans the whole index range and applies the pattern
     * to every key. Cheaper than a collection scan (the index is smaller, and
     * documents are fetched only for matches) but still linear in collection
     * size, and no additional index changes that.
     */
    it('cannot seek for an unanchored substring search', async () => {
      const p = await plan(Customer.find({ name: /ustom/i }));

      expect(usesIndex(p)).toBe(true);
      // Bounds spanning the entire index are the signature of a full scan
      // rather than a seek: there is no narrower range to jump to.
      expect(p).toContain('", {})');
    });

    /** ...whereas an anchored prefix search CAN seek, which is the available fix. */
    it('can seek for an anchored prefix search', async () => {
      const p = await plan(Customer.find({ name: /^Customer 0001/ }));

      expect(usesIndex(p)).toBe(true);
      // A real bound derived from the prefix, not the whole index.
      expect(p).toContain('Customer 0001');
    });
  });
});

describe('Product indexes', () => {
  it('relies on the unique SKU index rather than duplicating it', async () => {
    const indexes = await Product.collection.indexes();
    const skuIndexes = indexes.filter((index) => index.key.sku !== undefined);

    // One index, and it is the unique constraint doing double duty.
    expect(skuIndexes).toHaveLength(1);
    expect(skuIndexes[0].unique).toBe(true);
  });

  it('indexes the category filter with the list ordering', async () => {
    expect(await indexKeys(Product)).toContain(
      JSON.stringify({ category: 1, name: 1, _id: 1 })
    );
  });

  it('indexes the name sort used by the picker', async () => {
    expect(await indexKeys(Product)).toContain(JSON.stringify({ name: 1, _id: 1 }));
  });

  it('no longer carries an unused text index', async () => {
    const indexes = await Product.collection.indexes();
    expect(indexes.filter((i) => Object.values(i.key).includes('text'))).toHaveLength(0);
  });

  it('serves a SKU lookup from the unique index', async () => {
    await seed(Product, (i) => ({ name: `P${i}`, sku: `IDX-${i}`, price: 1, stockQty: 1 }));

    const p = await plan(Product.find({ sku: 'IDX-5' }));

    expect(usesIndex(p)).toBe(true);
  });
});

describe('Order indexes', () => {
  it('indexes the sales-rep scope branch that was missing', async () => {
    expect(await indexKeys(Order)).toContain(
      JSON.stringify({ createdBy: 1, createdAt: -1, _id: -1 })
    );
  });

  it('indexes orders by customer with their ordering', async () => {
    expect(await indexKeys(Order)).toContain(
      JSON.stringify({ customer: 1, createdAt: -1, _id: -1 })
    );
  });

  it('indexes the status filter with the sort', async () => {
    expect(await indexKeys(Order)).toContain(
      JSON.stringify({ status: 1, createdAt: -1, _id: -1 })
    );
  });

  it('indexes the date range and default ordering', async () => {
    expect(await indexKeys(Order)).toContain(JSON.stringify({ createdAt: -1, _id: -1 }));
  });

  it('indexes sorting by order value', async () => {
    expect(await indexKeys(Order)).toContain(JSON.stringify({ total: -1, _id: -1 }));
  });

  it('serves a date-range query and its sort from one index', async () => {
    const manager = await createManager();
    const customer = await createCustomer(manager);

    await seed(Order, (i) => ({
      customer: customer._id,
      items: [{ product: customer._id, quantity: 1, priceAtOrder: 1 }],
      total: i,
      createdBy: manager.user._id,
    }));

    const p = await plan(
      Order.find({ createdAt: { $gte: new Date('2020-01-01') } }).sort({
        createdAt: -1,
        _id: -1,
      })
    );

    expect(usesIndex(p)).toBe(true);
    expect(sortsInMemory(p)).toBe(false);
  });
});

describe('AuditLog indexes', () => {
  /** One entry, shaped enough to satisfy the schema. */
  const entry = (manager, i) => ({
    actor: { user: manager.user._id, name: 'A', email: 'a@t.com', role: 'manager' },
    action: 'create',
    entity: 'customer',
    entityId: manager.user._id,
    entityLabel: `Row ${i}`,
  });

  /**
   * The audit log is the collection cursor paging exists for, so its indexes
   * matter more than most: append-only, unbounded, and read newest-first with
   * an optional narrowing filter.
   */
  it('indexes each way the audit screen is filtered', async () => {
    const keys = await indexKeys(AuditLog);

    expect(keys).toContain(JSON.stringify({ createdAt: -1, _id: -1 }));
    expect(keys).toContain(JSON.stringify({ entity: 1, createdAt: -1, _id: -1 }));
    expect(keys).toContain(JSON.stringify({ 'actor.user': 1, createdAt: -1, _id: -1 }));
    expect(keys).toContain(JSON.stringify({ entityId: 1, createdAt: -1, _id: -1 }));
  });

  it('serves the default newest-first read from an index', async () => {
    const manager = await createManager();
    await seed(AuditLog, (i) => entry(manager, i));

    const p = await plan(AuditLog.find({}).sort({ createdAt: -1, _id: -1 }));

    expect(usesIndex(p)).toBe(true);
    expect(sortsInMemory(p)).toBe(false);
  });

  it('serves "what happened to this record" from an index', async () => {
    const manager = await createManager();
    await seed(AuditLog, (i) => entry(manager, i));

    const p = await plan(
      AuditLog.find({ entityId: manager.user._id }).sort({ createdAt: -1, _id: -1 })
    );

    expect(usesIndex(p)).toBe(true);
  });

  /**
   * Deliberately NOT expiring, unlike every other new collection here. Asserted
   * so that adding a TTL later has to be a conscious decision — logs that
   * delete themselves are as useful as no logs on the day you need them.
   */
  it('has no TTL index, on purpose', async () => {
    const indexes = await AuditLog.collection.indexes();
    expect(indexes.filter((i) => i.expireAfterSeconds !== undefined)).toHaveLength(0);
  });
});
