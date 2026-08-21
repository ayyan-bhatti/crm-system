const { api, createRep } = require('./helpers');
const User = require('../src/models/User');

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
     * Public registration is now ADMIN BOOTSTRAP ONLY.
     *
     * The old rule was "first account becomes admin, everyone after is a sales
     * rep". The bootstrap half is still needed — a fresh install has no admin,
     * so somebody has to be able to create the first one — but the second half
     * meant anyone who could reach this endpoint could give themselves an
     * account on an internal CRM. Everyone after the first arrives by
     * invitation instead.
     */
    it('makes the first account an admin', async () => {
      const first = await api()
        .post('/api/auth/register')
        .send({ name: 'First', email: 'first@example.com', password: 'Karachi-Ledger-72' });

      expect(first.status).toBe(201);
      expect(first.body.data.user.role).toBe('admin');
      expect(first.body.data.user.status).toBe('active');
    });

    it('refuses every registration after the first', async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'First', email: 'first@example.com', password: 'Karachi-Ledger-72' });

      const second = await api()
        .post('/api/auth/register')
        .send({ name: 'Second', email: 'second@example.com', password: 'Karachi-Ledger-72' });

      expect(second.status).toBe(403);
      expect(second.body.message).toMatch(/invitation/i);
    });

    it('creates no account when registration is refused', async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'First', email: 'first@example.com', password: 'Karachi-Ledger-72' });

      await api()
        .post('/api/auth/register')
        .send({ name: 'Second', email: 'second@example.com', password: 'Karachi-Ledger-72' });

      expect(await User.countDocuments({})).toBe(1);
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
