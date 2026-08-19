const { api, createManager, createRep, createCustomer, createProduct } = require('./helpers');
const { calculateLeadScore, WEIGHTS } = require('../src/services/leadScore');
const customerSummaryService = require('../src/services/customerSummaryService');
const Order = require('../src/models/Order');

/**
 * Customer health score.
 *
 * This is the file that only exists because the score is computed rather than
 * generated. "Is 82 the right score for this customer?" has an answer, and
 * these tests are it — the same question about a model's output would have no
 * answer at all, which is the argument for the design in one sentence.
 */

/** Shorthand for the three inputs the score actually depends on. */
const metrics = ({ days = null, orders = 0, revenue = 0 }) => ({
  daysSinceLastOrder: days,
  completedCount: orders,
  totalRevenue: revenue,
});

describe('calculateLeadScore', () => {
  /**
   * The property that makes it a metric rather than a mood: the same input
   * always gives the same output. A model cannot promise this.
   */
  it('is deterministic', () => {
    const input = metrics({ days: 20, orders: 5, revenue: 8000 });

    const first = calculateLeadScore(input);
    const second = calculateLeadScore(input);

    expect(first.score).toBe(second.score);
  });

  it('scores an ideal customer at the top', () => {
    const result = calculateLeadScore(metrics({ days: 5, orders: 20, revenue: 50000 }));

    expect(result.score).toBe(100);
    expect(result.band).toBe('healthy');
  });

  it('scores a customer with no history at the bottom', () => {
    const result = calculateLeadScore(metrics({ days: null, orders: 0, revenue: 0 }));

    expect(result.score).toBe(0);
    expect(result.band).toBe('dormant');
  });

  it('keeps every score within 0-100', () => {
    const extremes = [
      metrics({ days: 0, orders: 1000, revenue: 10_000_000 }),
      metrics({ days: 99999, orders: 0, revenue: 0 }),
      metrics({ days: 45, orders: 3, revenue: 2500 }),
    ];

    extremes.forEach((input) => {
      const { score } = calculateLeadScore(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  /**
   * THE TEST THAT JUSTIFIES THE WEIGHTS.
   *
   * Revenue is the most visible number and the most misleading one alone. A
   * single large order from someone who never came back must not outrank a
   * steady, smaller account — that is the entire reason monetary is weighted
   * lowest and recency highest.
   */
  it('ranks a steady small customer above a one-off big spender who lapsed', () => {
    const steady = calculateLeadScore(metrics({ days: 25, orders: 6, revenue: 3000 }));
    const lapsedWhale = calculateLeadScore(metrics({ days: 300, orders: 1, revenue: 30000 }));

    expect(steady.score).toBeGreaterThan(lapsedWhale.score);
  });

  it('drops the score as a customer goes quiet, all else equal', () => {
    const recent = calculateLeadScore(metrics({ days: 15, orders: 5, revenue: 5000 }));
    const stale = calculateLeadScore(metrics({ days: 200, orders: 5, revenue: 5000 }));

    expect(stale.score).toBeLessThan(recent.score);
  });

  it('raises the score with repeat business, all else equal', () => {
    const once = calculateLeadScore(metrics({ days: 20, orders: 1, revenue: 5000 }));
    const often = calculateLeadScore(metrics({ days: 20, orders: 10, revenue: 5000 }));

    expect(often.score).toBeGreaterThan(once.score);
  });

  /**
   * Monetary is scored against a fixed ladder, not against other customers, so
   * one customer's score never moves because someone ELSE placed an order.
   * That would be impossible to explain to the person looking at it.
   */
  it('does not depend on any other customer', () => {
    const input = metrics({ days: 20, orders: 5, revenue: 5000 });
    // No database access at all — the function takes only this customer's own
    // figures, which is what makes the guarantee structural rather than tested.
    expect(calculateLeadScore(input).score).toBe(calculateLeadScore(input).score);
    expect(calculateLeadScore.length).toBe(1);
  });

  describe('the breakdown', () => {
    /**
     * The breakdown is not debug output — it is the feature. A rep asking "why
     * is this account at 41?" deserves "the last order was 140 days ago".
     */
    it('explains every component', () => {
      const { components } = calculateLeadScore(metrics({ days: 140, orders: 4, revenue: 6000 }));

      expect(components.map((c) => c.key)).toEqual(['recency', 'frequency', 'monetary']);
      components.forEach((component) => {
        expect(component.detail).toEqual(expect.any(String));
        expect(component.score).toBeGreaterThanOrEqual(0);
      });
    });

    it('names the specific reason in the recency detail', () => {
      const { components } = calculateLeadScore(metrics({ days: 140, orders: 4, revenue: 6000 }));
      const recency = components.find((c) => c.key === 'recency');

      expect(recency.detail).toBe('Last ordered 140 days ago');
    });

    it('adds up to the reported score', () => {
      const result = calculateLeadScore(metrics({ days: 45, orders: 4, revenue: 6000 }));

      const recomputed = Math.round(
        result.components.reduce((total, c) => total + c.score * c.weight, 0)
      );

      expect(recomputed).toBe(result.score);
    });

    it('uses weights that sum to 1', () => {
      const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1);
    });
  });

  describe('bands', () => {
    it('labels each range', () => {
      expect(calculateLeadScore(metrics({ days: 5, orders: 10, revenue: 30000 })).band).toBe(
        'healthy'
      );
      expect(calculateLeadScore(metrics({ days: 150, orders: 4, revenue: 6000 })).band).toBe(
        'stable'
      );
      expect(calculateLeadScore(metrics({ days: 200, orders: 2, revenue: 1500 })).band).toBe(
        'at_risk'
      );
      expect(calculateLeadScore(metrics({ days: null, orders: 0, revenue: 0 })).band).toBe(
        'dormant'
      );
    });
  });
});

describe('the score on the summary endpoint', () => {
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

    customerSummaryService.generateSummary = async () => ({
      mode: 'fallback',
      reason: 'stubbed',
    });
  });

  const placeOrder = (total, createdAt = new Date()) =>
    Order.create({
      customer: customer._id,
      items: [{ product: product._id, quantity: 1, priceAtOrder: total }],
      total,
      status: 'completed',
      completedAt: createdAt,
      createdBy: manager.user._id,
      createdAt,
    });

  it('returns the score with its breakdown', async () => {
    await placeOrder(2000);

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.health.score).toEqual(expect.any(Number));
    expect(res.body.data.health.band).toEqual(expect.any(String));
    expect(res.body.data.health.components).toHaveLength(3);
  });

  /**
   * The score is computed before the AI call and does not depend on it, so an
   * AI outage costs the wording and not the number.
   */
  it('is present even when the AI narrative fails', async () => {
    await placeOrder(2000);

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.mode).toBe('fallback');
    expect(res.body.data.health.score).toBeGreaterThan(0);
  });

  it('is zero for a customer who has never ordered', async () => {
    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.body.data.health.score).toBe(0);
    expect(res.body.data.health.band).toBe('dormant');
  });

  /** Two identical requests must return the same score. */
  it('returns the same score on a repeat request', async () => {
    await placeOrder(2000);

    const first = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);
    const second = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(first.body.data.health.score).toBe(second.body.data.health.score);
  });

  it('respects the same access rules as the customer record', async () => {
    const stranger = await createRep();

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(stranger.headers);

    expect(res.status).toBe(403);
  });
});
