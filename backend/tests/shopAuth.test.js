const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { api, createAdmin } = require('./helpers');
const Buyer = require('../src/models/Buyer');
const BuyerRefreshToken = require('../src/models/BuyerRefreshToken');
const env = require('../src/config/env');
const {
  SHOP_ACCESS_COOKIE,
  SHOP_REFRESH_COOKIE,
} = require('../src/utils/shopCookies');
const { SHOP_CSRF_COOKIE, SHOP_CSRF_HEADER } = require('../src/middleware/shopCsrf');
const { ACCESS_COOKIE, REFRESH_COOKIE } = require('../src/utils/cookies');
const { CSRF_COOKIE } = require('../src/middleware/csrf');

/**
 * The buyer auth track: `/api/shop/auth/*`.
 *
 * Mirrors `session.test.js` and `csrf.test.js` in structure, deliberately —
 * this is the same design (cookie transport, rotation, reuse detection,
 * double-submit CSRF) applied to a second, independent audience. What these
 * tests add on top: registration activates a buyer immediately rather than
 * queuing an approval (there is nothing here for an admin to gate — see
 * `shopAuthController.js`), and the two session tracks must never collide
 * even when both are live in the same browser.
 */

const CREDENTIALS = {
  name: 'Bilal Ahmed',
  email: 'bilal@example.com',
  password: 'Faisalabad-Kettle-41',
};

function cookieHeader(res, name) {
  const all = res.headers['set-cookie'] || [];
  return all.find((cookie) => cookie.startsWith(`${name}=`));
}

function cookieValue(res, name) {
  const header = cookieHeader(res, name);
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
}

async function registerAgent(overrides = {}) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/shop/auth/register')
    .send({ ...CREDENTIALS, ...overrides });

  const csrf = cookieValue(res, SHOP_CSRF_COOKIE);

  return { agent, res, csrf, post: (url) => agent.post(url).set(SHOP_CSRF_HEADER, csrf) };
}

describe('Buyer auth', () => {
  describe('POST /api/shop/auth/register', () => {
    it('creates a buyer and signs them in immediately — no approval to wait for', async () => {
      const res = await api().post('/api/shop/auth/register').send(CREDENTIALS);

      expect(res.status).toBe(201);
      expect(res.body.data.buyer.email).toBe(CREDENTIALS.email);
      expect(res.body.data.token).toEqual(expect.any(String));
    });

    it('never returns the password hash', async () => {
      const res = await api().post('/api/shop/auth/register').send(CREDENTIALS);
      expect(res.body.data.buyer.password).toBeUndefined();
    });

    it('stores the password hashed, not in plain text', async () => {
      await api().post('/api/shop/auth/register').send(CREDENTIALS);

      const buyer = await Buyer.findOne({ email: CREDENTIALS.email }).select('+password');
      expect(buyer.password).not.toBe(CREDENTIALS.password);
      expect(buyer.password).toMatch(/^\$2[aby]\$/);
    });

    it('refuses a second account on the same email', async () => {
      await api().post('/api/shop/auth/register').send(CREDENTIALS);

      const res = await api().post('/api/shop/auth/register').send(CREDENTIALS);
      expect(res.status).toBe(409);
    });

    it('applies the same password strength policy as staff accounts', async () => {
      const res = await api()
        .post('/api/shop/auth/register')
        .send({ ...CREDENTIALS, password: 'short' });

      expect(res.status).toBe(400);
      expect(await Buyer.countDocuments()).toBe(0);
    });

    /*
     * The whole point of a separate track: registering a buyer must not touch
     * the staff bootstrap rule that makes the first User account an admin.
     */
    it('does not make a buyer an admin, or touch the staff bootstrap', async () => {
      await api().post('/api/shop/auth/register').send(CREDENTIALS);

      const admin = await createAdmin();
      expect(admin.user.role).toBe('admin');
    });
  });

  describe('POST /api/shop/auth/login', () => {
    it('signs a registered buyer in', async () => {
      await api().post('/api/shop/auth/register').send(CREDENTIALS);

      const res = await api()
        .post('/api/shop/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

      expect(res.status).toBe(200);
      expect(res.body.data.buyer.email).toBe(CREDENTIALS.email);
    });

    it('gives the same message for an unknown email and a wrong password', async () => {
      await api().post('/api/shop/auth/register').send(CREDENTIALS);

      const wrongPassword = await api()
        .post('/api/shop/auth/login')
        .send({ email: CREDENTIALS.email, password: 'nope-nope-nope' });
      const unknownEmail = await api()
        .post('/api/shop/auth/login')
        .send({ email: 'nobody@example.com', password: 'nope-nope-nope' });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it('locks the account out after repeated failures, same as staff', async () => {
      await api().post('/api/shop/auth/register').send(CREDENTIALS);

      for (let i = 0; i < 5; i += 1) {
        await api()
          .post('/api/shop/auth/login')
          .send({ email: CREDENTIALS.email, password: 'wrong' });
      }

      const res = await api()
        .post('/api/shop/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

      expect(res.status).toBe(429);
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe('cookies', () => {
    it('sets shop-named access and refresh cookies, not the staff ones', async () => {
      const { res } = await registerAgent();

      expect(cookieHeader(res, SHOP_ACCESS_COOKIE)).toBeDefined();
      expect(cookieHeader(res, SHOP_REFRESH_COOKIE)).toBeDefined();
      expect(cookieHeader(res, ACCESS_COOKIE)).toBeUndefined();
      expect(cookieHeader(res, REFRESH_COOKIE)).toBeUndefined();
    });

    it('marks both cookies httpOnly and SameSite=Lax', async () => {
      const { res } = await registerAgent();

      expect(cookieHeader(res, SHOP_ACCESS_COOKIE)).toMatch(/HttpOnly/i);
      expect(cookieHeader(res, SHOP_REFRESH_COOKIE)).toMatch(/HttpOnly/i);
      expect(cookieHeader(res, SHOP_ACCESS_COOKIE)).toMatch(/SameSite=Lax/i);
      expect(cookieHeader(res, SHOP_REFRESH_COOKIE)).toMatch(/SameSite=Lax/i);
    });

    it('scopes the refresh cookie to the shop auth routes only', async () => {
      const { res } = await registerAgent();

      expect(cookieHeader(res, SHOP_REFRESH_COOKIE)).toMatch(/Path=\/api\/shop\/auth/i);
      expect(cookieHeader(res, SHOP_ACCESS_COOKIE)).toMatch(/Path=\//i);
    });

    it('signs a buyer access token carrying kind=buyer and no role', async () => {
      const { res } = await registerAgent();

      const decoded = jwt.verify(cookieValue(res, SHOP_ACCESS_COOKIE), env.jwtSecret);
      expect(decoded.kind).toBe('buyer');
      expect(decoded.role).toBeUndefined();
    });

    it('stores only a hash of the refresh token', async () => {
      const { res } = await registerAgent();
      const plaintext = cookieValue(res, SHOP_REFRESH_COOKIE);

      const records = await BuyerRefreshToken.find({});
      expect(records).toHaveLength(1);
      expect(records[0].tokenHash).not.toBe(plaintext);
      expect(records[0].tokenHash).toHaveLength(64);
    });

    /*
     * The property that justifies the whole design: a manager checking the
     * storefront and a buyer shopping can both be signed in, in one browser,
     * without either session disturbing the other.
     */
    it('coexists with a live staff session in the same browser', async () => {
      const agent = request.agent(app);

      const staffRes = await agent.post('/api/auth/register').send({
        name: 'Staff Person',
        email: 'staff@example.com',
        password: 'Karachi-Ledger-72',
      });
      const buyerRes = await agent.post('/api/shop/auth/register').send(CREDENTIALS);

      expect(staffRes.status).toBe(201);
      expect(buyerRes.status).toBe(201);

      const staffMe = await agent.get('/api/auth/me');
      const buyerMe = await agent
        .get('/api/shop/auth/me')
        .set(SHOP_CSRF_HEADER, cookieValue(buyerRes, SHOP_CSRF_COOKIE));

      expect(staffMe.status).toBe(200);
      expect(staffMe.body.data.user.email).toBe('staff@example.com');
      expect(buyerMe.status).toBe(200);
      expect(buyerMe.body.data.buyer.email).toBe(CREDENTIALS.email);
    });

    /** A buyer token must not authenticate a staff route, or vice versa. */
    it('refuses a buyer token on a staff route and a staff token on a buyer route', async () => {
      const buyerRes = await api().post('/api/shop/auth/register').send(CREDENTIALS);
      const staffRes = await api().post('/api/auth/register').send({
        name: 'Staff Person',
        email: 'staff2@example.com',
        password: 'Karachi-Ledger-72',
      });

      const buyerOnStaff = await api()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${buyerRes.body.data.token}`);
      const staffOnBuyer = await api()
        .get('/api/shop/auth/me')
        .set('Authorization', `Bearer ${staffRes.body.data.token}`);

      expect(buyerOnStaff.status).toBe(401);
      expect(staffOnBuyer.status).toBe(401);
    });
  });

  describe('GET /api/shop/auth/me', () => {
    it('authenticates a request using only the cookie', async () => {
      const { agent } = await registerAgent();

      const res = await agent.get('/api/shop/auth/me');
      expect(res.status).toBe(200);
      expect(res.body.data.buyer.email).toBe(CREDENTIALS.email);
    });

    it('still accepts a bearer token for non-browser callers', async () => {
      const registered = await api().post('/api/shop/auth/register').send(CREDENTIALS);

      const res = await api()
        .get('/api/shop/auth/me')
        .set('Authorization', `Bearer ${registered.body.data.token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('POST /api/shop/auth/refresh', () => {
    it('issues a new pair of cookies and revokes the old refresh token', async () => {
      const { post, res: registered } = await registerAgent();
      const firstRefresh = cookieValue(registered, SHOP_REFRESH_COOKIE);

      const res = await post('/api/shop/auth/refresh');

      expect(res.status).toBe(200);
      expect(cookieValue(res, SHOP_REFRESH_COOKIE)).not.toBe(firstRefresh);

      const replay = await api()
        .post('/api/shop/auth/refresh')
        .set('Cookie', `${SHOP_REFRESH_COOKIE}=${firstRefresh}`);
      expect(replay.status).toBe(401);
    });

    it('kills the whole session family when a used token is replayed', async () => {
      const { post, res: registered } = await registerAgent();
      const stolen = cookieValue(registered, SHOP_REFRESH_COOKIE);

      await post('/api/shop/auth/refresh');
      await api()
        .post('/api/shop/auth/refresh')
        .set('Cookie', `${SHOP_REFRESH_COOKIE}=${stolen}`);

      const afterBreach = await post('/api/shop/auth/refresh');
      expect(afterBreach.status).toBe(401);

      const live = await BuyerRefreshToken.countDocuments({ revokedAt: null });
      expect(live).toBe(0);
    });

    it('rejects a request with no refresh cookie', async () => {
      const res = await api().post('/api/shop/auth/refresh');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/shop/auth/logout', () => {
    it('clears both shop cookies and revokes the refresh token server-side', async () => {
      const { post, res: registered } = await registerAgent();
      const captured = cookieValue(registered, SHOP_REFRESH_COOKIE);

      const res = await post('/api/shop/auth/logout');

      expect(res.status).toBe(200);
      expect(cookieHeader(res, SHOP_ACCESS_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/i);
      expect(cookieHeader(res, SHOP_REFRESH_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/i);

      const replay = await api()
        .post('/api/shop/auth/refresh')
        .set('Cookie', `${SHOP_REFRESH_COOKIE}=${captured}`);
      expect(replay.status).toBe(401);
    });

    it('succeeds even with no session', async () => {
      const res = await api().post('/api/shop/auth/logout');
      expect(res.status).toBe(200);
    });
  });

  describe('CSRF protection on the buyer session', () => {
    it('rejects logout carrying the session cookie but no CSRF header', async () => {
      const { res: registered } = await registerAgent();
      const access = cookieValue(registered, SHOP_ACCESS_COOKIE);
      const csrf = cookieValue(registered, SHOP_CSRF_COOKIE);

      const res = await api()
        .post('/api/shop/auth/logout')
        .set('Cookie', [`${SHOP_ACCESS_COOKIE}=${access}`, `${SHOP_CSRF_COOKIE}=${csrf}`]);

      expect(res.status).toBe(403);
    });

    /*
     * A staff CSRF token must not stand in for the buyer's own — the header
     * has to match the SHOP cookie specifically, not just be A valid-looking
     * token from somewhere. That is what stops one XSRF token protecting two
     * audiences, which would defeat the purpose of separating them at all.
     */
    it('does not accept a staff CSRF token in place of the buyer one', async () => {
      const { res: registered } = await registerAgent();
      const access = cookieValue(registered, SHOP_ACCESS_COOKIE);
      const realShopCsrf = cookieValue(registered, SHOP_CSRF_COOKIE);

      const staffCsrfSource = await api().get('/api/health');
      const staffCsrf = cookieValue(staffCsrfSource, CSRF_COOKIE);
      expect(staffCsrf).not.toBe(realShopCsrf);

      // The real shop CSRF cookie travels with the request, as it would from
      // a browser — but the header carries a staff token instead of echoing it.
      const res = await api()
        .post('/api/shop/auth/logout')
        .set('Cookie', [
          `${SHOP_ACCESS_COOKIE}=${access}`,
          `${SHOP_CSRF_COOKIE}=${realShopCsrf}`,
        ])
        .set(SHOP_CSRF_HEADER, staffCsrf);

      expect(res.status).toBe(403);
    });

    it('allows a write carrying the matching shop CSRF header', async () => {
      const { post } = await registerAgent();

      const res = await post('/api/shop/auth/logout');
      expect(res.status).toBe(200);
    });

    it('allows registration and login without a CSRF token — no session to ride yet', async () => {
      const res = await api().post('/api/shop/auth/register').send(CREDENTIALS);
      expect(res.status).toBe(201);
    });

    it('allows a bearer-authenticated request without a CSRF token', async () => {
      const registered = await api().post('/api/shop/auth/register').send(CREDENTIALS);

      const res = await api()
        .post('/api/shop/auth/logout')
        .set('Authorization', `Bearer ${registered.body.data.token}`);

      expect(res.status).toBe(200);
    });
  });

  describe('the saved-address book', () => {
    it('adds an address and requires a label and the address itself', async () => {
      const { agent, res: registered } = await registerAgent();
      const csrf = cookieValue(registered, SHOP_CSRF_COOKIE);

      const missing = await agent
        .post('/api/shop/auth/addresses')
        .set(SHOP_CSRF_HEADER, csrf)
        .send({ label: 'Home' });
      expect(missing.status).toBe(400);

      const res = await agent
        .post('/api/shop/auth/addresses')
        .set(SHOP_CSRF_HEADER, csrf)
        .send({ label: 'Home', address: '12 Ledger Road, Karachi', phone: '0300-1234567' });

      expect(res.status).toBe(201);
      expect(res.body.data.addresses).toHaveLength(1);
      expect(res.body.data.addresses[0].label).toBe('Home');
    });

    it('updates and deletes an address, both scoped to the signed-in buyer', async () => {
      const { agent, res: registered } = await registerAgent();
      const csrf = cookieValue(registered, SHOP_CSRF_COOKIE);
      const post = (url) => agent.post(url).set(SHOP_CSRF_HEADER, csrf);

      const added = await post('/api/shop/auth/addresses').send({
        label: 'Home',
        address: '12 Ledger Road',
      });
      const addressId = added.body.data.addresses[0]._id;

      const updated = await agent
        .patch(`/api/shop/auth/addresses/${addressId}`)
        .set(SHOP_CSRF_HEADER, csrf)
        .send({ label: 'Work' });
      expect(updated.body.data.addresses[0].label).toBe('Work');

      const deleted = await agent
        .delete(`/api/shop/auth/addresses/${addressId}`)
        .set(SHOP_CSRF_HEADER, csrf);
      expect(deleted.body.data.addresses).toHaveLength(0);
    });

    it("never reaches another buyer's address book", async () => {
      const first = await registerAgent();
      const firstCsrf = cookieValue(first.res, SHOP_CSRF_COOKIE);
      const added = await first.agent
        .post('/api/shop/auth/addresses')
        .set(SHOP_CSRF_HEADER, firstCsrf)
        .send({ label: 'Home', address: '12 Ledger Road' });
      const addressId = added.body.data.addresses[0]._id;

      const second = await registerAgent({ email: 'colleague@example.com' });
      const secondCsrf = cookieValue(second.res, SHOP_CSRF_COOKIE);

      const res = await second.agent
        .patch(`/api/shop/auth/addresses/${addressId}`)
        .set(SHOP_CSRF_HEADER, secondCsrf)
        .send({ label: 'Stolen' });

      expect(res.status).toBe(404);
    });

    it('refuses an unauthenticated caller', async () => {
      const res = await api()
        .post('/api/shop/auth/addresses')
        .send({ label: 'Home', address: '12 Ledger Road' });
      expect(res.status).toBe(401);
    });
  });
});
