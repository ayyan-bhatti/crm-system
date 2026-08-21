const { extractJson, validateFilter } = require('../src/services/aiSearchService');
const { runFilter } = require('../src/services/filterTranslator');
const Customer = require('../src/models/Customer');
const Product = require('../src/models/Product');
const Order = require('../src/models/Order');
const { createAdmin, createCustomer, createProduct } = require('./helpers');

/**
 * Regression tests for the QUERY SHAPES the product is expected to answer.
 *
 * WHY THESE ARE DIFFERENT FROM THE TESTS IN aiSearch.test.js.
 *
 * Those stub `translateQuery` and hand the endpoint a filter object that is
 * already valid. That tests the plumbing after translation, which is worth
 * testing, and it cannot catch the failure that matters most here: a model
 * reply, in the exact format the system prompt asks for, that the validator
 * then rejects or mangles.
 *
 * So these start from raw REPLY TEXT and run the real path:
 *
 *   text -> extractJson -> validateFilter -> runFilter -> rows
 *
 * The model itself is the only thing not exercised, because that needs a live
 * API key. Everything downstream of it is production code, so if the prompt and
 * the validator ever drift apart, these fail.
 */

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** The whole pipeline, from what the model said to what the user would see. */
async function answer(replyText, scope = {}) {
  const filter = validateFilter(extractJson(replyText));
  const { data } = await runFilter(filter, scope);
  return { filter, data };
}

describe('AI query shapes', () => {
  let admin;

  beforeEach(async () => {
    admin = await createAdmin();
  });

  /**
   * The flagship example. Needs a cross-collection condition, which is the
   * whole reason `orderActivity` exists as a special rather than a field.
   */
  describe('"customers in Karachi with no orders in the last 30 days"', () => {
    const REPLY =
      '{"entity":"customer","conditions":[{"field":"city","operator":"contains","value":"Karachi"}],' +
      '"special":{"orderActivity":{"type":"none","withinDays":30}}}';

    let dormant;

    beforeEach(async () => {
      const product = await createProduct({ price: 100, stockQty: 500 });
      dormant = await createCustomer(admin, { name: 'Dormant Traders', city: 'Karachi' });
      const busy = await createCustomer(admin, { name: 'Busy Imports', city: 'Karachi' });
      await createCustomer(admin, { name: 'Lahore Metals', city: 'Lahore' });

      const place = (customer, when) =>
        Order.create({
          customer: customer._id,
          items: [{ product: product._id, quantity: 1, priceAtOrder: 100 }],
          total: 100,
          status: 'completed',
          completedAt: when,
          createdBy: admin.user._id,
          createdAt: when,
        });

      await place(busy, daysAgo(3)); // recent — must be excluded
      await place(dormant, daysAgo(90)); // long ago — must still be included
    });

    it('translates into a city condition plus an order-activity special', async () => {
      const { filter } = await answer(REPLY);

      expect(filter.entity).toBe('customer');
      expect(filter.conditions).toEqual([
        { field: 'city', operator: 'contains', value: 'Karachi' },
      ]);
      expect(filter.special.orderActivity).toEqual({ type: 'none', withinDays: 30 });
    });

    it('returns only the Karachi customer who has gone quiet', async () => {
      const { data } = await answer(REPLY);

      expect(data.map((row) => row.name)).toEqual(['Dormant Traders']);
    });

    /**
     * "No orders in 30 days" is not "no orders ever" — a customer with an old
     * order still counts as quiet, and dropping them would answer a different
     * question from the one asked.
     */
    it('counts an old order as still being quiet', async () => {
      const { data } = await answer(REPLY);

      const orderCount = await Order.countDocuments({ customer: dormant._id });
      expect(orderCount).toBe(1);
      expect(data).toHaveLength(1);
    });
  });

  describe('"products running low on stock"', () => {
    const REPLY = '{"entity":"product","conditions":[],"special":{"lowStock":true}}';

    beforeEach(async () => {
      await createProduct({ name: 'Widget', sku: 'WID-1', stockQty: 3, lowStockThreshold: 10 });
      await createProduct({ name: 'Gadget', sku: 'GAD-1', stockQty: 500, lowStockThreshold: 10 });
      await createProduct({ name: 'Doohickey', sku: 'DOO-1', stockQty: 10, lowStockThreshold: 10 });
    });

    it('translates into the lowStock special with no field conditions', async () => {
      const { filter } = await answer(REPLY);

      expect(filter.entity).toBe('product');
      expect(filter.conditions).toEqual([]);
      expect(filter.special.lowStock).toBe(true);
    });

    /** At the threshold counts as low — "running low" includes "just hit it". */
    it('returns products at or below their threshold, and no others', async () => {
      const { data } = await answer(REPLY);

      expect(data.map((row) => row.name).sort()).toEqual(['Doohickey', 'Widget']);
    });

    /**
     * The default sort used to be hardcoded descending for every entity, which
     * is right for a date and lists a product catalogue Z-to-A.
     */
    it('defaults to alphabetical order rather than reverse alphabetical', async () => {
      const { filter, data } = await answer(REPLY);

      expect(filter.sort).toEqual({ field: 'name', direction: 'asc' });
      expect(data.map((row) => row.name)).toEqual(['Doohickey', 'Widget']);
    });
  });

  describe('"orders over $500 last week"', () => {
    const REPLY =
      '{"entity":"order","conditions":[{"field":"total","operator":"gt","value":500},' +
      '{"field":"createdAt","operator":"withinDays","value":7}],' +
      '"sort":{"field":"total","direction":"desc"}}';

    beforeEach(async () => {
      const product = await createProduct({ price: 100, stockQty: 500 });
      const customer = await createCustomer(admin);

      const place = (total, when) =>
        Order.create({
          customer: customer._id,
          items: [{ product: product._id, quantity: 1, priceAtOrder: total }],
          total,
          status: 'completed',
          completedAt: when,
          createdBy: admin.user._id,
          createdAt: when,
        });

      await place(900, daysAgo(3)); // over, recent      -> match
      await place(600, daysAgo(1)); // over, recent      -> match
      await place(120, daysAgo(2)); // recent, too small -> no
      await place(700, daysAgo(90)); // over, too old    -> no
    });

    it('translates into a numeric threshold AND a date window', async () => {
      const { filter } = await answer(REPLY);

      expect(filter.entity).toBe('order');
      expect(filter.conditions).toEqual([
        { field: 'total', operator: 'gt', value: 500 },
        { field: 'createdAt', operator: 'withinDays', value: 7 },
      ]);
    });

    /** Both halves must apply. Either one alone returns a wrong answer. */
    it('applies both conditions, not just the first', async () => {
      const { data } = await answer(REPLY);

      expect(data.map((row) => row.total)).toEqual([900, 600]);
    });

    it('honours the sort the model asked for', async () => {
      const { filter, data } = await answer(REPLY);

      expect(filter.sort).toEqual({ field: 'total', direction: 'desc' });
      expect(data[0].total).toBeGreaterThan(data[1].total);
    });
  });

  /**
   * Role scope is applied on top of whatever the model asked for. A filter that
   * is correct in isolation must still not reach another rep's records.
   */
  describe('scope is enforced regardless of what the model returned', () => {
    it('a rep-scoped search cannot see another rep’s customers', async () => {
      const mine = await createCustomer(admin, { name: 'Mine', city: 'Karachi' });
      await createCustomer(admin, { name: 'Theirs', city: 'Karachi' });

      const REPLY =
        '{"entity":"customer","conditions":[{"field":"city","operator":"contains","value":"Karachi"}]}';

      const { data } = await answer(REPLY, { _id: mine._id });

      expect(data.map((row) => row.name)).toEqual(['Mine']);
    });
  });

  /**
   * The validator is the security boundary. A reply in the right shape asking
   * for something outside the schema must be refused, not partially honoured.
   */
  describe('replies the validator must refuse', () => {
    it('rejects a field that does not exist on the entity', () => {
      expect(() =>
        validateFilter(
          extractJson('{"entity":"customer","conditions":[{"field":"salary","operator":"gt","value":1}]}')
        )
      ).toThrow(/Unknown field/i);
    });

    it('rejects an operator the field type does not allow', () => {
      expect(() =>
        validateFilter(
          extractJson('{"entity":"product","conditions":[{"field":"name","operator":"gt","value":1}]}')
        )
      ).toThrow(/not valid/i);
    });

    it('rejects an unknown entity', () => {
      expect(() => validateFilter(extractJson('{"entity":"invoice","conditions":[]}'))).toThrow(
        /Unknown entity/i
      );
    });

    /** A special belonging to a different entity is not silently carried over. */
    it('drops a special that does not belong to the entity', async () => {
      const { filter } = await answer(
        '{"entity":"customer","conditions":[],"special":{"lowStock":true}}'
      );

      expect(filter.special.lowStock).toBeUndefined();
    });
  });

  /** Sanity: the fixtures exist, so an empty result never passes by accident. */
  it('has data to search', async () => {
    await createCustomer(admin, { city: 'Karachi' });

    expect(await Customer.countDocuments({})).toBeGreaterThan(0);
    expect(await Product.countDocuments({})).toBeGreaterThanOrEqual(0);
  });
});
