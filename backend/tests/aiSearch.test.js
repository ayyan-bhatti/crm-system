const { api, createAdmin, createRep, createCustomer, createProduct } = require('./helpers');
const aiSearchService = require('../src/services/aiSearchService');
const { tokenize, inferEntity } = require('../src/services/filterTranslator');
const { extractJson, validateFilter } = aiSearchService;

/**
 * AI search.
 *
 * The model is never called here — `translateQuery` is stubbed, so the suite is
 * fast, deterministic and needs no API key. What is actually being tested is
 * everything around the model: that its output is parsed defensively, that a
 * bad filter is rejected rather than executed, that role scoping still applies,
 * and that any failure degrades to keyword search instead of a 500.
 */
describe('AI search', () => {
  const realTranslate = aiSearchService.translateQuery;

  afterEach(() => {
    aiSearchService.translateQuery = realTranslate;
  });

  /** Force the endpoint down the AI path with a known filter. */
  function stubFilter(filter) {
    aiSearchService.translateQuery = async () => ({ mode: 'ai', filter });
  }

  /** Force the endpoint down the fallback path. */
  function stubFallback(reason = 'stubbed failure') {
    aiSearchService.translateQuery = async () => ({ mode: 'fallback', filter: null, reason });
  }

  describe('extractJson', () => {
    it('parses a bare object', () => {
      expect(extractJson('{"entity":"customer"}')).toEqual({ entity: 'customer' });
    });

    it('parses an object inside a ```json fence', () => {
      expect(extractJson('```json\n{"entity":"product"}\n```').entity).toBe('product');
    });

    it('parses an object surrounded by prose', () => {
      const text = 'Sure, here you go:\n{"entity":"order"}\nLet me know if that helps.';
      expect(extractJson(text).entity).toBe('order');
    });

    it('does not truncate at the first closing brace of a nested object', () => {
      const text = '{"entity":"customer","special":{"orderActivity":{"type":"none","withinDays":30}}}';
      expect(extractJson(text).special.orderActivity.withinDays).toBe(30);
    });

    it('handles a brace inside a string value', () => {
      const text = '{"entity":"customer","conditions":[{"field":"notes","operator":"contains","value":"a } b"}]}';
      expect(extractJson(text).conditions[0].value).toBe('a } b');
    });

    it('returns null when there is no JSON', () => {
      expect(extractJson('I am not able to help with that.')).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      expect(extractJson('{entity: customer}')).toBeNull();
    });

    it('returns null for an unterminated object', () => {
      expect(extractJson('{"entity":"customer"')).toBeNull();
    });
  });

  describe('validateFilter — the allow-list boundary', () => {
    it('accepts a well-formed filter', () => {
      const filter = validateFilter({
        entity: 'customer',
        conditions: [{ field: 'city', operator: 'contains', value: 'Karachi' }],
      });

      expect(filter.entity).toBe('customer');
      expect(filter.conditions).toHaveLength(1);
    });

    it.each([
      ['an unknown entity', { entity: 'users', conditions: [] }],
      [
        'a field that does not exist',
        { entity: 'customer', conditions: [{ field: 'password', operator: 'eq', value: 'x' }] },
      ],
      [
        'a field belonging to another entity',
        { entity: 'customer', conditions: [{ field: 'stockQty', operator: 'gt', value: 1 }] },
      ],
      [
        'an operator invalid for the field type',
        { entity: 'customer', conditions: [{ field: 'city', operator: 'gt', value: 'x' }] },
      ],
      [
        'a value outside an enum',
        { entity: 'customer', conditions: [{ field: 'status', operator: 'eq', value: 'vip' }] },
      ],
      [
        'a non-numeric value for a number field',
        { entity: 'product', conditions: [{ field: 'price', operator: 'gt', value: 'cheap' }] },
      ],
      [
        'an unparseable date',
        { entity: 'order', conditions: [{ field: 'createdAt', operator: 'after', value: 'soon' }] },
      ],
      // The injection attempts the allow-list exists to stop.
      [
        'a $where operator smuggled in as a field',
        { entity: 'customer', conditions: [{ field: '$where', operator: 'eq', value: '1==1' }] },
      ],
      [
        'a __proto__ field',
        { entity: 'customer', conditions: [{ field: '__proto__', operator: 'eq', value: 'x' }] },
      ],
      [
        'a constructor field',
        { entity: 'customer', conditions: [{ field: 'constructor', operator: 'eq', value: 'x' }] },
      ],
    ])('rejects %s', (_label, input) => {
      expect(() => validateFilter(input)).toThrow();
    });

    it('silently drops an unrecognised special condition', () => {
      const filter = validateFilter({
        entity: 'customer',
        conditions: [],
        special: { dropDatabase: true },
      });

      expect(filter.special).toEqual({});
    });

    it('falls back to the default sort when the sort field is unknown', () => {
      const filter = validateFilter({
        entity: 'customer',
        conditions: [],
        sort: { field: 'password', direction: 'asc' },
      });

      expect(filter.sort.field).toBe('createdAt');
    });

    it('clamps an excessive limit', () => {
      expect(validateFilter({ entity: 'customer', conditions: [], limit: 100000 }).limit).toBe(50);
    });
  });

  describe('POST /api/ai-search — AI path', () => {
    it('runs the structured filter and reports mode "ai"', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Karachi Co', city: 'Karachi' });
      await createCustomer(admin, { name: 'Lahore Co', city: 'Lahore' });

      stubFilter({
        entity: 'customer',
        conditions: [{ field: 'city', operator: 'contains', value: 'Karachi' }],
        special: {},
        sort: { field: 'createdAt', direction: 'desc' },
        limit: 25,
      });

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'customers in Karachi' });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('ai');
      expect(res.body.count).toBe(1);
      expect(res.body.data[0].name).toBe('Karachi Co');
    });

    it('returns the filter that was applied, so the UI can show it', async () => {
      const admin = await createAdmin();

      stubFilter({
        entity: 'customer',
        conditions: [{ field: 'city', operator: 'contains', value: 'Karachi' }],
        special: {},
        sort: { field: 'createdAt', direction: 'desc' },
        limit: 25,
      });

      const res = await api().post('/api/ai-search').set(admin.headers).send({ query: 'anything' });

      expect(res.body.filter.entity).toBe('customer');
    });

    /**
     * The flagship example from the brief. It needs a cross-collection
     * condition, which is why `orderActivity` exists as a special condition.
     */
    it('handles "customers in Karachi with no orders in the last 30 days"', async () => {
      const admin = await createAdmin();
      const product = await createProduct({ stockQty: 50 });

      const dormant = await createCustomer(admin, { name: 'Dormant Traders', city: 'Karachi' });
      const busy = await createCustomer(admin, { name: 'Busy Imports', city: 'Karachi' });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: busy._id, items: [{ product: product._id, quantity: 1 }] });

      stubFilter({
        entity: 'customer',
        conditions: [{ field: 'city', operator: 'contains', value: 'Karachi' }],
        special: { orderActivity: { type: 'none', withinDays: 30 } },
        sort: { field: 'createdAt', direction: 'desc' },
        limit: 25,
      });

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'customers in Karachi with no orders in the last 30 days' });

      expect(res.body.count).toBe(1);
      expect(String(res.body.data[0]._id)).toBe(String(dormant._id));
    });

    it('inverts the same condition for "who ordered recently"', async () => {
      const admin = await createAdmin();
      const product = await createProduct({ stockQty: 50 });
      await createCustomer(admin, { name: 'Dormant', city: 'Karachi' });
      const busy = await createCustomer(admin, { name: 'Busy', city: 'Karachi' });

      await api()
        .post('/api/orders')
        .set(admin.headers)
        .send({ customer: busy._id, items: [{ product: product._id, quantity: 1 }] });

      stubFilter({
        entity: 'customer',
        conditions: [],
        special: { orderActivity: { type: 'any', withinDays: 30 } },
        sort: { field: 'createdAt', direction: 'desc' },
        limit: 25,
      });

      const res = await api().post('/api/ai-search').set(admin.headers).send({ query: 'x' });

      expect(res.body.count).toBe(1);
      expect(res.body.data[0].name).toBe('Busy');
    });

    it('applies the lowStock special condition to products', async () => {
      const admin = await createAdmin();
      await createProduct({ name: 'Plenty', stockQty: 100, lowStockThreshold: 10 });
      await createProduct({ name: 'Scarce', stockQty: 2, lowStockThreshold: 5 });

      stubFilter({
        entity: 'product',
        conditions: [],
        special: { lowStock: true },
        sort: { field: 'name', direction: 'asc' },
        limit: 25,
      });

      const res = await api().post('/api/ai-search').set(admin.headers).send({ query: 'x' });

      expect(res.body.count).toBe(1);
      expect(res.body.data[0].name).toBe('Scarce');
    });

    it('applies both conditions when two target the same field', async () => {
      const admin = await createAdmin();
      await createProduct({ name: 'Cheap', price: 2 });
      await createProduct({ name: 'Mid', price: 20 });
      await createProduct({ name: 'Pricey', price: 200 });

      stubFilter({
        entity: 'product',
        conditions: [
          { field: 'price', operator: 'gt', value: 5 },
          { field: 'price', operator: 'lt', value: 50 },
        ],
        special: {},
        sort: { field: 'name', direction: 'asc' },
        limit: 25,
      });

      const res = await api().post('/api/ai-search').set(admin.headers).send({ query: 'x' });

      expect(res.body.count).toBe(1);
      expect(res.body.data[0].name).toBe('Mid');
    });

    /**
     * The permission-bypass test. AI search must not become a side door around
     * the role scoping the ordinary list endpoints apply.
     */
    it('applies sales-rep scoping to AI results', async () => {
      const admin = await createAdmin();
      const rep = await createRep();

      await createCustomer(admin, { name: 'Admin Customer', city: 'Karachi' });
      await createCustomer(rep, { name: 'Rep Customer', city: 'Karachi' });

      stubFilter({
        entity: 'customer',
        conditions: [{ field: 'city', operator: 'contains', value: 'Karachi' }],
        special: {},
        sort: { field: 'createdAt', direction: 'desc' },
        limit: 25,
      });

      const asAdmin = await api().post('/api/ai-search').set(admin.headers).send({ query: 'x' });
      const asRep = await api().post('/api/ai-search').set(rep.headers).send({ query: 'x' });

      expect(asAdmin.body.count).toBe(2);
      expect(asRep.body.count).toBe(1);
      expect(asRep.body.data[0].name).toBe('Rep Customer');
    });
  });

  describe('Keyword fallback — tokenising a natural-language question', () => {
    it('strips question scaffolding down to the identifying term', () => {
      expect(tokenize('customers in Karachi with no orders in the last 30 days')).toEqual([
        'karachi',
      ]);
    });

    it('drops bare numbers, which are quantities or timeframes', () => {
      expect(tokenize('orders over 500 in the last 7 days')).toEqual([]);
    });

    it('keeps SKUs and emails intact', () => {
      expect(tokenize('product FURN-001')).toEqual(['furn-001']);
      expect(tokenize('customer sara@example.com')).toEqual(['sara@example.com']);
    });

    it('keeps multiple meaningful terms', () => {
      expect(tokenize('active customers at Acme in Lahore')).toEqual([
        'active',
        'acme',
        'lahore',
      ]);
    });

    it('de-duplicates repeated terms', () => {
      expect(tokenize('Karachi karachi KARACHI')).toEqual(['karachi']);
    });

    it('caps the number of terms', () => {
      expect(tokenize('alpha bravo charlie delta echo foxtrot golf hotel india juliet').length)
        .toBeLessThanOrEqual(8);
    });

    it('returns nothing for a question made entirely of filler', () => {
      expect(tokenize('show me all the customers')).toEqual([]);
    });

    it('infers the entity from the question', () => {
      expect(inferEntity('products running low on stock')).toBe('product');
      expect(inferEntity('recent orders')).toBe('order');
      expect(inferEntity('Karachi Textiles')).toBe('customer');
    });

    it('prefers the entity mentioned first when a question names two', () => {
      // "customers ... with no orders" is a question about customers.
      expect(inferEntity('customers with no orders in the last 30 days')).toBe('customer');
      expect(inferEntity('orders from customers in Karachi')).toBe('order');
    });

    it('lets an explicit entity from the client win', () => {
      expect(inferEntity('anything at all', 'product')).toBe('product');
    });
  });

  describe('POST /api/ai-search — fallback path', () => {
    /**
     * The regression this fixes: the fallback used to match the whole question
     * as one literal string, so a natural-language query — precisely the kind
     * the AI search box invites — always returned nothing.
     */
    it('answers a full natural-language question', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Karachi Textiles', city: 'Karachi' });
      await createCustomer(admin, { name: 'Lahore Fabrics', city: 'Lahore' });

      stubFallback();

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'customers in Karachi with no orders in the last 30 days' });

      expect(res.body.count).toBe(1);
      expect(res.body.data[0].name).toBe('Karachi Textiles');
      // And it reports which words it actually used.
      expect(res.body.terms).toEqual(['karachi']);
    });

    it('matches a record that satisfies any one term', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Acme Corp', city: 'Lahore' });
      await createCustomer(admin, { name: 'Unrelated Ltd', city: 'Quetta' });

      stubFallback();

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'find me Acme or anyone in Quetta' });

      expect(res.body.count).toBe(2);
    });

    it('ranks a record matching more terms first', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Generic Traders', city: 'Karachi' });
      await createCustomer(admin, { name: 'Karachi Textiles', city: 'Karachi', company: 'Textiles' });

      stubFallback();

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'karachi textiles' });

      expect(res.body.count).toBe(2);
      // Matches both terms, so it outranks the one matching only "karachi".
      expect(res.body.data[0].name).toBe('Karachi Textiles');
    });

    it('routes a product question to products', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Widget Fan' });
      await createProduct({ name: 'Standing Desk', category: 'Furniture' });

      stubFallback();

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'which products are Furniture' });

      expect(res.body.entity).toBe('product');
      expect(res.body.count).toBe(1);
      expect(res.body.data[0].name).toBe('Standing Desk');
    });

    it('falls back to customers for an order question, since orders have no text', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Karachi Textiles', city: 'Karachi' });

      stubFallback();

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'orders from Karachi' });

      expect(res.body.entity).toBe('customer');
      expect(res.body.count).toBe(1);
    });

    it('returns recent records rather than nothing for an all-filler question', async () => {
      const admin = await createAdmin();
      await createCustomer(admin);
      await createCustomer(admin);

      stubFallback();

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'show me all the customers' });

      expect(res.body.terms).toEqual([]);
      expect(res.body.count).toBe(2);
    });

    it('still finds a bare SKU, which tokenising alone would discard', async () => {
      const admin = await createAdmin();
      await createProduct({ name: 'Standing Desk', sku: 'FURN-001' });

      stubFallback();

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'FURN-001', entity: 'product' });

      expect(res.body.count).toBe(1);
    });

    it('keeps rep scoping when a question matches many records', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      await createCustomer(admin, { name: 'Admin Co', city: 'Karachi' });
      await createCustomer(rep, { name: 'Rep Co', city: 'Karachi' });

      stubFallback();

      const asRep = await api()
        .post('/api/ai-search')
        .set(rep.headers)
        .send({ query: 'customers in Karachi with no recent orders' });

      expect(asRep.body.count).toBe(1);
      expect(asRep.body.data[0].name).toBe('Rep Co');
    });

    it('falls back to keyword search and says why', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Karachi Co', city: 'Karachi' });
      await createCustomer(admin, { name: 'Lahore Co', city: 'Lahore' });

      stubFallback('GEMINI_API_KEY is not configured');

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'Karachi' });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('fallback');
      expect(res.body.reason).toMatch(/GEMINI_API_KEY/);
      expect(res.body.count).toBe(1);
    });

    it('degrades rather than erroring when the model call fails', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Anything' });

      stubFallback('AI request failed: socket hang up');

      const res = await api().post('/api/ai-search').set(admin.headers).send({ query: 'Any' });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('fallback');
    });

    it('scopes the fallback search to the sales rep too', async () => {
      const admin = await createAdmin();
      const rep = await createRep();
      await createCustomer(admin, { name: 'Shared Term' });
      await createCustomer(rep, { name: 'Shared Term' });

      stubFallback();

      const res = await api().post('/api/ai-search').set(rep.headers).send({ query: 'Shared' });

      expect(res.body.count).toBe(1);
    });

    it('is used when the AI returns a filter that fails validation', async () => {
      const admin = await createAdmin();
      await createCustomer(admin, { name: 'Findable' });

      // This is what translateQuery produces when validateFilter throws.
      stubFallback('AI filter rejected: Unknown field "password" on customer');

      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'Findable' });

      expect(res.body.mode).toBe('fallback');
      expect(res.body.count).toBe(1);
    });
  });

  describe('Request validation', () => {
    it('rejects an empty query', async () => {
      const admin = await createAdmin();
      const res = await api().post('/api/ai-search').set(admin.headers).send({ query: '   ' });
      expect(res.status).toBe(400);
    });

    it('rejects a missing query', async () => {
      const admin = await createAdmin();
      const res = await api().post('/api/ai-search').set(admin.headers).send({});
      expect(res.status).toBe(400);
    });

    it('rejects a query over the length limit', async () => {
      const admin = await createAdmin();
      const res = await api()
        .post('/api/ai-search')
        .set(admin.headers)
        .send({ query: 'x'.repeat(501) });
      expect(res.status).toBe(400);
    });

    it('requires authentication', async () => {
      const res = await api().post('/api/ai-search').send({ query: 'anything' });
      expect(res.status).toBe(401);
    });
  });
});
