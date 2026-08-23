const aiClient = require('../src/services/aiClient');
const { getAiStatus } = require('../src/services/aiStatus');
const aiUsageService = require('../src/services/aiUsageService');
const env = require('../src/config/env');
const { api, createAdmin, createManager, createRep } = require('./helpers');

/**
 * Reporting whether the AI is actually running.
 *
 * THE FAILURE THIS EXISTS FOR.
 *
 * GEMINI_API_KEY was never set in production, so every AI feature had been
 * silently running its non-AI fallback. Nothing broke: AI search returned
 * results, they were keyword results behind a label that said AI, and every
 * response was a 200. The only evidence anywhere was a `mode` field on
 * individual responses.
 *
 * These tests pin the two things that were missing — a way to ask the system
 * what state it is in, and a report that distinguishes "not configured" from
 * "configured and failing", because those have completely different fixes.
 */

const stubUsage = (totals) => {
  aiUsageService.getUsageSummary = async () => ({ totals });
};

describe('getAiStatus', () => {
  const realIsConfigured = aiClient.isConfigured;
  const realGetUsage = aiUsageService.getUsageSummary;
  const realKey = env.geminiApiKey;

  afterEach(() => {
    aiClient.isConfigured = realIsConfigured;
    aiUsageService.getUsageSummary = realGetUsage;
    env.geminiApiKey = realKey;
  });

  describe('when the key is missing', () => {
    beforeEach(() => {
      aiClient.isConfigured = () => false;
      env.geminiApiKey = '';
      stubUsage({ calls: 0, cacheHits: 0, failedCalls: 0 });
    });

    it('reports that the next request will fall back', async () => {
      const status = await getAiStatus();

      expect(status.configured).toBe(false);
      expect(status.keyPresent).toBe(false);
      expect(status.mode).toBe('fallback');
    });

    /** The summary has to name the variable, or it is not actionable. */
    it('says which variable to set', async () => {
      const status = await getAiStatus();

      expect(status.summary).toMatch(/GEMINI_API_KEY is not set/i);
      expect(status.summary).toMatch(/keyword search/i);
    });
  });

  /**
   * A key that is present but unusable is a different problem from no key at
   * all, and a single "AI unavailable" would send someone to check the wrong
   * one.
   */
  it('distinguishes a set-but-unusable key from a missing one', async () => {
    aiClient.isConfigured = () => false;
    env.geminiApiKey = '   ';
    stubUsage({ calls: 0, cacheHits: 0, failedCalls: 0 });

    const status = await getAiStatus();

    expect(status.keyPresent).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.summary).toMatch(/set but was not usable/i);
  });

  describe('when the key is configured', () => {
    beforeEach(() => {
      aiClient.isConfigured = () => true;
      env.geminiApiKey = 'AIzaSy-test-key';
    });

    it('reports that the next request will use the AI', async () => {
      stubUsage({ calls: 10, cacheHits: 2, failedCalls: 0 });

      const status = await getAiStatus();

      expect(status.configured).toBe(true);
      expect(status.mode).toBe('ai');
      expect(status.summary).toMatch(/configured and working/i);
    });

    /**
     * Configuration and health are separate questions. A valid key out of
     * credit is configured and completely broken, and reporting only the first
     * would be the same class of blind spot this endpoint exists to remove.
     */
    it('reports a configured key whose calls are all failing', async () => {
      stubUsage({ calls: 5, cacheHits: 0, failedCalls: 5 });

      const status = await getAiStatus();

      expect(status.configured).toBe(true);
      expect(status.recent.failed).toBe(5);
      expect(status.recent.succeeded).toBe(0);
      expect(status.summary).toMatch(/every one of the last 5 calls failed/i);
    });

    /**
     * Cache hits never reach the API, so counting them as successes would make
     * a wholly broken key look healthy for as long as the cache stayed warm.
     */
    it('does not count cache hits as successful calls', async () => {
      stubUsage({ calls: 10, cacheHits: 8, failedCalls: 2 });

      const status = await getAiStatus();

      expect(status.recent.cached).toBe(8);
      expect(status.recent.failed).toBe(2);
      expect(status.recent.succeeded).toBe(0);
    });

    it('says so plainly when nothing has been tried yet', async () => {
      stubUsage({ calls: 0, cacheHits: 0, failedCalls: 0 });

      expect((await getAiStatus()).summary).toMatch(/no calls have been made/i);
    });
  });

  /**
   * This is the endpoint someone calls when things are already broken. It
   * failing would be its own small tragedy, so a usage lookup that cannot reach
   * the database still yields a useful configuration answer.
   */
  it('still answers when the usage history cannot be read', async () => {
    aiClient.isConfigured = () => false;
    env.geminiApiKey = '';
    aiUsageService.getUsageSummary = async () => {
      throw new Error('database unavailable');
    };

    const status = await getAiStatus();

    expect(status.configured).toBe(false);
    expect(status.recent.available).toBe(false);
    expect(status.summary).toMatch(/GEMINI_API_KEY/);
  });
});

describe('GET /api/internal/ai-status', () => {
  const realGetUsage = aiUsageService.getUsageSummary;

  beforeEach(() => {
    stubUsage({ calls: 0, cacheHits: 0, failedCalls: 0 });
  });

  afterEach(() => {
    aiUsageService.getUsageSummary = realGetUsage;
  });

  it('reports the current mode to an admin', async () => {
    const admin = await createAdmin();

    const res = await api().get('/api/internal/ai-status').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      configured: expect.any(Boolean),
      mode: expect.stringMatching(/^(ai|fallback)$/),
      summary: expect.any(String),
    });
  });

  /**
   * It reports nothing secret, but it does describe the deployment's
   * internals, and an unauthenticated "is your AI down" probe is a gift to
   * nobody useful.
   */
  it('is refused to a manager and a sales rep', async () => {
    const manager = await createManager();
    const rep = await createRep();

    expect((await api().get('/api/internal/ai-status').set(manager.headers)).status).toBe(403);
    expect((await api().get('/api/internal/ai-status').set(rep.headers)).status).toBe(403);
  });

  it('is refused to an anonymous caller', async () => {
    expect((await api().get('/api/internal/ai-status')).status).toBe(401);
  });

  /** The key itself must never appear in the response, in any form. */
  it('never returns the key', async () => {
    const admin = await createAdmin();
    const realKey = env.geminiApiKey;
    env.geminiApiKey = 'AIzaSy-super-secret-value';

    try {
      const res = await api().get('/api/internal/ai-status').set(admin.headers);

      expect(JSON.stringify(res.body)).not.toContain('AIzaSy-super-secret-value');
      expect(JSON.stringify(res.body)).not.toContain('secret');
    } finally {
      env.geminiApiKey = realKey;
    }
  });
});
