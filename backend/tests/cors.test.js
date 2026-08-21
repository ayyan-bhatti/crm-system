const { api } = require('./helpers');

/**
 * CORS.
 *
 * THE FAILURE THIS GUARDS AGAINST.
 *
 * `CLIENT_ORIGIN` defaults to http://localhost:5173. On a deployment where
 * nobody set it, that default was the entire allow-list, so a browser on the
 * real domain was refused. A CORS refusal is invisible to the page that made
 * the request — axios reports the literal string "Network Error" with no status
 * and no body — so it presented as "the app is broken after I log in" with
 * nothing in the response to explain why.
 *
 * These tests cover the three cases that matter: the deployment's own origin,
 * a genuinely foreign one, and an explicit allow-list still being honoured
 * exactly as the operator wrote it.
 */

const ALLOW = 'access-control-allow-origin';
const DEPLOYED = 'crm-system.vercel.app';

/** A request as it arrives behind a proxy, from a browser on the given origin. */
const fromOrigin = (origin, host = DEPLOYED) =>
  api()
    .get('/api/health')
    .set('Origin', origin)
    .set('x-forwarded-host', host)
    .set('x-forwarded-proto', 'https');

describe('CORS when CLIENT_ORIGIN is not configured', () => {
  const real = process.env.CLIENT_ORIGIN;

  beforeEach(() => {
    delete process.env.CLIENT_ORIGIN;
  });

  afterEach(() => {
    if (real === undefined) delete process.env.CLIENT_ORIGIN;
    else process.env.CLIENT_ORIGIN = real;
  });

  /** The fix. Without this header the browser discards the response. */
  it('allows a browser on the deployment’s own origin', async () => {
    const res = await fromOrigin(`https://${DEPLOYED}`);

    expect(res.headers[ALLOW]).toBe(`https://${DEPLOYED}`);
  });

  it('still refuses a genuinely foreign origin', async () => {
    const res = await fromOrigin('https://evil.example.com');

    expect(res.headers[ALLOW]).toBeUndefined();
  });

  /**
   * The host is what the request arrived on, so a forged Origin claiming to be
   * some other site does not match and gains nothing.
   */
  it('refuses an origin that does not match the host it arrived on', async () => {
    const res = await fromOrigin('https://other-app.vercel.app', DEPLOYED);

    expect(res.headers[ALLOW]).toBeUndefined();
  });

  /** Local development: Vite on :5173 calling the API on another port. */
  it('allows the local dev server', async () => {
    const res = await api().get('/api/health').set('Origin', 'http://localhost:5173');

    expect(res.headers[ALLOW]).toBe('http://localhost:5173');
  });

  /**
   * Same-origin requests carry no Origin header at all, which is the normal
   * case behind the Vercel rewrites. Nothing to check, nothing to block.
   */
  it('leaves a request with no Origin header alone', async () => {
    const res = await api().get('/api/health');

    expect(res.status).toBeLessThan(500);
  });
});

describe('CORS when CLIENT_ORIGIN is configured', () => {
  const real = process.env.CLIENT_ORIGIN;

  afterEach(() => {
    if (real === undefined) delete process.env.CLIENT_ORIGIN;
    else process.env.CLIENT_ORIGIN = real;
  });

  /**
   * An explicit allow-list is something the operator wrote deliberately, so it
   * is honoured exactly — the request-host fallback must not quietly widen it.
   */
  it('honours the list as written, and does not add the request host', async () => {
    process.env.CLIENT_ORIGIN = 'https://only-this-one.example.com';

    const res = await fromOrigin(`https://${DEPLOYED}`);

    expect(res.headers[ALLOW]).toBeUndefined();
  });
});
