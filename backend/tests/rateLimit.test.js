const { api } = require('./helpers');
const env = require('../src/config/env');
const User = require('../src/models/User');
const { RateLimitHit } = require('../src/middleware/mongoRateLimitStore');

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

/*
 * Counters now live in MongoDB rather than process memory, so resetting them is
 * asynchronous and must be awaited — a fire-and-forget reset would race the
 * first request of the next test and produce failures that look like flakes.
 */
async function resetLimiters() {
  await RateLimitHit.deleteMany({});
}

beforeEach(async () => {
  env.rateLimitEnabled = true;
  await resetLimiters();
});

afterEach(async () => {
  env.rateLimitEnabled = false;
  await resetLimiters();
});

describe('Per-IP rate limiting', () => {
  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);
      await resetLimiters(); // The registration above should not count against login.
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
    /**
     * The limiter runs BEFORE the controller, which is the thing being tested.
     *
     * The first five attempts are allowed through and create accounts. The
     * sixth is refused by the limiter and must therefore create nothing — so
     * the account count is what proves the ordering. A limiter that ran after
     * the handler, or one that only counted failures, would leave six.
     */
    it('caps how many registration attempts one address can make', async () => {
      let last;
      for (let i = 0; i < 6; i += 1) {
        last = await api()
          .post('/api/auth/register')
          .send({ name: `User ${i}`, email: `user${i}@example.com`, password: 'Karachi-Ledger-72' });
      }

      expect(last.status).toBe(429);
      // Five got through; the sixth never reached the controller.
      expect(await User.countDocuments({})).toBe(5);
    });

    /**
     * The same cap, with public sign-up closed. Attempts 2-5 are refused by the
     * controller (403) while the limiter counts them anyway, and the sixth is
     * refused by the limiter itself. Without that, a closed endpoint could be
     * hammered forever for free.
     */
    it('counts attempts the controller refuses, when sign-up is closed', async () => {
      const realSetting = env.allowPublicSignup;
      env.allowPublicSignup = false;

      try {
        let last;
        for (let i = 0; i < 6; i += 1) {
          last = await api().post('/api/auth/register').send({
            name: `User ${i}`,
            email: `user${i}@example.com`,
            password: 'Karachi-Ledger-72',
          });
        }

        expect(last.status).toBe(429);
        // Only the bootstrap admin was ever created.
        expect(await User.countDocuments({})).toBe(1);
      } finally {
        env.allowPublicSignup = realSetting;
      }
    });
  });

  /**
   * The public order-tracking lookup: order number + email is a two-factor
   * guess exactly like username + password, and this limiter is what makes
   * brute-forcing the second factor (the email, against an easily-enumerated
   * sequential order number) expensive per address — see
   * controllers/trackingController.js.
   */
  describe('POST /api/shop/track', () => {
    it('returns 429 once the window limit is exceeded', async () => {
      const attempt = () =>
        api().post('/api/shop/track').send({ orderNumber: 'ORD-000001', email: 'nobody@example.com' });

      let last;
      for (let i = 0; i < 11; i += 1) {
        last = await attempt();
      }

      expect(last.status).toBe(429);
      expect(last.body.success).toBe(false);
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


describe('the counters are shared, not per-process', () => {
  beforeEach(async () => {
    env.rateLimitEnabled = true;
    await RateLimitHit.deleteMany({});
  });

  afterEach(async () => {
    env.rateLimitEnabled = false;
    await RateLimitHit.deleteMany({});
  });

  /**
   * The point of moving the store into MongoDB.
   *
   * With the in-memory default, every serverless instance kept its own Map, so
   * the real limit was (configured limit x warm instances) and every counter
   * vanished when an instance recycled. Persisting the count is what makes the
   * limit mean what it says.
   */
  it('persists the count outside the process', async () => {
    await api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });

    const stored = await RateLimitHit.find({});

    expect(stored).toHaveLength(1);
    expect(stored[0].count).toBe(1);
    // A second instance reading this document sees the same count.
    expect(stored[0].key).toMatch(/^login:/);
  });

  /**
   * Each limiter keeps its own counters. Sharing one would make signing in
   * consume the sign-up budget for the same address.
   */
  it('keeps each limiter’s counters separate', async () => {
    await api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });
    await api()
      .post('/api/auth/register')
      .send({ name: 'A', email: 'a@example.com', password: 'Karachi-Ledger-72' });

    const keys = (await RateLimitHit.find({})).map((row) => row.key.split(':')[0]).sort();

    expect(keys).toEqual(['login', 'register']);
  });

  /** The window is bounded, so the collection cannot grow forever. */
  it('stamps every counter with an expiry', async () => {
    await api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });

    const [stored] = await RateLimitHit.find({});

    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * A window that has ended starts a fresh count rather than continuing the old
   * one. This matters because Mongo's TTL collector runs about once a minute,
   * so an expired document can still be present when the next request arrives.
   */
  it('starts a new window when the old one has expired', async () => {
    await api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });

    // Simulate the window having ended without waiting for it.
    await RateLimitHit.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

    await api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' });

    const [stored] = await RateLimitHit.find({});
    expect(stored.count).toBe(1);
  });

  /**
   * The increment is one atomic upsert, so a burst of simultaneous requests
   * each count — a read-then-write store would let them all read the same value
   * and all write value+1, hiding exactly the traffic this exists to catch.
   */
  it('counts every request in a simultaneous burst', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        api().post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong' })
      )
    );

    const [stored] = await RateLimitHit.find({});
    expect(stored.count).toBe(8);
  });
});
