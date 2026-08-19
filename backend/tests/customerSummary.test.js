const { api, createManager, createRep, createCustomer, createProduct } = require('./helpers');
const customerSummaryService = require('../src/services/customerSummaryService');
const { computeCustomerMetrics } = require('../src/services/customerMetrics');
const { validateSummary, MAX_SUMMARY } = customerSummaryService;
const Order = require('../src/models/Order');

/**
 * AI customer summary.
 *
 * The model is never called — `generateSummary` is stubbed, so the suite is
 * fast, deterministic and needs no API key. What is being tested is everything
 * around the model, and one thing in particular: that the FIGURES are computed
 * by us and are right, whatever the model does or fails to do.
 */

describe('Customer metrics', () => {
  let manager;
  let customer;
  let product;

  beforeEach(async () => {
    manager = await createManager();
    customer = await createCustomer(manager);
    product = await createProduct({ price: 100, stockQty: 1000 });
  });

  /** Place an order directly, so status and date can be set precisely. */
  const placeOrder = (total, status = 'completed', createdAt = new Date()) =>
    Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: total }],
      total,
      status,
      completedAt: status === 'completed' ? createdAt : null,
      createdBy: manager.user._id,
      createdAt,
    });

  const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  it('returns zeroes for a customer with no orders', async () => {
    const metrics = await computeCustomerMetrics(customer._id);

    expect(metrics).toMatchObject({
      orderCount: 0,
      totalRevenue: 0,
      averageOrderValue: 0,
      lastOrderDate: null,
      daysSinceLastOrder: null,
      trend: 'no_orders',
    });
  });

  it('sums revenue from completed orders', async () => {
    await placeOrder(100);
    await placeOrder(250);

    const metrics = await computeCustomerMetrics(customer._id);

    expect(metrics.totalRevenue).toBe(350);
    expect(metrics.averageOrderValue).toBe(175);
  });

  /**
   * Pending money is not revenue — it can still be cancelled — and counting it
   * would make the summary optimistic in exactly the case where accuracy
   * matters.
   */
  it('excludes pending and cancelled orders from revenue', async () => {
    await placeOrder(100, 'completed');
    await placeOrder(500, 'pending');
    await placeOrder(900, 'cancelled');

    const metrics = await computeCustomerMetrics(customer._id);

    expect(metrics.totalRevenue).toBe(100);
    // ...but they still count as orders. "They placed 3 orders" is true, and
    // hiding the cancellations would misrepresent the relationship.
    expect(metrics.orderCount).toBe(3);
    expect(metrics.cancelledCount).toBe(1);
  });

  it('reports how long ago the last order was', async () => {
    await placeOrder(100, 'completed', daysAgo(10));

    const metrics = await computeCustomerMetrics(customer._id);

    expect(metrics.daysSinceLastOrder).toBe(10);
  });

  describe('trend', () => {
    it('is "rising" when recent revenue is well above the previous window', async () => {
      await placeOrder(100, 'completed', daysAgo(120));
      await placeOrder(500, 'completed', daysAgo(10));

      expect((await computeCustomerMetrics(customer._id)).trend).toBe('rising');
    });

    it('is "declining" when recent revenue has dropped', async () => {
      await placeOrder(500, 'completed', daysAgo(120));
      await placeOrder(100, 'completed', daysAgo(10));

      expect((await computeCustomerMetrics(customer._id)).trend).toBe('declining');
    });

    it('is "steady" for a small change', async () => {
      await placeOrder(100, 'completed', daysAgo(120));
      await placeOrder(105, 'completed', daysAgo(10));

      expect((await computeCustomerMetrics(customer._id)).trend).toBe('steady');
    });

    it('is "new" when there is no earlier window to compare against', async () => {
      await placeOrder(100, 'completed', daysAgo(5));

      expect((await computeCustomerMetrics(customer._id)).trend).toBe('new');
    });

    it('is "dormant" when nothing has happened in either window', async () => {
      await placeOrder(100, 'completed', daysAgo(400));

      expect((await computeCustomerMetrics(customer._id)).trend).toBe('dormant');
    });
  });

  /** Only this customer's orders — a summary that leaked another's would be a bug. */
  it('counts only the orders belonging to this customer', async () => {
    const other = await createCustomer(manager);
    await placeOrder(100);
    await Order.create({
      customer: other._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: 999 }],
      total: 999,
      status: 'completed',
      createdBy: manager.user._id,
    });

    expect((await computeCustomerMetrics(customer._id)).totalRevenue).toBe(100);
  });
});

describe('validateSummary', () => {
  const valid = {
    headline: 'Growing account',
    summary: 'They order regularly and spending is up.',
    recommendedAction: 'Discuss a recurring order.',
    confidence: 'high',
  };

  it('accepts a well-formed response', () => {
    expect(validateSummary(valid)).toMatchObject(valid);
  });

  it('rejects a response missing the headline', () => {
    expect(validateSummary({ ...valid, headline: undefined })).toBeNull();
  });

  it('rejects a response missing the summary', () => {
    expect(validateSummary({ ...valid, summary: '   ' })).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(validateSummary('a sentence')).toBeNull();
    expect(validateSummary(null)).toBeNull();
  });

  it('defaults an unrecognised confidence to the lowest value', () => {
    expect(validateSummary({ ...valid, confidence: 'extremely' }).confidence).toBe('low');
  });

  it('truncates text rather than letting one odd response flood the UI', () => {
    const long = validateSummary({ ...valid, summary: 'x'.repeat(5000) });
    expect(long.summary.length).toBe(MAX_SUMMARY);
  });

  /**
   * The most important assertion in this file.
   *
   * The response schema has no numeric fields at all, so a figure the model
   * invented has nowhere to land. A prompt instruction would be a request; the
   * schema is the guarantee.
   */
  it('discards any number the model tried to include', () => {
    const result = validateSummary({
      ...valid,
      totalRevenue: 999999,
      orderCount: 42,
      score: 88,
    });

    expect(result.totalRevenue).toBeUndefined();
    expect(result.orderCount).toBeUndefined();
    expect(result.score).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual([
      'confidence',
      'headline',
      'recommendedAction',
      'summary',
    ]);
  });
});

describe('GET /api/customers/:id/summary', () => {
  const realGenerate = customerSummaryService.generateSummary;

  afterEach(() => {
    customerSummaryService.generateSummary = realGenerate;
  });

  function stubAi(overrides = {}) {
    customerSummaryService.generateSummary = async () => ({
      mode: 'ai',
      headline: 'Growing account',
      summary: 'They order regularly and spending is up.',
      recommendedAction: 'Discuss a recurring order.',
      confidence: 'high',
      ...overrides,
    });
  }

  function stubFailure(reason = 'stubbed failure') {
    customerSummaryService.generateSummary = async () => ({ mode: 'fallback', reason });
  }

  let manager;
  let customer;

  beforeEach(async () => {
    manager = await createManager();
    customer = await createCustomer(manager, { name: 'Acme Ltd' });
    stubAi();
  });

  it('returns the metrics and the narrative together', async () => {
    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.metrics).toBeDefined();
    expect(res.body.data.summary.headline).toBe('Growing account');
    expect(res.body.data.mode).toBe('ai');
  });

  /**
   * The whole point of the design: the figures come from the database, so an AI
   * failure costs the wording and nothing else.
   */
  it('still returns correct figures when the AI call fails', async () => {
    const product = await createProduct({ price: 100, stockQty: 100 });
    await Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: 250 }],
      total: 250,
      status: 'completed',
      createdBy: manager.user._id,
    });

    stubFailure();

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.metrics.totalRevenue).toBe(250);
    expect(res.body.data.summary.headline).toBeTruthy();
    expect(res.body.data.summary.summary).toContain('250');
  });

  /**
   * A generated sentence and a templated one look identical on screen. Letting
   * a reader assume the first when it is the second is the small dishonesty
   * that costs trust in the whole feature.
   */
  it('says which mode produced the summary', async () => {
    stubFailure('no API key');

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.mode).toBe('fallback');
    expect(res.body.data.fallbackReason).toBe('no API key');
  });

  it('writes a sensible fallback for a customer with no orders', async () => {
    stubFailure();

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.summary.headline).toBe('No orders yet');
    expect(res.body.data.summary.confidence).toBe('low');
  });

  /** A summary is a view of the record, so it cannot bypass the record's rules. */
  it('refuses a sales rep who cannot see the customer', async () => {
    const stranger = await createRep();

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(stranger.headers);

    expect(res.status).toBe(403);
  });

  it('allows a sales rep their own customer', async () => {
    const rep = await createRep();
    const own = await createCustomer(rep);

    const res = await api().get(`/api/customers/${own._id}/summary`).set(rep.headers);

    expect(res.status).toBe(200);
  });

  it('requires authentication', async () => {
    const res = await api().get(`/api/customers/${customer._id}/summary`);
    expect(res.status).toBe(401);
  });

  it('404s for a customer that does not exist', async () => {
    const res = await api()
      .get('/api/customers/507f1f77bcf86cd799439011/summary')
      .set(manager.headers);

    expect(res.status).toBe(404);
  });
});
