const request = require('supertest');
const app = require('../src/app');
const { api } = require('./helpers');
const User = require('../src/models/User');
const RefreshToken = require('../src/models/RefreshToken');
const { checkPassword } = require('../src/utils/passwordPolicy');
const { CSRF_COOKIE, CSRF_HEADER } = require('../src/middleware/csrf');

/**
 * Password policy and password change.
 *
 * The policy is deliberately NOT "8 characters with a capital and a number" —
 * see the reasoning at the top of utils/passwordPolicy.js. These tests pin the
 * rules that reasoning produced, so a future change to the policy has to be a
 * decision rather than an accident.
 */

const STRONG = 'Karachi-Ledger-72';

const CREDENTIALS = {
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  password: STRONG,
};

function cookieValue(res, name) {
  const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  if (!header) return null;
  return decodeURIComponent(header.slice(name.length + 1).split(';')[0]);
}

describe('Password policy', () => {
  describe('the rules themselves', () => {
    it('accepts a strong password', () => {
      expect(checkPassword(STRONG, CREDENTIALS)).toEqual([]);
    });

    it('rejects anything under 10 characters', () => {
      expect(checkPassword('Ab3!efgh')).not.toEqual([]);
    });

    /**
     * Length substitutes for variety. A passphrase is stronger than a short
     * password full of symbols, and rejecting it for "lacking a number" is the
     * rule that pushes everyone towards Password1!.
     */
    it('accepts a long all-lowercase passphrase', () => {
      expect(checkPassword('correct horse battery staple')).toEqual([]);
    });

    it('requires variety from a short-but-legal password', () => {
      // 10 characters, one class only.
      expect(checkPassword('abcdefghij')).not.toEqual([]);
      // Same length, three classes.
      expect(checkPassword('abcDEF1234')).toEqual([]);
    });

    it('rejects passwords from the common list', () => {
      expect(checkPassword('password123')).not.toEqual([]);
      expect(checkPassword('qwertyuiop')).not.toEqual([]);
    });

    /**
     * The blocklist compares a normalised form, so the usual substitutions do
     * not smuggle a common password past it.
     */
    it('sees through character substitutions', () => {
      expect(checkPassword('P@ssw0rd123')).not.toEqual([]);
    });

    it('rejects a password containing the account email', () => {
      expect(checkPassword('ayesha-Ledger-72', CREDENTIALS)).not.toEqual([]);
    });

    it('rejects a password containing the account name', () => {
      expect(checkPassword('Ayesha!Ledger72', CREDENTIALS)).not.toEqual([]);
    });

    /**
     * Not a style rule — bcrypt silently truncates at 72 bytes, so accepting a
     * longer password would store something weaker than the user typed and two
     * different passwords sharing a prefix would both work.
     */
    it('rejects a password longer than bcrypt can actually hash', () => {
      expect(checkPassword(`${'a'.repeat(60)}Bc3!${'d'.repeat(20)}`)).not.toEqual([]);
    });

    /**
     * Telling someone their password is too short, watching them fix it, then
     * telling them it also contains their name is a small cruelty a single
     * list avoids.
     */
    it('reports every problem at once rather than one at a time', () => {
      expect(checkPassword('ayesha', CREDENTIALS).length).toBeGreaterThan(1);
    });
  });

  describe('POST /api/auth/register', () => {
    it('rejects a weak password with 400 and an explanation', async () => {
      const res = await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'a@example.com', password: 'password123' });

      expect(res.status).toBe(400);
      expect(Object.values(res.body.details).join(' ')).toMatch(/common/i);
    });

    it('does not create the account when the password is rejected', async () => {
      await api()
        .post('/api/auth/register')
        .send({ name: 'Ayesha', email: 'a@example.com', password: 'short' });

      expect(await User.countDocuments({})).toBe(0);
    });

    it('accepts a password that meets the policy', async () => {
      const res = await api().post('/api/auth/register').send(CREDENTIALS);
      expect(res.status).toBe(201);
    });
  });
});

describe('POST /api/auth/change-password', () => {
  /** A signed-in browser session, with the CSRF token this endpoint requires. */
  async function signedIn() {
    const agent = request.agent(app);
    const res = await agent.post('/api/auth/register').send(CREDENTIALS);
    const csrf = cookieValue(res, CSRF_COOKIE);

    return {
      agent,
      change: (body) =>
        agent.post('/api/auth/change-password').set(CSRF_HEADER, csrf).send(body),
    };
  }

  it('changes the password when the current one is correct', async () => {
    const { change } = await signedIn();

    const res = await change({
      currentPassword: STRONG,
      newPassword: 'Lahore-Inventory-91',
    });

    expect(res.status).toBe(200);

    const login = await api()
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: 'Lahore-Inventory-91' });

    expect(login.status).toBe(200);
  });

  /**
   * Without this check, anyone at an unlocked laptop — or holding a stolen
   * access token — could lock the real owner out of their own account.
   */
  it('refuses without the current password', async () => {
    const { change } = await signedIn();

    const res = await change({
      currentPassword: 'not-the-password',
      newPassword: 'Lahore-Inventory-91',
    });

    expect(res.status).toBe(401);
  });

  /** A policy enforced on only one of the two paths that set a password is not a policy. */
  it('applies the same strength policy as registration', async () => {
    const { change } = await signedIn();

    const res = await change({ currentPassword: STRONG, newPassword: 'password123' });

    expect(res.status).toBe(400);
  });

  it('refuses to "change" the password to the same value', async () => {
    const { change } = await signedIn();

    const res = await change({ currentPassword: STRONG, newPassword: STRONG });

    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await api()
      .post('/api/auth/change-password')
      .send({ currentPassword: STRONG, newPassword: 'Lahore-Inventory-91' });

    expect(res.status).toBe(401);
  });

  /**
   * The point of changing a password after a suspected compromise. If the
   * attacker's session survives it, the change achieved nothing.
   */
  it('revokes every other session', async () => {
    // Two separate logins: this browser, and the "attacker's".
    await api().post('/api/auth/register').send(CREDENTIALS);
    const other = await api()
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    const otherRefresh = cookieValue(other, 'simplecrm_refresh');

    const login = await api()
      .post('/api/auth/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    await api()
      .post('/api/auth/change-password')
      .set({ Authorization: `Bearer ${login.body.data.token}` })
      .send({ currentPassword: STRONG, newPassword: 'Lahore-Inventory-91' });

    const stillWorks = await api()
      .post('/api/auth/refresh')
      .set('Cookie', `simplecrm_refresh=${otherRefresh}`);

    expect(stillWorks.status).toBe(401);
  });

  /** ...while leaving the device that made the change signed in. */
  it('issues a fresh session for the device that changed the password', async () => {
    const { agent, change } = await signedIn();

    await change({ currentPassword: STRONG, newPassword: 'Lahore-Inventory-91' });

    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
  });

  it('leaves no usable refresh token behind from the old sessions', async () => {
    const { change } = await signedIn();

    await change({ currentPassword: STRONG, newPassword: 'Lahore-Inventory-91' });

    // Exactly one live token: the new session issued to this device.
    expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(1);
  });
});

describe('Security headers', () => {
  it('sets a restrictive content security policy on API responses', async () => {
    const res = await api().get('/api/health');

    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
  });

  it('refuses to be framed', async () => {
    const res = await api().get('/api/health');

    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('blocks MIME sniffing', async () => {
    const res = await api().get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  /** Record ids live in our URLs, so a full Referer would leak them off-site. */
  it('does not leak URLs to other origins via the Referer header', async () => {
    const res = await api().get('/api/health');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
