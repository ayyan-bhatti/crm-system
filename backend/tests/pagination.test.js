const { api, createAdmin, createManager, createCustomer, createProduct } = require('./helpers');
const Customer = require('../src/models/Customer');
const { getSort, encodeCursor, decodeCursor } = require('../src/utils/queryHelpers');

/**
 * Pagination.
 *
 * Two things are under test, and the second is the one that motivated the work:
 *
 *   1. that offset paging is CORRECT — which turns out to need a tiebreaker it
 *      did not have
 *   2. that cursor paging does not drift when the collection is written to
 *      mid-traversal, which offset paging demonstrably does
 */

describe('sort determinism', () => {
  /**
   * The latent bug. Sorting by a non-unique field leaves MongoDB free to order
   * tied documents differently between two queries — so a record can appear on
   * page 1 AND page 2 while another is never shown. Nothing errors and the
   * total still looks right, which is what makes it nasty.
   */
  it('always appends a unique tiebreaker to the sort', () => {
    expect(getSort({ sort: '-createdAt' }, ['createdAt'])).toEqual({ createdAt: -1, _id: -1 });
    expect(getSort({ sort: 'name' }, ['name'])).toEqual({ name: 1, _id: 1 });
  });

  it('points the tiebreaker the same way as the primary field', () => {
    expect(getSort({ sort: 'name' }, ['name'])._id).toBe(1);
    expect(getSort({ sort: '-name' }, ['name'])._id).toBe(-1);
  });

  it('adds the tiebreaker to the default sort too', () => {
    expect(getSort({}, ['createdAt'])).toEqual({ createdAt: -1, _id: -1 });
  });

  it('still refuses a field that is not on the allow-list', () => {
    // Falls back to the default rather than sorting by an unindexed field.
    expect(getSort({ sort: 'password' }, ['createdAt'])).toEqual({ createdAt: -1, _id: -1 });
  });

  /**
   * The end-to-end version of the same problem: many records sharing one
   * timestamp, paged through. Every record must appear exactly once.
   */
  it('shows every tied record exactly once across pages', async () => {
    const manager = await createManager();

    // One identical createdAt for all of them — what a bulk import produces.
    const sharedDate = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 12; i += 1) {
      await Customer.create({
        name: `Tied Customer ${i}`,
        email: `tied${i}@test.com`,
        createdBy: manager.user._id,
        createdAt: sharedDate,
      });
    }

    const seen = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await api()
        .get(`/api/customers?limit=4&page=${page}`)
        .set(manager.headers);
      seen.push(...res.body.data.map((c) => c._id));
    }

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12); // no duplicates, nothing missed
  });
});

describe('offset pagination', () => {
  let manager;

  beforeEach(async () => {
    manager = await createManager();
    for (let i = 0; i < 12; i += 1) {
      await createCustomer(manager, { name: `Customer ${String(i).padStart(2, '0')}` });
    }
  });

  it('reports the page, total and page count', async () => {
    const res = await api().get('/api/customers?limit=5').set(manager.headers);

    expect(res.body).toMatchObject({ page: 1, total: 12, pages: 3, count: 5 });
  });

  it('returns a different slice for each page', async () => {
    const first = await api().get('/api/customers?limit=5&page=1').set(manager.headers);
    const second = await api().get('/api/customers?limit=5&page=2').set(manager.headers);

    const overlap = first.body.data
      .map((c) => c._id)
      .filter((id) => second.body.data.some((c) => c._id === id));

    expect(overlap).toHaveLength(0);
  });

  it('caps the page size so a client cannot request the whole collection', async () => {
    const res = await api().get('/api/customers?limit=100000').set(manager.headers);
    expect(res.body.count).toBeLessThanOrEqual(100);
  });

  it('sorts by an allow-listed field', async () => {
    const res = await api().get('/api/customers?sort=name&limit=3').set(manager.headers);

    const names = res.body.data.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });
});

describe('cursor pagination', () => {
  let manager;

  beforeEach(async () => {
    manager = await createManager();
    for (let i = 0; i < 12; i += 1) {
      await createCustomer(manager, { name: `Customer ${String(i).padStart(2, '0')}` });
    }
  });

  /** Walk the whole collection with the cursor and check nothing is lost. */
  async function walkAll(path = '/api/customers', limit = 5) {
    const seen = [];
    let cursor = '';
    let guard = 0;

    do {
      const res = await api()
        .get(`${path}?limit=${limit}&cursor=${encodeURIComponent(cursor)}`)
        .set(manager.headers);

      seen.push(...res.body.data.map((row) => row._id));
      cursor = res.body.nextCursor || '';
      guard += 1;
    } while (cursor && guard < 20);

    return seen;
  }

  it('returns every record exactly once', async () => {
    const seen = await walkAll();

    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  /**
   * `nextCursor: null` is how a client knows to stop. Comparing counts is not
   * reliable — a final page that happens to be exactly `limit` long looks
   * identical to a full one.
   */
  it('reports null for nextCursor on the last page', async () => {
    const res = await api().get('/api/customers?limit=100&cursor=').set(manager.headers);

    expect(res.body.data).toHaveLength(12);
    expect(res.body.nextCursor).toBeNull();
  });

  it('signals a further page when one exists', async () => {
    const res = await api().get('/api/customers?limit=5&cursor=').set(manager.headers);

    expect(res.body.data).toHaveLength(5);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  /**
   * THE TEST THAT JUSTIFIES CURSOR PAGING.
   *
   * A record is inserted at the top of the ordering between fetching page 1 and
   * page 2. Under offset, everything shifts down by one and the last row of
   * page 1 reappears at the top of page 2. Under cursor, "everything after this
   * exact record" is unaffected by an insertion above it.
   */
  it('does not repeat a row when a record is inserted mid-traversal', async () => {
    const first = await api().get('/api/customers?limit=5&cursor=').set(manager.headers);

    // Someone else adds a customer. Default sort is newest-first, so it lands
    // at the very top — exactly the case that shifts an offset page.
    await createCustomer(manager, { name: 'Inserted Mid-Traversal' });

    const second = await api()
      .get(`/api/customers?limit=5&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .set(manager.headers);

    const firstIds = first.body.data.map((c) => c._id);
    const secondIds = second.body.data.map((c) => c._id);

    expect(secondIds.filter((id) => firstIds.includes(id))).toHaveLength(0);
  });

  /** The same scenario under offset, to show the difference is real. */
  it('offset paging DOES repeat a row in that situation', async () => {
    const first = await api().get('/api/customers?limit=5&page=1').set(manager.headers);

    await createCustomer(manager, { name: 'Inserted Mid-Traversal' });

    const second = await api().get('/api/customers?limit=5&page=2').set(manager.headers);

    const firstIds = first.body.data.map((c) => c._id);
    const repeated = second.body.data.map((c) => c._id).filter((id) => firstIds.includes(id));

    // Documented, not deplored: this is the trade-off offset makes, and the
    // reason the audit log and any exporting script should use the cursor.
    expect(repeated.length).toBeGreaterThan(0);
  });

  it('walks a tied run correctly rather than skipping its tail', async () => {
    const sharedDate = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 8; i += 1) {
      await Customer.create({
        name: `Tied ${i}`,
        email: `cursor-tied${i}@test.com`,
        createdBy: manager.user._id,
        createdAt: sharedDate,
      });
    }

    const seen = await walkAll('/api/customers', 3);

    expect(new Set(seen).size).toBe(20); // 12 original + 8 tied
  });

  it('honours an explicit ascending sort', async () => {
    const res = await api()
      .get('/api/customers?sort=name&limit=3&cursor=')
      .set(manager.headers);

    const names = res.body.data.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });

  /** A mangled cursor is ordinary bad input, not a 500. */
  it('falls back to the first page for an unreadable cursor', async () => {
    const res = await api()
      .get('/api/customers?limit=5&cursor=not-a-real-cursor')
      .set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
  });

  it('still applies permission scoping', async () => {
    const { createRep } = require('./helpers');
    const rep = await createRep();
    await createCustomer(rep, { name: 'Rep Own Customer' });

    const res = await api().get('/api/customers?cursor=&limit=50').set(rep.headers);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Rep Own Customer');
  });

  describe('on the other list endpoints', () => {
    it('works for products', async () => {
      for (let i = 0; i < 7; i += 1) {
        await createProduct({ name: `Product ${i}`, sku: `PAGE-${i}` });
      }

      const res = await api().get('/api/products?limit=3&cursor=').set(manager.headers);

      expect(res.body.data).toHaveLength(3);
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });

    it('works for orders', async () => {
      const customer = await createCustomer(manager);
      const product = await createProduct({ stockQty: 500 });

      for (let i = 0; i < 4; i += 1) {
        await api()
          .post('/api/orders')
          .set(manager.headers)
          .send({ customer: customer._id, items: [{ product: product._id, quantity: 1 }] });
      }

      const res = await api().get('/api/orders?limit=2&cursor=').set(manager.headers);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });

    it('works for audit logs, the endpoint it exists for', async () => {
      const admin = await createAdmin();

      for (let i = 0; i < 5; i += 1) {
        await api()
          .post('/api/customers')
          .set(manager.headers)
          .send({ name: `Audited ${i}`, email: `audited${i}@test.com` });
      }

      const res = await api().get('/api/audit-logs?limit=2&cursor=').set(admin.headers);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });
  });
});

describe('cursor encoding', () => {
  it('round-trips a value and an id', () => {
    const id = '507f1f77bcf86cd799439011';
    const cursor = encodeCursor({ createdAt: '2026-01-01T00:00:00.000Z', _id: id }, 'createdAt');

    expect(decodeCursor(cursor)).toEqual({ v: '2026-01-01T00:00:00.000Z', id });
  });

  /**
   * Carrying the id as well as the sort value is what lets a cursor land in the
   * middle of a run of identical timestamps and say which one it meant.
   */
  it('carries the id, not just the sort value', () => {
    const cursor = encodeCursor({ name: 'Acme', _id: '507f1f77bcf86cd799439011' }, 'name');

    expect(decodeCursor(cursor).id).toBe('507f1f77bcf86cd799439011');
  });

  it('rejects a cursor that is not valid base64 JSON', () => {
    expect(decodeCursor('%%%not-base64%%%')).toBeNull();
  });

  it('rejects a well-formed cursor carrying a bogus id', () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, id: 'not-an-objectid' })).toString(
      'base64url'
    );

    expect(decodeCursor(forged)).toBeNull();
  });
});

/**
 * Date ranges, and the timezone bug that hid in them.
 *
 * `getDateRange` used to end the range with `setHours`, which operates in LOCAL
 * time, while `new Date('2026-08-21')` parses a bare date as UTC midnight. The
 * mismatch shortened every range by the machine's UTC offset: on a server five
 * hours ahead, the last five hours of each day were silently absent from every
 * filtered result. No error — just quietly incomplete answers.
 *
 * It was invisible on the deployment, which runs in UTC, and surfaced only
 * because a test happened to run after local midnight. These assertions are
 * absolute instants, so they fail in ANY timezone if the mixing returns.
 */
describe('getDateRange', () => {
  const { getDateRange } = require('../src/utils/queryHelpers');

  it('starts at the very beginning of the from-day, in UTC', () => {
    const range = getDateRange('2026-08-21', undefined);

    expect(range.$gte.toISOString()).toBe('2026-08-21T00:00:00.000Z');
  });

  /** The assertion the bug failed: 23:59:59.999Z, not local 23:59. */
  it('ends at the very end of the to-day, in UTC', () => {
    const range = getDateRange(undefined, '2026-08-21');

    expect(range.$lte.toISOString()).toBe('2026-08-21T23:59:59.999Z');
  });

  it('covers a whole single day when from and to are the same', () => {
    const range = getDateRange('2026-08-21', '2026-08-21');

    expect(range.$gte.toISOString()).toBe('2026-08-21T00:00:00.000Z');
    expect(range.$lte.toISOString()).toBe('2026-08-21T23:59:59.999Z');

    // Every instant of that UTC day falls inside it — including the hours the
    // old implementation dropped.
    for (const hour of [0, 12, 19, 23]) {
      const instant = new Date(`2026-08-21T${String(hour).padStart(2, '0')}:30:00.000Z`);
      expect(instant >= range.$gte && instant <= range.$lte).toBe(true);
    }
  });

  it('excludes the day either side', () => {
    const range = getDateRange('2026-08-21', '2026-08-21');

    expect(new Date('2026-08-20T23:59:59.999Z') >= range.$gte).toBe(false);
    expect(new Date('2026-08-22T00:00:00.000Z') <= range.$lte).toBe(false);
  });

  it('returns null when neither end is given, so callers can skip the key', () => {
    expect(getDateRange(undefined, undefined)).toBeNull();
    expect(getDateRange('', '')).toBeNull();
  });

  it('ignores an end that is not a date rather than producing an invalid range', () => {
    expect(getDateRange('2026-08-21', 'not-a-date')).toEqual({
      $gte: new Date('2026-08-21T00:00:00.000Z'),
    });
  });
});
