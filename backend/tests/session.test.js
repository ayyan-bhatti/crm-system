const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { api } = require('./helpers');
const RefreshToken = require('../src/models/RefreshToken');
const env = require('../src/config/env');
const { ACCESS_COOKIE, REFRESH_COOKIE } = require('../src/utils/cookies');
const { CSRF_COOKIE, CSRF_HEADER } = require('../src/middleware/csrf');

/**
 * Cookie-based sessions: issuing, refreshing, rotation and logout.
 *
 * These use supertest's `agent`, which keeps a cookie jar across requests the
 * way a browser does. That is the only way to exercise the real flow — the
 * point of the design is that the client never touches a token itself.
 */

const CREDENTIALS = {
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  password: 'Karachi-Ledger-72',
};

/** Pull one Set-Cookie header by name out of a response. */
function cookieHeader(res, name) {
  const all = res.headers['set-cookie'] || [];
  return all.find((cookie) => cookie.startsWith(`${name}=`));
}

/** The value of a named cookie in a Set-Cookie header. */
function cookieValue(res, name) {
  const header = cookieHeader(res, name);
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
}

async function registerAgent() {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/register').send(CREDENTIALS);

  /*
   * Refresh and logout are cookie-authenticated POSTs, so they are subject to
   * the CSRF check — exactly as they are from the browser. `csrf` echoes the
   * token back the way the frontend's request interceptor does, so these tests
   * exercise the real flow rather than a privileged shortcut.
   */
  const csrf = cookieValue(res, CSRF_COOKIE);

  return { agent, res, csrf, post: (url) => agent.post(url).set(CSRF_HEADER, csrf) };
}

describe('Cookie sessions', () => {
  describe('issuing', () => {
    it('sets an access and a refresh cookie on register', async () => {
      const { res } = await registerAgent();

      expect(res.status).toBe(201);
      expect(cookieHeader(res, ACCESS_COOKIE)).toBeDefined();
      expect(cookieHeader(res, REFRESH_COOKIE)).toBeDefined();
    });

    it('sets an access and a refresh cookie on login', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);

      const res = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

      expect(cookieHeader(res, ACCESS_COOKIE)).toBeDefined();
      expect(cookieHeader(res, REFRESH_COOKIE)).toBeDefined();
    });

    /**
     * The single most important assertion in this file. httpOnly is what makes
     * the cookie unreadable from JavaScript, which is the entire reason the
     * token moved out of localStorage.
     */
    it('marks both cookies httpOnly', async () => {
      const { res } = await registerAgent();

      expect(cookieHeader(res, ACCESS_COOKIE)).toMatch(/HttpOnly/i);
      expect(cookieHeader(res, REFRESH_COOKIE)).toMatch(/HttpOnly/i);
    });

    it('marks both cookies SameSite=Lax so they are not sent cross-site', async () => {
      const { res } = await registerAgent();

      expect(cookieHeader(res, ACCESS_COOKIE)).toMatch(/SameSite=Lax/i);
      expect(cookieHeader(res, REFRESH_COOKIE)).toMatch(/SameSite=Lax/i);
    });

    /**
     * Scoping the refresh cookie to /api/auth means the long-lived credential
     * is not attached to every ordinary API call.
     */
    it('scopes the refresh cookie to the auth routes only', async () => {
      const { res } = await registerAgent();

      expect(cookieHeader(res, REFRESH_COOKIE)).toMatch(/Path=\/api\/auth/i);
      expect(cookieHeader(res, ACCESS_COOKIE)).toMatch(/Path=\//i);
    });

    it('issues an access token that expires in minutes, not days', async () => {
      const { res } = await registerAgent();

      const decoded = jwt.verify(cookieValue(res, ACCESS_COOKIE), env.jwtSecret);
      const lifetimeMinutes = (decoded.exp - decoded.iat) / 60;

      expect(lifetimeMinutes).toBeLessThanOrEqual(60);
    });

    /** The refresh token must never be recoverable from a response body. */
    it('never puts the refresh token in the JSON body', async () => {
      const { res } = await registerAgent();

      expect(JSON.stringify(res.body)).not.toContain(cookieValue(res, REFRESH_COOKIE));
    });

    /** Stored hashed, so a database leak does not hand over live sessions. */
    it('stores only a hash of the refresh token', async () => {
      const { res } = await registerAgent();
      const plaintext = cookieValue(res, REFRESH_COOKIE);

      const records = await RefreshToken.find({});

      expect(records).toHaveLength(1);
      expect(records[0].tokenHash).not.toBe(plaintext);
      expect(records[0].tokenHash).toHaveLength(64); // sha256 hex
    });
  });

  describe('authenticating with cookies', () => {
    it('authenticates a request using only the cookie', async () => {
      const { agent } = await registerAgent();

      // No Authorization header anywhere in this request.
      const res = await agent.get('/api/auth/me');

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe(CREDENTIALS.email);
    });

    it('still accepts an Authorization header for non-browser clients', async () => {
      const registered = await api().post('/api/auth/register').send(CREDENTIALS);

      const res = await api()
        .get('/api/auth/me')
        .set({ Authorization: `Bearer ${registered.body.data.token}` });

      expect(res.status).toBe(200);
    });

    it('rejects a request with a garbage cookie', async () => {
      const res = await api()
        .get('/api/auth/me')
        .set('Cookie', `${ACCESS_COOKIE}=not.a.real.token`);

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('issues a new pair of cookies', async () => {
      const { post, res: registered } = await registerAgent();
      const firstRefresh = cookieValue(registered, REFRESH_COOKIE);

      const res = await post('/api/auth/refresh');

      expect(res.status).toBe(200);
      expect(cookieHeader(res, ACCESS_COOKIE)).toBeDefined();
      expect(cookieValue(res, REFRESH_COOKIE)).not.toBe(firstRefresh);
    });

    it('leaves the session usable afterwards', async () => {
      const { agent, post } = await registerAgent();

      await post('/api/auth/refresh');
      const res = await agent.get('/api/auth/me');

      expect(res.status).toBe(200);
    });

    it('rejects a request with no refresh cookie', async () => {
      const res = await api().post('/api/auth/refresh');
      expect(res.status).toBe(401);
    });

    it('rejects a forged refresh token', async () => {
      const res = await api()
        .post('/api/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${'a'.repeat(64)}`);

      expect(res.status).toBe(401);
    });

    /** Rotation: the consumed token must be dead the moment it is exchanged. */
    it('revokes the old refresh token when it rotates', async () => {
      const { post, res: registered } = await registerAgent();
      const oldToken = cookieValue(registered, REFRESH_COOKIE);

      await post('/api/auth/refresh');

      const replay = await api()
        .post('/api/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${oldToken}`);

      expect(replay.status).toBe(401);
    });

    /**
     * Reuse detection. Replaying a consumed token means one of the two holders
     * is an attacker, and we cannot tell which — so the whole session dies.
     */
    it('kills the whole session family when a used token is replayed', async () => {
      const { post, res: registered } = await registerAgent();
      const stolen = cookieValue(registered, REFRESH_COOKIE);

      // The real user refreshes normally.
      await post('/api/auth/refresh');

      // The attacker replays the token they captured earlier.
      await api().post('/api/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=${stolen}`);

      // The real user's current token must now be dead too.
      const afterBreach = await post('/api/auth/refresh');

      expect(afterBreach.status).toBe(401);

      const live = await RefreshToken.countDocuments({ revokedAt: null });
      expect(live).toBe(0);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears both cookies', async () => {
      const { post } = await registerAgent();

      const res = await post('/api/auth/logout');

      expect(res.status).toBe(200);
      // An expired cookie with an empty value is how a browser is told to drop it.
      expect(cookieHeader(res, ACCESS_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/i);
      expect(cookieHeader(res, REFRESH_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/i);
    });

    /**
     * The part that makes logout real rather than cosmetic: a refresh token
     * captured before logout must not work after it.
     */
    it('revokes the refresh token server-side', async () => {
      const { post, res: registered } = await registerAgent();
      const captured = cookieValue(registered, REFRESH_COOKIE);

      await post('/api/auth/logout');

      const res = await api()
        .post('/api/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${captured}`);

      expect(res.status).toBe(401);
    });

    it('ends the session for the browser that logged out', async () => {
      const { agent, post } = await registerAgent();

      await post('/api/auth/logout');
      const res = await agent.get('/api/auth/me');

      expect(res.status).toBe(401);
    });

    /** Logging out twice, or with no session at all, is not an error. */
    it('succeeds even with no session', async () => {
      const res = await api().post('/api/auth/logout');
      expect(res.status).toBe(200);
    });
  });
});
