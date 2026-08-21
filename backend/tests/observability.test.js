const { api, createAdmin, createManager, createRep } = require('./helpers');
const metrics = require('../src/services/metrics');
const { resolveRequestId } = require('../src/middleware/requestLogger');

/**
 * Request ids, and the metrics behind /api/internal/metrics.
 *
 * The logger itself is disabled under NODE_ENV=test — the suite deliberately
 * exercises failure paths, and hundreds of lines of expected errors would make
 * a real failure impossible to spot. So what is tested here is the behaviour
 * around it: that every response carries a traceable id, that an error response
 * hands that id to the user, and that the metrics are recorded and guarded.
 */

describe('Request ids', () => {
  beforeEach(() => metrics.reset());

  it('puts an id on every response', async () => {
    const res = await api().get('/api/health');

    expect(res.headers['x-request-id']).toEqual(expect.any(String));
    expect(res.headers['x-request-id'].length).toBeGreaterThan(7);
  });

  it('gives each request its own id', async () => {
    const first = await api().get('/api/health');
    const second = await api().get('/api/health');

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });

  /**
   * Vercel and load balancers set their own id and use it in THEIR logs.
   * Generating a fresh one would break the chain at exactly the boundary where
   * correlating across systems matters.
   */
  it('forwards an upstream id rather than replacing it', async () => {
    const res = await api().get('/api/health').set('X-Request-Id', 'upstream-abc-123');

    expect(res.headers['x-request-id']).toBe('upstream-abc-123');
  });

  /**
   * A header is user input, and an unvalidated one ends up in every log line
   * for the request — which is how log injection works.
   */
  it('refuses an implausible upstream id and generates its own', async () => {
    const nasty = 'short';
    const res = await api().get('/api/health').set('X-Request-Id', nasty);

    expect(res.headers['x-request-id']).not.toBe(nasty);
  });

  it('refuses an id containing newlines', () => {
    const forged = { get: () => 'abcdefgh\nfake log line' };
    expect(resolveRequestId(forged)).not.toContain('\n');
  });

  it('refuses an absurdly long id', () => {
    const huge = { get: () => 'a'.repeat(5000) };
    expect(resolveRequestId(huge).length).toBeLessThan(200);
  });

  /**
   * THE POINT OF THE WHOLE EXERCISE. A user reports "it failed and said
   * a1b2c3"; that string finds every log line for their request.
   */
  it('returns the id in the body of an error response', async () => {
    const res = await api().get('/api/customers');

    expect(res.status).toBe(401);
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});

describe('Metrics', () => {
  beforeEach(() => metrics.reset());

  it('counts requests', async () => {
    await api().get('/api/health');
    await api().get('/api/health');

    expect(metrics.snapshot().totals.requests).toBe(2);
  });

  it('separates client errors from server errors', async () => {
    // 401 — the client's problem, not ours.
    await api().get('/api/customers');

    const { totals, routes } = metrics.snapshot();

    expect(totals.serverErrors).toBe(0);
    expect(routes.some((r) => r.clientErrors > 0)).toBe(true);
  });

  /**
   * Keyed on the route PATTERN, not the URL. Keying on the URL would create a
   * fresh series per customer id — thousands of one-hit entries, and no way to
   * see that "the customer detail endpoint is slow".
   */
  it('groups by route pattern rather than by URL', async () => {
    const manager = await createManager();
    const { createCustomer } = require('./helpers');

    const a = await createCustomer(manager);
    const b = await createCustomer(manager);

    await api().get(`/api/customers/${a._id}`).set(manager.headers);
    await api().get(`/api/customers/${b._id}`).set(manager.headers);

    const detail = metrics
      .snapshot()
      .routes.find((r) => r.route.includes(':id') && r.method === 'GET');

    expect(detail).toBeDefined();
    expect(detail.count).toBe(2);
    // The ids must not appear as separate series.
    expect(metrics.snapshot().routes.some((r) => r.route.includes(String(a._id)))).toBe(false);
  });

  it('records latency', async () => {
    await api().get('/api/health');

    const [route] = metrics.snapshot().routes;

    expect(route.latencyMs.mean).toBeGreaterThanOrEqual(0);
    expect(route.latencyMs.max).toBeGreaterThanOrEqual(route.latencyMs.mean);
    expect(Object.keys(route.latencyMs.buckets).length).toBeGreaterThan(0);
  });

  it('reports an error rate per route', async () => {
    await api().get('/api/customers');

    const route = metrics.snapshot().routes.find((r) => r.clientErrors > 0);

    expect(route.errorRate).toBeGreaterThanOrEqual(0);
    expect(route.errorRate).toBeLessThanOrEqual(1);
  });

  /**
   * Metrics keyed on something unbounded — a 404 for every URL a scanner tries
   * — would grow until the process ran out of memory, taking out the app they
   * were meant to be observing.
   */
  it('caps the number of distinct route labels', () => {
    for (let i = 0; i < metrics.MAX_ROUTES + 50; i += 1) {
      metrics.record({ method: 'GET', route: `/made-up-${i}`, statusCode: 404, durationMs: 1 });
    }

    expect(metrics.snapshot().routes.length).toBeLessThanOrEqual(metrics.MAX_ROUTES + 1);
  });

  /**
   * On serverless these numbers describe ONE instance since it woke up.
   * Presenting them as deployment totals would be misleading, so the payload
   * says so itself.
   */
  it('states its own scope rather than implying it is the whole deployment', () => {
    const snapshot = metrics.snapshot();

    expect(snapshot.scope).toMatch(/instance/i);
    expect(snapshot.instanceId).toEqual(expect.any(String));
    expect(snapshot.windowStartedAt).toBeInstanceOf(Date);
  });
});

describe('GET /api/internal/metrics', () => {
  beforeEach(() => metrics.reset());

  it('serves the numbers to an admin', async () => {
    const admin = await createAdmin();

    const res = await api().get('/api/internal/metrics').set(admin.headers);

    expect(res.status).toBe(200);
    expect(res.body.data.totals).toBeDefined();
    expect(Array.isArray(res.body.data.routes)).toBe(true);
  });

  /**
   * Route-level latency and error rates describe the shape of the system, which
   * is not something every signed-in user needs.
   */
  it('refuses a manager', async () => {
    const manager = await createManager();

    expect((await api().get('/api/internal/metrics').set(manager.headers)).status).toBe(403);
  });

  it('refuses a sales rep', async () => {
    const rep = await createRep();

    expect((await api().get('/api/internal/metrics').set(rep.headers)).status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await api().get('/api/internal/metrics')).status).toBe(401);
  });
});
