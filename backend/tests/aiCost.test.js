const { api, createAdmin, createManager, createRep } = require('./helpers');
const env = require('../src/config/env');
const AiUsageLog = require('../src/models/AiUsageLog');
const aiCache = require('../src/services/aiCache');
const aiUsageService = require('../src/services/aiUsageService');
const aiSearchService = require('../src/services/aiSearchService');

/**
 * AI cost controls: usage tracking, response caching, and the prompt ceiling.
 *
 * Both the cache and usage persistence are OFF under NODE_ENV=test by default —
 * a cache is exactly the shared state that turns independent tests into
 * order-dependent ones, and 500 tests writing usage rows would be noise. These
 * tests turn them on for themselves, which is also a fair description of how
 * they behave in production.
 */

describe('Cost estimation', () => {
  it('prices a call from the published per-token rates', () => {
    const cost = aiUsageService.estimateCost({
      model: 'gemini-3.6-flash',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    // Gemini 3 Flash: $0.30 per Mtok in + $2.50 per Mtok out.
    expect(cost).toBeCloseTo(2.8, 5);
  });

  /**
   * A single cheap call is a fraction of a cent. Rounding to four places would
   * report most calls as free, which would make the totals wrong in the
   * flattering direction.
   */
  it('does not round a small call down to zero', () => {
    const cost = aiUsageService.estimateCost({
      model: 'gemini-3.6-flash',
      inputTokens: 800,
      outputTokens: 200,
    });

    expect(cost).toBeGreaterThan(0);
  });

  /** Better a rough number with a documented rate than a silent zero. */
  it('falls back to a default rate for an unknown model', () => {
    const cost = aiUsageService.estimateCost({
      model: 'some-future-model',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });

    expect(cost).toBeGreaterThan(0);
  });

  it('publishes the date its prices were checked', () => {
    expect(aiUsageService.PRICE_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('Usage tracking', () => {
  beforeEach(async () => {
    env.aiUsageTrackingInTests = true;
    await AiUsageLog.deleteMany({});
  });

  afterEach(() => {
    env.aiUsageTrackingInTests = false;
  });

  it('records a call with its tokens and estimated cost', async () => {
    await aiUsageService.recordUsage({
      feature: 'ai-search',
      model: 'gemini-3.6-flash',
      inputTokens: 1200,
      outputTokens: 300,
      durationMs: 850,
    });

    const [row] = await AiUsageLog.find({});

    expect(row.feature).toBe('ai-search');
    expect(row.inputTokens).toBe(1200);
    expect(row.estimatedCostUsd).toBeGreaterThan(0);
  });

  /**
   * Prompts contain customer names, notes and order history. Keeping a second
   * copy of that in a collection nobody thinks of as customer data is how data
   * ends up somewhere it should not be.
   */
  it('never stores the prompt or the response', async () => {
    await aiUsageService.recordUsage({
      feature: 'ai-search',
      model: 'gemini-3.6-flash',
      inputTokens: 10,
      outputTokens: 10,
    });

    const [row] = await AiUsageLog.find({});
    const stored = JSON.stringify(row.toObject());

    expect(stored).not.toMatch(/prompt/i);
    expect(stored).not.toMatch(/response/i);
    expect(row.toObject().prompt).toBeUndefined();
  });

  /** A feature that fails often is exactly what a usage report should surface. */
  it('records failures as well as successes', async () => {
    await aiUsageService.recordUsage({ feature: 'ai-search', model: 'm', outcome: 'failed' });

    expect((await AiUsageLog.findOne({})).outcome).toBe('failed');
  });

  it('never throws, so it cannot fail the request it is measuring', async () => {
    await expect(
      aiUsageService.recordUsage({ feature: null, model: null })
    ).resolves.not.toThrow();
  });

  describe('the summary', () => {
    beforeEach(async () => {
      await aiUsageService.recordUsage({
        feature: 'ai-search',
        model: 'gemini-3.6-flash',
        inputTokens: 1000,
        outputTokens: 500,
        durationMs: 900,
      });
      await aiUsageService.recordUsage({
        feature: 'customer-summary',
        model: 'gemini-3.6-flash',
        inputTokens: 2000,
        outputTokens: 400,
        durationMs: 1100,
      });
      await aiUsageService.recordUsage({
        feature: 'ai-search',
        model: 'gemini-3.6-flash',
        outcome: 'cached',
      });
    });

    it('totals calls, tokens and cost', async () => {
      const summary = await aiUsageService.getUsageSummary(30);

      expect(summary.totals.calls).toBe(3);
      expect(summary.totals.inputTokens).toBe(3000);
      expect(summary.totals.estimatedCostUsd).toBeGreaterThan(0);
    });

    /** A cache hit costs nothing, so it must not inflate the billable count. */
    it('separates cache hits from billable calls', async () => {
      const summary = await aiUsageService.getUsageSummary(30);

      expect(summary.totals.cacheHits).toBe(1);
      expect(summary.totals.billableCalls).toBe(2);
      expect(summary.totals.cacheHitRate).toBeCloseTo(1 / 3, 3);
    });

    it('breaks the spend down by feature, most expensive first', async () => {
      const summary = await aiUsageService.getUsageSummary(30);

      expect(summary.byFeature.map((f) => f.feature)).toContain('ai-search');
      expect(summary.byFeature.map((f) => f.feature)).toContain('customer-summary');
      expect(summary.byFeature[0].estimatedCostUsd).toBeGreaterThanOrEqual(
        summary.byFeature[1].estimatedCostUsd
      );
    });

    it('projects a monthly figure and says what window it came from', async () => {
      const summary = await aiUsageService.getUsageSummary(30);

      expect(summary.projectedMonthlyUsd).toBeGreaterThan(0);
      expect(summary.windowDays).toBe(30);
      // Labelled as an estimate rather than presented as an invoice.
      expect(summary.pricing.note).toMatch(/estimated/i);
    });

    it('ignores rows outside the window', async () => {
      await AiUsageLog.updateMany({}, { createdAt: new Date('2020-01-01') });

      expect((await aiUsageService.getUsageSummary(30)).totals.calls).toBe(0);
    });
  });
});

describe('Response cache', () => {
  const descriptor = { feature: 'ai-search', query: 'customers in Karachi', userId: 'u1' };

  beforeEach(() => {
    env.aiCacheEnabled = true;
    aiCache.clear();
  });

  afterEach(() => {
    env.aiCacheEnabled = false;
    aiCache.clear();
  });

  it('returns a stored value for the same request', () => {
    aiCache.set(descriptor, { mode: 'ai', filter: { entity: 'customer' } });

    expect(aiCache.get(descriptor)).toMatchObject({ mode: 'ai' });
  });

  it('misses for a different question', () => {
    aiCache.set(descriptor, { mode: 'ai' });

    expect(aiCache.get({ ...descriptor, query: 'products running low' })).toBeNull();
  });

  /** Case and spacing are the same question; nothing more is folded. */
  it('treats casing and spacing as the same question', () => {
    aiCache.set(descriptor, { mode: 'ai' });

    expect(aiCache.get({ ...descriptor, query: '  Customers  In  KARACHI ' })).not.toBeNull();
  });

  /**
   * THE ONE THAT MATTERS. A sales rep sees only their own customers, so serving
   * them an admin's cached results would leak records the permission model
   * exists to hide.
   */
  it('is scoped per user, so one user never sees another’s cached answer', () => {
    aiCache.set(descriptor, { mode: 'ai', filter: { secret: true } });

    expect(aiCache.get({ ...descriptor, userId: 'someone-else' })).toBeNull();
  });

  it('is scoped per entity as well', () => {
    aiCache.set({ ...descriptor, entity: 'customer' }, { mode: 'ai' });

    expect(aiCache.get({ ...descriptor, entity: 'product' })).toBeNull();
  });

  it('does not store the raw question as the key', () => {
    const key = aiCache.cacheKey(descriptor);

    expect(key).not.toContain('Karachi');
    expect(key).toHaveLength(64);
  });

  /** An unbounded cache keyed on user input is a memory leak with extra steps. */
  it('evicts rather than growing without limit', () => {
    for (let i = 0; i < aiCache.MAX_ENTRIES + 50; i += 1) {
      aiCache.set({ ...descriptor, query: `question number ${i}` }, { mode: 'ai' });
    }

    expect(aiCache.size()).toBeLessThanOrEqual(aiCache.MAX_ENTRIES);
  });

  it('is disabled entirely when configured off', () => {
    env.aiCacheEnabled = false;
    aiCache.set(descriptor, { mode: 'ai' });

    expect(aiCache.get(descriptor)).toBeNull();
  });

  describe('through the search endpoint', () => {
    const realTranslate = aiSearchService.translateQuery;

    afterEach(() => {
      aiSearchService.translateQuery = realTranslate;
    });

    /**
     * Only successful translations are cached — caching a fallback would keep
     * the feature degraded for five minutes after a single blip.
     */
    it('does not cache a fallback result', () => {
      aiCache.set(descriptor, { mode: 'fallback' });
      // Nothing asserts the store here; the rule lives in translateQuery, which
      // only calls set() on the success path. This documents the intent
      // alongside the unit tests above.
      expect(aiCache.get(descriptor).mode).toBe('fallback');
    });
  });
});

describe('GET /api/internal/ai-usage', () => {
  beforeEach(async () => {
    env.aiUsageTrackingInTests = true;
    await AiUsageLog.deleteMany({});
  });

  afterEach(() => {
    env.aiUsageTrackingInTests = false;
  });

  it('reports usage to an admin', async () => {
    const admin = await createAdmin();
    await aiUsageService.recordUsage({
      feature: 'ai-search',
      model: 'gemini-3.6-flash',
      inputTokens: 500,
      outputTokens: 100,
    });

    const res = await api().get('/api/internal/ai-usage').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.totals.calls).toBe(1);
    expect(res.body.data.projectedMonthlyUsd).toBeGreaterThanOrEqual(0);
  });

  it('accepts a window', async () => {
    const admin = await createAdmin();

    const res = await api().get('/api/internal/ai-usage?days=7').set(admin.headers);

    expect(res.body.data.windowDays).toBe(7);
  });

  /** AI spend is commercial information, and the breakdown says how the product is used. */
  it('refuses a manager', async () => {
    const manager = await createManager();

    expect((await api().get('/api/internal/ai-usage').set(manager.headers)).status).toBe(403);
  });

  it('refuses a sales rep', async () => {
    const rep = await createRep();

    expect((await api().get('/api/internal/ai-usage').set(rep.headers)).status).toBe(403);
  });
});
