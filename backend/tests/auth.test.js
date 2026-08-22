const { api, createRep } = require('./helpers');
const User = require('../src/models/User');
const env = require('../src/config/env');

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
