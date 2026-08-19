const request = require('supertest');
const app = require('../src/app');
const { api, createRep } = require('./helpers');
const { ACCESS_COOKIE } = require('../src/utils/cookies');
const { CSRF_COOKIE, CSRF_HEADER } = require('../src/middleware/csrf');

/**
 * CSRF protection for the cookie-based session.
 *
 * These tests describe the attack directly: a request that carries the session
 * cookie but not the matching header is what an attacker's page can produce,
 * and it must fail. A request that carries both is what our own frontend
 * produces, and it must succeed.
 */

const CREDENTIALS = {
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  password: 'password123',
};

function cookieValue(res, name) {
  const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
}

/** Log in with a cookie-jar agent and hand back its tokens. */
async function signedInAgent() {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send(CREDENTIALS);

  return {
    agent,
    accessCookie: cookieValue(res, ACCESS_COOKIE),
    csrfToken: cookieValue(res, CSRF_COOKIE),
  };
}

describe('CSRF protection', () => {
  describe('token issuing', () => {
    it('plants a CSRF cookie on a first visit', async () => {
      const res = await api().get('/api/health');
      expect(cookieValue(res, CSRF_COOKIE)).toEqual(expect.any(String));
    });

    /**
     * The one flag that looks wrong next to the session cookies and is not:
     * the frontend must be able to read this one in order to echo it back.
     */
    it('makes the CSRF cookie readable by JavaScript', async () => {
      const res = await api().get('/api/health');
      const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(CSRF_COOKIE));

      expect(header).not.toMatch(/HttpOnly/i);
    });
  });

  describe('state-changing requests authenticated by cookie', () => {
    /**
     * The attack, reproduced: the browser attaches the session cookie to a
     * cross-site POST, but the attacker's page cannot read the CSRF cookie and
     * so cannot produce the header.
     */
    it('rejects a write with the session cookie but no CSRF header', async () => {
      const { accessCookie, csrfToken } = await signedInAgent();

      const res = await api()
        .post('/api/customers')
        .set('Cookie', [`${ACCESS_COOKIE}=${accessCookie}`, `${CSRF_COOKIE}=${csrfToken}`])
        .send({ name: 'Forged Co', email: 'forged@example.com' });

      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/csrf/i);
    });

    it('rejects a write whose CSRF header does not match the cookie', async () => {
      const { accessCookie, csrfToken } = await signedInAgent();

      const res = await api()
        .post('/api/customers')
        .set('Cookie', [`${ACCESS_COOKIE}=${accessCookie}`, `${CSRF_COOKIE}=${csrfToken}`])
        .set(CSRF_HEADER, 'a-guessed-value')
        .send({ name: 'Forged Co', email: 'forged@example.com' });

      expect(res.status).toBe(403);
    });

    it('accepts a write carrying the matching header', async () => {
      const { agent, csrfToken } = await signedInAgent();

      const res = await agent
        .post('/api/customers')
        .set(CSRF_HEADER, csrfToken)
        .send({ name: 'Real Co', email: 'real@example.com' });

      expect(res.status).toBe(201);
    });

    it('protects every write verb, not just POST', async () => {
      const { agent, csrfToken } = await signedInAgent();

      const created = await agent
        .post('/api/customers')
        .set(CSRF_HEADER, csrfToken)
        .send({ name: 'Real Co', email: 'real@example.com' });

      const patched = await agent
        .patch(`/api/customers/${created.body.data._id}`)
        .send({ name: 'Renamed' });

      const deleted = await agent.delete(`/api/customers/${created.body.data._id}`);

      expect(patched.status).toBe(403);
      expect(deleted.status).toBe(403);
    });

    /** Logging someone out against their will is a real, if minor, CSRF target. */
    it('protects logout', async () => {
      const { accessCookie, csrfToken } = await signedInAgent();

      const res = await api()
        .post('/api/auth/logout')
        .set('Cookie', [`${ACCESS_COOKIE}=${accessCookie}`, `${CSRF_COOKIE}=${csrfToken}`]);

      expect(res.status).toBe(403);
    });
  });

  describe('exemptions', () => {
    /**
     * Reads need no token. An attacker can force a GET but cannot read the
     * response — the same-origin policy already handles that — and requiring a
     * token on GET would break ordinary navigation.
     */
    it('allows reads without a token', async () => {
      const { agent } = await signedInAgent();

      const res = await agent.get('/api/customers');

      expect(res.status).toBe(200);
    });

    /**
     * The deliberate exemption. A bearer header has to be set by the caller,
     * and an attacker's cross-origin page cannot set headers on a browser
     * request — so a bearer-authenticated call is inherently CSRF-immune and
     * demanding a token from a script would be ceremony with no security value.
     */
    it('allows a bearer-authenticated write without a CSRF token', async () => {
      const rep = await createRep();

      const res = await api()
        .post('/api/customers')
        .set(rep.headers)
        .send({ name: 'Script Co', email: 'script@example.com' });

      expect(res.status).toBe(201);
    });

    /** Login has no session to ride, so there is nothing to forge. */
    it('allows login without a CSRF token', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);

      const res = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

      expect(res.status).toBe(200);
    });
  });
});
