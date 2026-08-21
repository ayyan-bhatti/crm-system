const { assessChurnRisk, typicalGapDays } = require('../src/services/churnRisk');
const { api, createManager, createCustomer, createProduct } = require('./helpers');
const customerSummaryService = require('../src/services/customerSummaryService');
const Order = require('../src/models/Order');

/**
 * Churn risk.
 *
 * The design claim being tested is that risk is measured against each
 * customer's OWN ordering cadence rather than a fixed threshold. Most of these
 * tests are two customers with identical silence and different rhythms, which
 * a flat "90 days = at risk" rule would score identically and wrongly.
 */

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/** Metrics shaped the way computeCustomerMetrics returns them. */
const metrics = ({ orders = 0, sinceDays = null, firstDays = null, trend = 'steady' }) => ({
  completedCount: orders,
  daysSinceLastOrder: sinceDays,
  firstOrderDate: firstDays === null ? null : daysAgo(firstDays),
  lastOrderDate: sinceDays === null ? null : daysAgo(sinceDays),
  trend,
});

describe('typicalGapDays', () => {
  it('averages across the whole relationship', () => {
    // 10 orders spanning 300 days = 9 gaps of about 33 days.
    const gap = typicalGapDays({
      completedCount: 10,
      firstOrderDate: daysAgo(310),
      lastOrderDate: daysAgo(10),
    });

    expect(gap).toBeCloseTo(300 / 9, 0);
  });

  /**
   * Between the last two orders would be wrong: two orders a day apart during
   * one busy week would suggest a one-day cadence and flag the customer as
   * catastrophically overdue by Thursday.
   */
  it('is not thrown off by two orders close together', () => {
    const gap = typicalGapDays({
      completedCount: 3,
      firstOrderDate: daysAgo(200),
      lastOrderDate: daysAgo(10),
    });

    expect(gap).toBeGreaterThan(80);
  });

  it('reports no cadence for a single order', () => {
    expect(
      typicalGapDays({ completedCount: 1, firstOrderDate: daysAgo(30), lastOrderDate: daysAgo(30) })
    ).toBeNull();
  });

  /** Several orders on one day would otherwise imply an infinite overdue ratio. */
  it('reports no cadence when every order landed the same day', () => {
    const sameDay = daysAgo(30);
    expect(
      typicalGapDays({ completedCount: 5, firstOrderDate: sameDay, lastOrderDate: sameDay })
    ).toBeNull();
  });
});

describe('assessChurnRisk', () => {
  /**
   * THE TEST THE WHOLE DESIGN EXISTS FOR.
   *
   * Two customers, both silent for exactly 90 days. A fixed threshold scores
   * them the same. Their own rhythms say one is four cycles overdue and the
   * other is exactly where they always are.
   */
  it('separates two customers with identical silence but different rhythms', () => {
    const frequent = assessChurnRisk(
      metrics({ orders: 12, sinceDays: 90, firstDays: 90 + 11 * 21 })
    );
    const annual = assessChurnRisk(
      metrics({ orders: 4, sinceDays: 90, firstDays: 90 + 3 * 365 })
    );

    expect(frequent.level).toBe('high');
    expect(annual.level).toBe('low');
  });

  it('flags a customer several cycles overdue as high risk', () => {
    const risk = assessChurnRisk(metrics({ orders: 10, sinceDays: 120, firstDays: 120 + 9 * 30 }));

    expect(risk.level).toBe('high');
    expect(risk.gapsOverdue).toBeGreaterThanOrEqual(3);
  });

  it('flags a moderately overdue customer without crying wolf', () => {
    const risk = assessChurnRisk(metrics({ orders: 10, sinceDays: 60, firstDays: 60 + 9 * 30 }));

    expect(risk.level).toBe('moderate');
  });

  it('leaves an on-schedule customer alone', () => {
    const risk = assessChurnRisk(metrics({ orders: 10, sinceDays: 20, firstDays: 20 + 9 * 30 }));

    expect(risk.level).toBe('low');
  });

  /**
   * The cadence measure alone would never notice someone ordering on time for
   * steadily less money — which is leaving slowly.
   */
  it('raises a customer who is on schedule but spending less', () => {
    const risk = assessChurnRisk(
      metrics({ orders: 10, sinceDays: 20, firstDays: 20 + 9 * 30, trend: 'declining' })
    );

    expect(risk.level).toBe('moderate');
    expect(risk.reason).toMatch(/spend has fallen/i);
  });

  /**
   * Never bought anything is not churn — there is no relationship to lose. It
   * is an unconverted lead, and calling it "low risk" on a screen used to
   * decide who to chase would be technically true and actively misleading.
   */
  it('does not call a customer with no orders low risk', () => {
    const risk = assessChurnRisk(metrics({ orders: 0 }));

    expect(risk.level).toBe('unknown');
    expect(risk.reason).toMatch(/not completed an order/i);
  });

  describe('a single order, where there is no cadence to measure', () => {
    it('is generous with a recent first purchase', () => {
      const risk = assessChurnRisk(metrics({ orders: 1, sinceDays: 30, firstDays: 30 }));

      expect(risk.level).toBe('low');
      expect(risk.label).toMatch(/too early/i);
    });

    it('notices one that was never repeated', () => {
      const risk = assessChurnRisk(metrics({ orders: 1, sinceDays: 150, firstDays: 150 }));

      expect(risk.level).toBe('moderate');
    });

    it('gives up on a very old single order', () => {
      const risk = assessChurnRisk(metrics({ orders: 1, sinceDays: 300, firstDays: 300 }));

      expect(risk.level).toBe('high');
    });
  });

  /**
   * The explanation is the feature. A flag a rep cannot interrogate is one they
   * learn to ignore.
   */
  it('always explains itself with checkable facts', () => {
    const risk = assessChurnRisk(metrics({ orders: 10, sinceDays: 120, firstDays: 120 + 9 * 30 }));

    expect(risk.reason).toMatch(/every \d+ days?/);
    expect(risk.reason).toContain('120');
    expect(risk.label).toEqual(expect.any(String));
  });

  it('is deterministic', () => {
    const input = metrics({ orders: 8, sinceDays: 45, firstDays: 45 + 7 * 25 });

    expect(assessChurnRisk(input)).toEqual(assessChurnRisk(input));
  });
});

describe('churn risk on the summary endpoint', () => {
  const realGenerate = customerSummaryService.generateSummary;

  afterEach(() => {
    customerSummaryService.generateSummary = realGenerate;
  });

  let manager;
  let customer;
  let product;

  beforeEach(async () => {
    manager = await createManager();
    customer = await createCustomer(manager);
    product = await createProduct({ price: 100, stockQty: 1000 });

    customerSummaryService.generateSummary = async () => ({ mode: 'fallback', reason: 'stubbed' });
  });

  const placeOrder = (createdAt) =>
    Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: 100 }],
      total: 100,
      status: 'completed',
      completedAt: createdAt,
      createdBy: manager.user._id,
      createdAt,
    });

  it('is returned alongside the metrics and health score', async () => {
    await placeOrder(daysAgo(60));
    await placeOrder(daysAgo(30));

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.churn).toMatchObject({
      level: expect.any(String),
      label: expect.any(String),
      reason: expect.any(String),
    });
  });

  it('flags a customer who has stopped ordering', async () => {
    // Monthly for half a year, then silence for four months.
    for (let i = 0; i < 6; i += 1) await placeOrder(daysAgo(300 - i * 30));

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.churn.level).toBe('high');
  });

  it('does not flag a customer who is ordering normally', async () => {
    for (let i = 0; i < 6; i += 1) await placeOrder(daysAgo(160 - i * 30));

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.churn.level).toBe('low');
  });

  /**
   * The score and the risk answer different questions and are allowed to
   * disagree — a valuable customer who has gone quiet is exactly the case that
   * matters, and a single number cannot express it.
   */
  it('can report a healthy score and a high churn risk together', async () => {
    for (let i = 0; i < 12; i += 1) await placeOrder(daysAgo(400 - i * 20));

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.health.score).toBeGreaterThan(0);
    expect(res.body.data.churn.level).toBe('high');
  });

  it('is available even when the AI narrative fails', async () => {
    await placeOrder(daysAgo(30));

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.mode).toBe('fallback');
    expect(res.body.data.churn.level).toBeDefined();
  });
});
