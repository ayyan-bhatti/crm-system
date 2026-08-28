const { api } = require('./helpers');
const User = require('../src/models/User');
const PasswordResetToken = require('../src/models/PasswordResetToken');
const RefreshToken = require('../src/models/RefreshToken');
const env = require('../src/config/env');
const mailer = require('../src/services/mailer');

/**
 * The forgot-password flow.
 *
 * Mail is captured rather than sent: `sendMail` is stubbed, so the tests can
 * read the link that would have gone out and follow it, which is the only way
 * to exercise the flow end to end without an email provider.
 */

const CREDENTIALS = {
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  password: 'Karachi-Ledger-72',
};

const NEW_PASSWORD = 'Lahore-Inventory-91';

describe('Password reset', () => {
  const realSendMail = mailer.sendMail;
  let sent;

  beforeEach(async () => {
    sent = [];
    mailer.sendMail = async (message) => {
      sent.push(message);
      return { delivered: true, transport: 'test' };
    };

    await api().post('/api/auth/register').send(CREDENTIALS);
  });

  afterEach(() => {
    mailer.sendMail = realSendMail;
  });

  /** Pull the token out of the link in the most recent message. */
  const tokenFromMail = () => {
    const match = sent[sent.length - 1].text.match(/reset-password\?token=([a-f0-9]+)/);
    return match && match[1];
  };

  const requestReset = (email = CREDENTIALS.email) =>
    api().post('/api/auth/forgot-password').send({ email });

  const submitReset = (token, password = NEW_PASSWORD) =>
    api().post('/api/auth/reset-password').send({ token, password });

  describe('requesting a reset', () => {
    it('emails a link to a real account', async () => {
      const res = await requestReset();

      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe(CREDENTIALS.email);
      expect(tokenFromMail()).toEqual(expect.any(String));
    });

    /**
     * THE ENUMERATION DEFENCE.
     *
     * "No account with that email" would be a free oracle: feed in a list of
     * addresses and learn which ones are customers. The response must be
     * byte-identical either way.
     */
    it('answers identically for an address with no account', async () => {
      const known = await requestReset();
      const unknown = await requestReset('nobody@example.com');

      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
    });

    it('issues no token for an address with no account', async () => {
      await requestReset('nobody@example.com');

      expect(await PasswordResetToken.countDocuments({})).toBe(0);
    });

    /**
     * A mistyped address gets an explanation rather than silence. It tells an
     * attacker nothing, because they cannot read the inbox.
     */
    it('still writes to an unknown address, explaining there is no account', async () => {
      await requestReset('nobody@example.com');

      expect(sent).toHaveLength(1);
      expect(sent[0].text).toMatch(/no simplecrm account/i);
    });

    it('accepts the address in any case', async () => {
      await requestReset('AYESHA@EXAMPLE.COM');

      expect(tokenFromMail()).toEqual(expect.any(String));
    });

    it('stores only a hash of the token', async () => {
      await requestReset();
      const token = tokenFromMail();

      const [record] = await PasswordResetToken.find({});

      expect(record.tokenHash).not.toBe(token);
      expect(record.tokenHash).toHaveLength(64);
    });

    /**
     * Otherwise every reset ever requested stays live until it expires, so a
     * user who clicks the link five times leaves five working keys to their
     * account scattered across their mailbox.
     */
    it('invalidates any earlier link when a new one is issued', async () => {
      await requestReset();
      const firstToken = tokenFromMail();

      await requestReset();

      const res = await submitReset(firstToken);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/already been used|not valid/i);
    });

    it('requires an email address', async () => {
      const res = await api().post('/api/auth/forgot-password').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('redeeming a link', () => {
    it('sets the new password', async () => {
      await requestReset();
      const res = await submitReset(tokenFromMail());

      expect(res.status).toBe(200);

      const login = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: NEW_PASSWORD });

      expect(login.status).toBe(200);
    });

    it('stops the old password working', async () => {
      await requestReset();
      await submitReset(tokenFromMail());

      const login = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

      expect(login.status).toBe(401);
    });

    /** Single use: a link left in an inbox must not stay a working key. */
    it('cannot be used twice', async () => {
      await requestReset();
      const token = tokenFromMail();

      await submitReset(token);
      const second = await submitReset(token, 'Multan-Traders-55');

      expect(second.status).toBe(400);
      expect(second.body.message).toMatch(/already been used/i);
    });

    it('rejects an expired link with a message that says so', async () => {
      await requestReset();
      const token = tokenFromMail();

      await PasswordResetToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

      const res = await submitReset(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/expired/i);
    });

    it('rejects a forged token', async () => {
      const res = await submitReset('f'.repeat(64));

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not valid/i);
    });

    it('requires both a token and a password', async () => {
      expect((await api().post('/api/auth/reset-password').send({ token: 'x' })).status).toBe(400);
      expect(
        (await api().post('/api/auth/reset-password').send({ password: NEW_PASSWORD })).status
      ).toBe(400);
    });

    it('applies the password policy', async () => {
      await requestReset();

      const res = await submitReset(tokenFromMail(), 'password123');

      expect(res.status).toBe(400);
      expect(Object.values(res.body.details || {}).join(' ')).toMatch(/common|mix at least/i);
    });

    /**
     * The token is single-use, so validating the password AFTER redeeming it
     * would burn the link on a rejected password — the user would be told their
     * password was too weak and that their link no longer works.
     */
    it('does not consume the link when the new password is rejected', async () => {
      await requestReset();
      const token = tokenFromMail();

      await submitReset(token, 'password123');

      // The same link still works with an acceptable password.
      const retry = await submitReset(token, NEW_PASSWORD);
      expect(retry.status).toBe(200);
    });

    /**
     * A reset is what someone does when they think they are compromised. If the
     * attacker's session survives it, the reset achieved nothing.
     */
    it('revokes every existing session', async () => {
      await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

      expect(await RefreshToken.countDocuments({ revokedAt: null })).toBeGreaterThan(0);

      await requestReset();
      await submitReset(tokenFromMail());

      expect(await RefreshToken.countDocuments({ revokedAt: null })).toBe(0);
    });

    /**
     * Someone who has just proved control of the mailbox should not then be
     * told to wait fifteen minutes because of earlier failed guesses.
     */
    it('clears an account lockout', async () => {
      env.rateLimitEnabled = false;

      for (let i = 0; i < 6; i += 1) {
        await api()
          .post('/api/auth/login')
          .send({ email: CREDENTIALS.email, password: 'wrong-password' });
      }

      await requestReset();
      await submitReset(tokenFromMail());

      const user = await User.findOne({ email: CREDENTIALS.email }).select(
        '+failedLoginAttempts +lockUntil'
      );

      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockUntil).toBeNull();

      const login = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: NEW_PASSWORD });

      expect(login.status).toBe(200);
    });
  });

  describe('the link itself', () => {
    it('points at the app, not the API', async () => {
      await requestReset();

      expect(sent[0].text).toContain(`${env.appUrl}/crm/reset-password?token=`);
    });

    it('tells the user it is single use and expires', async () => {
      await requestReset();

      expect(sent[0].text).toMatch(/works once/i);
      expect(sent[0].text).toMatch(/30 minutes/i);
    });

    /** Someone who did not request it should know they need do nothing. */
    it('reassures a recipient who did not ask for it', async () => {
      await requestReset();

      expect(sent[0].text).toMatch(/if you did not ask for this/i);
    });
  });
});
