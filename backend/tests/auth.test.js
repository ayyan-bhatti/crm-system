const { api, createRep } = require('./helpers');
const User = require('../src/models/User');

describe('Authentication', () => {
  describe('POST /api/auth/register', () => {
    it('creates an account and returns a token', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha Khan', email: 'ayesha@example.com', password: 'password123' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toEqual(expect.any(String));
      expect(res.body.data.user.email).toBe('ayesha@example.com');
    });

    it('never returns the password hash', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'a@example.com', password: 'password123' });

      expect(res.body.data.user.password).toBeUndefined();
    });

    it('stores the password hashed, not in plain text', async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'a@example.com', password: 'password123' });

      const user = await User.findOne({ email: 'a@example.com' }).select('+password');
      expect(user.password).not.toBe('password123');
      expect(user.password).toMatch(/^\$2[aby]\$/); // bcrypt hash prefix
    });

    it('makes the first account an admin and later ones sales reps', async () => {
      const first = await api()
        .post('/api/auth/register')
        .send({ name: 'First', email: 'first@example.com', password: 'password123' });

      const second = await api()
        .post('/api/auth/register')
        .send({ name: 'Second', email: 'second@example.com', password: 'password123' });

      expect(first.body.data.user.role).toBe('admin');
      expect(second.body.data.user.role).toBe('sales_rep');
    });

    it('ignores a role supplied in the request body', async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'First', email: 'first@example.com', password: 'password123' });

      // Someone trying to grant themselves admin on sign-up.
      const res = await api()
        .post('/api/auth/register')
        .send({
          name: 'Sneaky',
          email: 'sneaky@example.com',
          password: 'password123',
          role: 'admin',
        });

      expect(res.body.data.user.role).toBe('sales_rep');
    });

    it('rejects a duplicate email with 409', async () => {
      const payload = { name: 'A', email: 'dup@example.com', password: 'password123' };
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
        .send({ name: 'A', email: 'not-an-email', password: 'password123' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'ayesha@example.com', password: 'password123' });
    });

    it('returns a token for valid credentials', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'ayesha@example.com', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.data.token).toEqual(expect.any(String));
    });

    it('accepts the email in a different case', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'AYESHA@example.com', password: 'password123' });

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
        .send({ email: 'nobody@example.com', password: 'password123' });

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
        .send({ email: 'nobody@example.com', password: 'password123' });

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
