const request = require('supertest');
const app = require('../src/app');
const { api, createRep } = require('./helpers');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');
const env = require('../src/config/env');
const { CSRF_COOKIE, CSRF_HEADER } = require('../src/middleware/csrf');

describe('Authentication', () => {
  describe('POST /api/auth/register', () => {
    it('creates an account and returns a token', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha Khan', email: 'ayesha@example.com', password: 'Karachi-Ledger-72' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toEqual(expect.any(String));
      expect(res.body.data.user.email).toBe('ayesha@example.com');
    });

    it('never returns the password hash', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'a@example.com', password: 'Karachi-Ledger-72' });

      expect(res.body.data.user.password).toBeUndefined();
    });

    it('stores the password hashed, not in plain text', async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'a@example.com', password: 'Karachi-Ledger-72' });

      const user = await User.findOne({ email: 'a@example.com' }).select('+password');
      expect(user.password).not.toBe('Karachi-Ledger-72');
      expect(user.password).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
    });

    /**
     * TWO SEPARATE RULES, and the tests keep them separate because they fail
     * for different reasons.
     *
     * The first account on an empty install is ALWAYS allowed and becomes the
     * admin — a fresh deployment has nobody to send an invitation, so gating
     * this would lock everyone out of a new install permanently.
     *
     * Every account after that depends on ALLOW_PUBLIC_SIGNUP, and is a sales
     * rep either way. The role is never taken from the request.
     */
    const registerAs = (name, email) =>
      api()
        .post('/api/auth/register')
        .send({ name, email, password: 'Karachi-Ledger-72' });

    it('makes the first account an admin', async () => {
      const first = await registerAs('First', 'first@example.com');

      expect(first.status).toBe(201);
      expect(first.body.data.user.role).toBe('admin');
      expect(first.body.data.user.status).toBe('active');
    });

    /**
     * These used to assert that a second sign-up produced a working account.
     * It no longer does: signing up is now a REQUEST an administrator has to
     * approve. The blast radius that worried the earlier version — a stranger
     * who signs up can read the CRM — is closed by the account being unusable
     * rather than by the role it holds.
     *
     * The approval flow itself is covered in accountRequests.test.js; these
     * pin the boundary between "open" and "closed", which is what
     * ALLOW_PUBLIC_SIGNUP still controls.
     */
    describe('when sign-up is open (the default)', () => {
      it('accepts a request after the first account', async () => {
        await registerAs('First', 'first@example.com');

        const second = await registerAs('Second', 'second@example.com');

        // 202 Accepted: something was created, but not the thing the caller
        // asked for. See the note on the handler.
        expect(second.status).toBe(202);
      });

      it('leaves the new account pending rather than active', async () => {
        await registerAs('First', 'first@example.com');
        await registerAs('Second', 'second@example.com');

        const user = await User.findOne({ email: 'second@example.com' });
        expect(user.status).toBe('pending');
        expect(user.role).toBe('sales_rep');
      });

      /** The account exists, and existing is not the same as usable. */
      it('does not let them sign in until somebody approves', async () => {
        await registerAs('First', 'first@example.com');
        await registerAs('Second', 'second@example.com');

        const login = await api()
          .post('/api/auth/login')
          .send({ email: 'second@example.com', password: 'Karachi-Ledger-72' });

        expect(login.status).toBe(403);
        expect(login.body.message).toMatch(/awaiting administrator approval/i);
      });
    });

    describe('when public sign-up is closed', () => {
      const realSetting = env.allowPublicSignup;

      beforeEach(() => {
        env.allowPublicSignup = false;
      });

      afterEach(() => {
        env.allowPublicSignup = realSetting;
      });

      it('refuses every registration after the first', async () => {
        await registerAs('First', 'first@example.com');

        const second = await registerAs('Second', 'second@example.com');

        expect(second.status).toBe(403);
        expect(second.body.message).toMatch(/invitation/i);
      });

      it('creates no account when registration is refused', async () => {
        await registerAs('First', 'first@example.com');
        await registerAs('Second', 'second@example.com');

        expect(await User.countDocuments({})).toBe(1);
      });

      /**
       * The bootstrap exemption. Without it, a deployment that ships with
       * sign-up closed has no way to create its first administrator at all.
       */
      it('still allows the very first account', async () => {
        const first = await registerAs('First', 'first@example.com');

        expect(first.status).toBe(201);
        expect(first.body.data.user.role).toBe('admin');
      });
    });

    /**
     * The bootstrap account's role is decided by the server, not the request.
     * It happens to be admin, but a `role` in the body must never be what
     * decides that — otherwise the rule is "whatever the first caller asks for".
     */
    it('ignores a role supplied in the request body', async () => {
      const res = await api().post('/api/auth/register').send({
        name: 'First',
        email: 'first@example.com',
        password: 'Karachi-Ledger-72',
        role: 'sales_rep',
      });

      expect(res.body.data.user.role).toBe('admin');
    });

    it('rejects a duplicate email with 409', async () => {
      const payload = { name: 'A', email: 'dup@example.com', password: 'Karachi-Ledger-72' };
      await api().post('/api/auth/register').send(payload);

      const res = await api().post('/api/auth/register').send(payload);

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('rejects a missing password with 400', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'A', email: 'a@example.com' });

      expect(res.status).toBe(400);
    });

    it('rejects a password shorter than 8 characters with 400', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'A', email: 'a@example.com', password: 'short' });

      expect(res.status).toBe(400);
    });

    it('rejects a malformed email with 400', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'A', email: 'not-an-email', password: 'Karachi-Ledger-72' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'ayesha@example.com', password: 'Karachi-Ledger-72' });
    });

    it('returns a token for valid credentials', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'ayesha@example.com', password: 'Karachi-Ledger-72' });

      expect(res.status).toBe(200);
      expect(res.body.data.token).toEqual(expect.any(String));
    });

    it('accepts the email in a different case', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'AYESHA@example.com', password: 'Karachi-Ledger-72' });

      expect(res.status).toBe(200);
    });

    it('rejects a wrong password with 401', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'ayesha@example.com', password: 'wrong-password' });

      expect(res.status).toBe(401);
    });

    it('rejects an unknown email with 401', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'Karachi-Ledger-72' });

      expect(res.status).toBe(401);
    });

    /**
     * Both failures must look identical, otherwise the endpoint tells an
     * attacker which email addresses have accounts.
     */
    it('gives the same message for a wrong password and an unknown email', async () => {
      const wrongPassword = await api()
        .post('/api/auth/login')
        .send({ email: 'ayesha@example.com', password: 'wrong-password' });

      const unknownEmail = await api()
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'Karachi-Ledger-72' });

      expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
    });

    it('rejects a missing password with 400', async () => {
      const res = await api().post('/api/auth/login').send({ email: 'ayesha@example.com' });

      expect(res.status).toBe(400);
    });
  });

  /**
   * "Who accessed this system, and when" is a question the audit trail must
   * answer even though none of these three events changes a record — see the
   * note on the `login`/`login_failed`/`logout` actions in models/AuditLog.js.
   */
  describe('sign-in and sign-out on the audit trail', () => {
    beforeEach(async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'ayesha@example.com', password: 'Karachi-Ledger-72' });
    });

    it('records a successful sign-in', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'ayesha@example.com', password: 'Karachi-Ledger-72' });

      const user = await User.findOne({ email: 'ayesha@example.com' });
      const entry = await AuditLog.findOne({ action: 'login', entityId: user._id });

      expect(res.status).toBe(200);
      expect(entry).not.toBeNull();
      expect(entry.actor.email).toBe('ayesha@example.com');
    });

    it('records a failed sign-in against the real account, not a phantom one', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'ayesha@example.com', password: 'wrong-password' });

      const user = await User.findOne({ email: 'ayesha@example.com' });
      const entry = await AuditLog.findOne({ action: 'login_failed', entityId: user._id });

      expect(res.status).toBe(401);
      expect(entry).not.toBeNull();
    });

    /**
     * An unknown email has no account to attach the entry to — inventing one
     * would be worse than not recording it, and the per-IP limiter is
     * already the defence against a stranger guessing at addresses.
     */
    it('does not record a failed sign-in for an email with no account', async () => {
      await api()
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'Karachi-Ledger-72' });

      const entry = await AuditLog.findOne({ action: 'login_failed' });

      expect(entry).toBeNull();
    });

    it('records a sign-out', async () => {
      /*
       * A cookie-jar agent, not the plain `api()` helper — logout is a POST,
       * so it is behind the CSRF check, which needs the token COOKIE and its
       * matching HEADER both present. `api()` alone does not carry cookies
       * across requests; see tests/csrf.test.js for the identical pattern.
       */
      const agent = request.agent(app);
      const login = await agent
        .post('/api/auth/login')
        .send({ email: 'ayesha@example.com', password: 'Karachi-Ledger-72' });

      const csrfCookie = (login.headers['set-cookie'] || []).find((c) =>
        c.startsWith(`${CSRF_COOKIE}=`)
      );
      const csrfToken = decodeURIComponent(csrfCookie.slice(CSRF_COOKIE.length + 1).split(';')[0]);

      const res = await agent.post('/api/auth/logout').set(CSRF_HEADER, csrfToken);

      const user = await User.findOne({ email: 'ayesha@example.com' });
      const entry = await AuditLog.findOne({ action: 'logout', entityId: user._id });

      expect(res.status).toBe(200);
      expect(entry).not.toBeNull();
    });

    it('is a harmless no-op, on the audit trail too, for a logout with no session', async () => {
      const res = await api().post('/api/auth/logout');

      expect(res.status).toBe(200);
      expect(await AuditLog.countDocuments({ action: 'logout' })).toBe(0);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the signed-in user', async () => {
      const rep = await createRep({ name: 'Bilal' });

      const res = await api().get('/api/auth/me').set(rep.headers);

      expect(res.status).toBe(200);
      expect(res.body.data.user.name).toBe('Bilal');
    });

    it('rejects a request with no token', async () => {
      const res = await api().get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it('rejects a malformed token', async () => {
      const res = await api().get('/api/auth/me').set({ Authorization: 'Bearer not.a.token' });
      expect(res.status).toBe(401);
    });

    it('rejects a token missing the Bearer prefix', async () => {
      const rep = await createRep();
      const res = await api().get('/api/auth/me').set({ Authorization: rep.token });
      expect(res.status).toBe(401);
    });

    /**
     * `protect` reloads the user on every request, so an account deleted while
     * its token is still technically valid stops working immediately.
     */
    it('rejects a valid token whose user has been deleted', async () => {
      const rep = await createRep();
      await User.findByIdAndDelete(rep.user._id);

      const res = await api().get('/api/auth/me').set(rep.headers);

      expect(res.status).toBe(401);
    });
  });
});
