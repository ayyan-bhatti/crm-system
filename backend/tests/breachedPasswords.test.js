const crypto = require('crypto');
const env = require('../src/config/env');
const { checkBreached, APPEARANCE_THRESHOLD } = require('../src/services/breachedPasswords');

/**
 * The breached-password check.
 *
 * `fetch` is stubbed throughout: a unit test must not depend on a third-party
 * service being reachable, and several hundred tests hitting a public API would
 * be slow as well as rude.
 *
 * The two properties worth proving here are privacy — that the password is
 * never transmitted — and that an unreachable service degrades the policy
 * rather than blocking every signup.
 */

const PASSWORD = 'Karachi-Ledger-72';

/** The SHA-1 split the way the k-anonymity protocol does. */
function hashParts(password) {
  const hash = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  return { prefix: hash.slice(0, 5), suffix: hash.slice(5) };
}

/** Stub fetch with a canned range response. */
function stubRange(lines, { ok = true } = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok,
    text: async () => lines.join('\n'),
  });
}

describe('checkBreached', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    // The service is disabled under NODE_ENV=test by default, so these tests
    // turn it on for themselves — otherwise they would assert nothing.
    env.breachCheckEnabled = true;
  });

  afterEach(() => {
    env.breachCheckEnabled = false;
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  /**
   * THE PRIVACY PROPERTY, and the reason using a third-party service for
   * something password-shaped is acceptable at all.
   *
   * Only the first five characters of the SHA-1 are sent. They match roughly
   * 800 hashes in the corpus, so the service cannot tell which was asked about.
   */
  it('sends only a five-character hash prefix, never the password', async () => {
    const { prefix, suffix } = hashParts(PASSWORD);
    stubRange([`${suffix}:2`]);

    await checkBreached(PASSWORD);

    const [url] = global.fetch.mock.calls[0];

    expect(url).toContain(prefix);
    expect(url).not.toContain(PASSWORD);
    expect(url).not.toContain(suffix);
    // Exactly five hex characters after the endpoint.
    expect(url).toMatch(/\/range\/[0-9A-F]{5}$/);
  });

  it('asks for a padded response, so the size leaks nothing either', async () => {
    stubRange([]);

    await checkBreached(PASSWORD);

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers['Add-Padding']).toBe('true');
  });

  it('reports a password found in the corpus', async () => {
    const { suffix } = hashParts(PASSWORD);
    stubRange([`${suffix}:4231`, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1']);

    const result = await checkBreached(PASSWORD);

    expect(result).toMatchObject({ breached: true, count: 4231, checked: true });
  });

  it('accepts a password the corpus does not hold', async () => {
    stubRange(['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:9999']);

    const result = await checkBreached(PASSWORD);

    expect(result).toMatchObject({ breached: false, checked: true });
  });

  /**
   * A single appearance may be a genuinely strong passphrase that happened to
   * be in one dump. Rejecting it teaches people the rules are arbitrary.
   */
  it('tolerates a password that appears only once or twice', async () => {
    const { suffix } = hashParts(PASSWORD);
    stubRange([`${suffix}:2`]);

    const result = await checkBreached(PASSWORD);

    expect(result.breached).toBe(false);
    expect(result.count).toBe(2);
  });

  it('rejects once the appearance count crosses the threshold', async () => {
    const { suffix } = hashParts(PASSWORD);
    stubRange([`${suffix}:${APPEARANCE_THRESHOLD}`]);

    expect((await checkBreached(PASSWORD)).breached).toBe(true);
  });

  describe('failing open', () => {
    /**
     * The deliberate trade-off. Refusing to let anyone sign up because a
     * third-party service is unreachable swaps a strong password policy for an
     * outage. The local rules still apply, so the policy degrades rather than
     * disappearing — `checked: false` is how the caller knows.
     */
    it('does not block a password when the service times out', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted'));

      const result = await checkBreached(PASSWORD);

      expect(result).toMatchObject({ breached: false, checked: false });
    });

    it('does not block a password when the service errors', async () => {
      stubRange([], { ok: false });

      expect(await checkBreached(PASSWORD)).toMatchObject({ breached: false, checked: false });
    });

    it('does not block a password when the network is unreachable', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

      expect(await checkBreached(PASSWORD)).toMatchObject({ breached: false, checked: false });
    });

    /** An air-gapped deployment turns the check off entirely. */
    it('skips the call when disabled by configuration', async () => {
      env.breachCheckEnabled = false;
      global.fetch = jest.fn();

      const result = await checkBreached(PASSWORD);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(result.checked).toBe(false);
    });
  });

  it('bounds how long a user waits on it', async () => {
    stubRange([]);

    await checkBreached(PASSWORD);

    const [, options] = global.fetch.mock.calls[0];
    // An AbortSignal with a deadline, rather than an unbounded request sitting
    // in front of someone waiting for a signup to finish.
    expect(options.signal).toBeDefined();
  });
});

describe('registration with the breach check active', () => {
  const { api } = require('./helpers');
  const realFetch = global.fetch;

  beforeEach(() => {
    env.breachCheckEnabled = true;
  });

  afterEach(() => {
    env.breachCheckEnabled = false;
    global.fetch = realFetch;
  });

  it('refuses a breached password with an explanation', async () => {
    const { suffix } = hashParts('Correct-Horse-Battery-99');
    stubRange([`${suffix}:15000`]);

    const res = await api().post('/api/auth/register').send({
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      password: 'Correct-Horse-Battery-99',
    });

    expect(res.status).toBe(400);
    expect(Object.values(res.body.details).join(' ')).toMatch(/data breaches/i);
  });

  it('accepts a password the corpus does not hold', async () => {
    stubRange(['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:1']);

    const res = await api().post('/api/auth/register').send({
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      password: 'Correct-Horse-Battery-99',
    });

    expect(res.status).toBe(201);
  });

  /**
   * The network round trip is skipped when the local rules have already
   * rejected the password — the user has to change it either way, so there is
   * nothing to learn from the corpus.
   */
  it('does not call the service when the local rules already failed', async () => {
    global.fetch = jest.fn();

    await api()
      .post('/api/auth/register')
      .send({ name: 'A', email: 'a@example.com', password: 'short' });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still registers when the service is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND'));

    const res = await api().post('/api/auth/register').send({
      name: 'Ayesha Khan',
      email: 'ayesha@example.com',
      password: 'Correct-Horse-Battery-99',
    });

    expect(res.status).toBe(201);
  });
});
