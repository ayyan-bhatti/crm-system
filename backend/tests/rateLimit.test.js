const { api } = require('./helpers');
const env = require('../src/config/env');
const User = require('../src/models/User');
const { loginLimiter, registerLimiter } = require('../src/middleware/rateLimit');

/**
 * Rate limiting and account lockout.
 *
 * The limiters are switched off for the rest of the suite (see the note on
 * `skip` in middleware/rateLimit.js) because the other test files log in dozens
 * of times from one address, which is exactly what these limits reject. This
 * file turns them back on for itself and resets the counters between tests, so
 * each one starts from a clean window.
 */

const CREDENTIALS = {
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  password: 'Karachi-Ledger-72',
};

/**
 * The address supertest connects from. Resetting it between tests is necessary
 * because a limiter's counters live in the middleware instance, which is
 * created once when the module loads and therefore outlives an individual test.
 */
const TEST_IP = '::ffff:127.0.0.1';

function resetLimiters() {
  [loginLimiter, registerLimiter].forEach((limiter) => {
    limiter.resetKey(TEST_IP);
    limiter.resetKey('127.0.0.1');
  });
}

beforeEach(() => {
  env.rateLimitEnabled = true;
  resetLimiters();
});

afterEach(() => {
  env.rateLimitEnabled = false;
  resetLimiters();
});

describe('Per-IP rate limiting', () => {
  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);
      resetLimiters(); // The registration above should not count against login.
    });

    it('allows a normal number of attempts', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

      expect(res.status).toBe(200);
    });

    /**
     * Uses an address with no account, so the per-account lockout never
     * engages and the 429 can only have come from the IP limiter.
     */
    it('returns 429 once the window limit is exceeded', async () => {
      const attempt = () =>
        api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });

      let last;
      for (let i = 0; i < 11; i += 1) {
        last = await attempt();
      }

      expect(last.status).toBe(429);
      expect(last.body.success).toBe(false);
    });

    it('tells the client how long to wait', async () => {
      const attempt = () =>
        api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });

      let last;
      for (let i = 0; i < 11; i += 1) {
        last = await attempt();
      }

      expect(last.headers['retry-after']).toBeDefined();
      expect(last.body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('reports remaining quota in the standard headers', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: 'nobody@example.com', password: 'wrong' });

      expect(res.headers['ratelimit-remaining']).toBeDefined();
    });
  });

  describe('POST /api/auth/register', () => {
    it('caps how many accounts one address can create', async () => {
      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await api()
          .post('/api/auth/register')
          .send({ name: `User ${i}`, email: `user${i}@example.com`, password: 'Karachi-Ledger-72' });
      }

      expect(last.status).toBe(429);
      // The sixth account must not exist — the limiter has to run before the
      // handler, not merely change the response after the write.
      expect(await User.countDocuments({})).toBe(5);
    });
  });
});

describe('Account lockout', () => {
  /**
   * The lockout is per account, so these tests disable the IP limiter to prove
   * the two defences are genuinely independent — a 429 here can only come from
   * the account counter.
   */
  beforeEach(async () => {
    await api().post('/api/auth/register').send(CREDENTIALS);
    env.rateLimitEnabled = false;
  });

  const wrongPassword = () =>
    api().post('/api/auth/login').send({ email: CREDENTIALS.email, password: 'wrong-password' });

  it('still returns 401 for the first few failures', async () => {
    for (let i = 0; i < 4; i += 1) {
      const res = await wrongPassword();
      expect(res.status).toBe(401);
    }
  });

  it('locks the account on the fifth consecutive failure', async () => {
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await wrongPassword();
    }

    // The fifth failure is still reported as a bad password; the lock applies
    // to the attempt after it.
    expect(last.status).toBe(401);

    const afterLock = await wrongPassword();
    expect(afterLock.status).toBe(429);
    expect(afterLock.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  /**
   * The important one: a locked account must refuse the CORRECT password too.
   * A lockout that lets the right password through protects nothing, because
   * an attacker's successful guess is exactly the request that gets in.
   */
  it('refuses even the correct password while locked', async () => {
    for (let i = 0; i < 5; i += 1) await wrongPassword();

    const res = await api()
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    expect(res.status).toBe(429);
  });

  it('backs off exponentially as failures continue', async () => {
    for (let i = 0; i < 5; i += 1) await wrongPassword();
    const firstLock = (await wrongPassword()).body.retryAfterSeconds;

    // Clear the lock so the next failure is recorded rather than short-circuited.
    await User.findOneAndUpdate({ email: CREDENTIALS.email }, { lockUntil: null });
    await wrongPassword();
    const secondLock = (await wrongPassword()).body.retryAfterSeconds;

    expect(secondLock).toBeGreaterThan(firstLock);
  });

  it('caps the wait so an account cannot be locked out indefinitely', async () => {
    for (let i = 0; i < 20; i += 1) {
      await User.findOneAndUpdate({ email: CREDENTIALS.email }, { lockUntil: null });
      await wrongPassword();
    }

    const res = await wrongPassword();

    // 15 minutes is the cap in models/User. Anything beyond it would hand an
    // attacker a way to permanently deny someone their own account.
    expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });

  it('lets the account back in once the lock expires', async () => {
    for (let i = 0; i < 6; i += 1) await wrongPassword();

    // Simulate the wait rather than sleeping through it.
    await User.findOneAndUpdate({ email: CREDENTIALS.email }, { lockUntil: new Date(Date.now() - 1000) });

    const res = await api()
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    expect(res.status).toBe(200);
  });

  it('clears the failure count after a successful sign-in', async () => {
    for (let i = 0; i < 3; i += 1) await wrongPassword();

    await api()
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    const user = await User.findOne({ email: CREDENTIALS.email }).select(
      '+failedLoginAttempts +lockUntil'
    );

    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockUntil).toBeNull();
  });

  it('never exposes the lockout counters in an API response', async () => {
    await wrongPassword();

    const res = await api()
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    expect(res.body.data.user.failedLoginAttempts).toBeUndefined();
    expect(res.body.data.user.lockUntil).toBeUndefined();
  });
});
