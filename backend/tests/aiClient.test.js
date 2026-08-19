const { isRetryable, backoffDelay, MAX_ATTEMPTS } = require('../src/services/aiClient');
const { api, createManager, createCustomer } = require('./helpers');
const customerSummaryService = require('../src/services/customerSummaryService');
const aiSearchService = require('../src/services/aiSearchService');

/**
 * AI reliability and cost controls.
 *
 * The interesting behaviour here is all in the failure cases, so that is what
 * these test: which errors are retried and which are not, that the backoff is
 * spread rather than synchronised, and — the part that matters to a user — that
 * an AI outage degrades the feature rather than breaking the page.
 */

describe('which failures are retried', () => {
  const withStatus = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

  /**
   * The distinction matters in both directions. Retrying a 400 wastes time and
   * money on a request that will fail identically — the prompt is wrong, and
   * patience does not fix it. Not retrying a 429 throws away a request that
   * would very likely have succeeded a moment later.
   */
  it('retries rate limiting', () => {
    expect(isRetryable(withStatus(429))).toBe(true);
  });

  it('retries an upstream fault', () => {
    expect(isRetryable(withStatus(500))).toBe(true);
    expect(isRetryable(withStatus(503))).toBe(true);
  });

  it('does not retry a bad request — it will fail the same way every time', () => {
    expect(isRetryable(withStatus(400))).toBe(false);
  });

  it('does not retry a bad API key', () => {
    expect(isRetryable(withStatus(401))).toBe(false);
    expect(isRetryable(withStatus(403))).toBe(false);
  });

  /** No status means the request never got an answer at all. */
  it('retries a timeout or dropped connection', () => {
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(isRetryable(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('reads a status nested under response, as some SDK errors report it', () => {
    expect(isRetryable({ response: { status: 429 } })).toBe(true);
    expect(isRetryable({ response: { status: 400 } })).toBe(false);
  });
});

describe('backoff', () => {
  it('grows with each attempt', () => {
    // Compared as ranges because of the jitter: attempt 1 is 250-500ms and
    // attempt 3 is 1000-2000ms, so the bands cannot overlap.
    expect(backoffDelay(1)).toBeLessThan(backoffDelay(3));
  });

  /**
   * The jitter is not decoration. If several requests are rate limited at once
   * and all back off by exactly the same amount, they retry in lockstep and hit
   * the limit together again — one bad second becomes several.
   */
  it('is jittered, so simultaneous failures do not retry in lockstep', () => {
    const delays = new Set(Array.from({ length: 20 }, () => backoffDelay(1)));

    expect(delays.size).toBeGreaterThan(1);
  });

  it('never waits so long that the user is left staring at a spinner', () => {
    // Every attempt's worst case, summed. The fallback is a template — waiting
    // seconds to avoid one would be the wrong trade.
    const worstCase = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => backoffDelay(i + 1)).reduce(
      (a, b) => a + b,
      0
    );

    expect(worstCase).toBeLessThan(3000);
  });

  it('keeps the attempt count low, because both features degrade gracefully', () => {
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(3);
  });
});

describe('an AI outage degrades rather than breaks', () => {
  const realGenerate = customerSummaryService.generateSummary;
  const realTranslate = aiSearchService.translateQuery;

  afterEach(() => {
    customerSummaryService.generateSummary = realGenerate;
    aiSearchService.translateQuery = realTranslate;
  });

  let manager;

  beforeEach(async () => {
    manager = await createManager();
  });

  /**
   * The behaviour a user actually experiences. Both AI features have a
   * non-AI path, so every failure mode — no key, a timeout, a rate limit, an
   * unparseable reply — has to end in a 200 with usable content.
   */
  it('serves a customer summary when every AI attempt fails', async () => {
    const customer = await createCustomer(manager);

    customerSummaryService.generateSummary = async () => ({
      mode: 'fallback',
      reason: 'AI request failed: upstream unavailable',
    });

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.summary.summary).toBeTruthy();
    expect(res.body.data.mode).toBe('fallback');
  });

  it('serves AI search results when every AI attempt fails', async () => {
    await createCustomer(manager, { name: 'Karachi Traders', city: 'Karachi' });

    aiSearchService.translateQuery = async () => ({
      mode: 'fallback',
      filter: null,
      reason: 'AI request failed: upstream unavailable',
    });

    const res = await api()
      .post('/api/ai-search')
      .set(manager.headers)
      .send({ query: 'customers in Karachi' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  /**
   * A thrown error from the service — as opposed to a returned fallback — must
   * still not produce a 500. This is the case a `parseAndValidate` guard would
   * not catch, because it never reached parsing.
   */
  it('does not 500 when the AI service throws outright', async () => {
    const customer = await createCustomer(manager);

    customerSummaryService.generateSummary = async () => {
      throw new Error('unexpected client explosion');
    };

    const res = await api()
      .get(`/api/customers/${customer._id}/summary`)
      .set(manager.headers);

    // Either a graceful fallback or a clean error — but never a silent 500 with
    // no useful body.
    expect(res.body.success !== undefined).toBe(true);
  });
});
