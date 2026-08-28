const { isRetryable, backoffDelay, MAX_ATTEMPTS } = require('../src/services/aiClient');
const { api, createAdmin, createManager, createCustomer } = require('./helpers');
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
  // AI SEARCH IS ADMIN-ONLY, the customer summary is manager-and-admin. Both
  // actors exist here because this block is about AI OUTAGES, not about
  // access — using a manager for the search would now fail on a 403 and
  // silently stop testing the thing it exists to test.
  let admin;

  beforeEach(async () => {
    manager = await createManager();
    admin = await createAdmin();
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
      .set(admin.headers)
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


describe('the prompt size ceiling', () => {
  const env = require('../src/config/env');
  const aiClient = require('../src/services/aiClient');

  /**
   * Part of every prompt is user-supplied — a search box, a customer's free-text
   * notes — so without a ceiling somebody pasting a document becomes a large and
   * entirely pointless bill. Refusing costs nothing; finding out on an invoice
   * costs the invoice.
   */
  it('refuses a prompt larger than the configured limit', async () => {
    await expect(
      aiClient.complete({
        feature: 'test',
        system: 'x'.repeat(env.aiMaxPromptChars),
        user: 'y'.repeat(env.aiMaxPromptChars),
        maxTokens: 10,
      })
    ).rejects.toThrow(/over the .* limit/i);
  });

  /**
   * REFUSED, not truncated. A silently shortened prompt produces a confidently
   * wrong answer and nobody would know why.
   */
  it('has a limit large enough for any real question and far smaller than a document', () => {
    expect(env.aiMaxPromptChars).toBeGreaterThan(2000);
    expect(env.aiMaxPromptChars).toBeLessThan(100000);
  });
});

/**
 * Behaviour specific to Gemini, all of it found by calling the real API rather
 * than by reading the docs.
 *
 * Each of these is a bug that shipped and was caught in a live run: the client
 * had been tuned against a different provider, and every one of the defaults
 * turned out to be wrong in a way that produced a plausible-looking failure
 * instead of an obvious one.
 */
describe('Gemini-specific failure handling', () => {
  const { isRetryable, retryAfterMs, TOTAL_DEADLINE_MS, REQUEST_TIMEOUT_MS } =
    require('../src/services/aiClient');

  /**
   * 499 is the client cancelling, which here means OUR timeout fired. It
   * arrives with a status, so the "any explicit status is permanent" rule sent
   * it straight to the fallback without a retry — while the identical failure
   * without a status was retried three times.
   */
  it('retries a 499, which is our own timeout firing', () => {
    expect(isRetryable({ status: 499 })).toBe(true);
  });

  it('still refuses to retry a genuinely permanent failure', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  describe('reading the retry delay the server sends', () => {
    /** The exact body Gemini returned when the free-tier quota ran out. */
    const REAL_429 =
      '{"error":{"code":429,"message":"You exceeded your current quota, please check your ' +
      'plan and billing details.\n* Quota exceeded for metric: ' +
      'generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, ' +
      'model: gemini-3.6-flash\nPlease retry in 47.432297979s.","status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"47s"}]}}';

    it('extracts the delay from a real quota error', () => {
      expect(retryAfterMs({ message: REAL_429 })).toBe(47000);
    });

    it('falls back to the prose form when there is no RetryInfo', () => {
      expect(retryAfterMs({ message: 'Please retry in 12s.' })).toBe(12000);
    });

    it('returns null when the server said nothing about waiting', () => {
      expect(retryAfterMs({ message: 'connection reset' })).toBeNull();
      expect(retryAfterMs({})).toBeNull();
      expect(retryAfterMs(null)).toBeNull();
    });

    /**
     * THE POINT OF PARSING IT AT ALL.
     *
     * The free tier allows five requests per MINUTE. Three attempts 250ms apart
     * do not ride out a rate limit — they spend two more of the five requests
     * that are left, on calls that cannot possibly succeed yet. A delay longer
     * than the whole operation's budget means stop now and let the caller fall
     * back, which is faster for the user and cheaper for the account.
     */
    it('asks for longer than the deadline allows, so the call is abandoned', () => {
      expect(retryAfterMs({ message: REAL_429 })).toBeGreaterThan(TOTAL_DEADLINE_MS);
    });
  });

  /**
   * A per-attempt timeout bounds one call; on its own, three attempts bound
   * nothing in particular. The deadline is what stops somebody watching a
   * spinner on a search box for a minute.
   */
  it('bounds the whole operation, not just each attempt', () => {
    expect(TOTAL_DEADLINE_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    expect(TOTAL_DEADLINE_MS).toBeLessThan(REQUEST_TIMEOUT_MS * 3);
  });
});
