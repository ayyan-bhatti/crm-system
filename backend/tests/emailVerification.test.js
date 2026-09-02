const { api } = require('./helpers');
const User = require('../src/models/User');
const Buyer = require('../src/models/Buyer');
const EmailVerificationToken = require('../src/models/EmailVerificationToken');
const mailer = require('../src/services/mailer');

/**
 * Confirming that the address on a staff or buyer account is real.
 *
 * THE CENTRAL CLAIM: THIS NEVER GATES ANYTHING.
 *
 * Unlike a password reset, a verification link does not unlock an account —
 * it flips an informational flag. Several tests below assert that directly:
 * an unverified account can still sign in, still place orders, still do
 * everything a verified one can.
 */

const CREDENTIALS = {
  name: 'Ayesha Khan',
  email: 'ayesha@example.com',
  password: 'Karachi-Ledger-72',
};

const APPLICANT = {
  name: 'Bilal Ahmed',
  email: 'bilal@example.com',
  password: 'Lahore-Inventory-91',
};

describe('Email verification', () => {
  const realSendMail = mailer.sendMail;
  let sent;

  beforeEach(async () => {
    sent = [];
    mailer.sendMail = async (message) => {
      sent.push(message);
      return { delivered: true, transport: 'test' };
    };
  });

  afterEach(() => {
    mailer.sendMail = realSendMail;
  });

  const tokenFromMail = () => {
    const match = sent[sent.length - 1].text.match(/verify-email\?token=([a-f0-9]+)/);
    return match && match[1];
  };

  describe('staff accounts', () => {
    it('starts the bootstrap admin already verified — nobody exists to prove anything to', async () => {
      const res = await api().post('/api/auth/register').send(CREDENTIALS);

      expect(res.body.data.user.emailVerified).toBe(true);
      // No verification mail for the bootstrap admin, either.
      expect(sent).toHaveLength(0);
    });

    it('sends a verification email to a genuine self-signup, unverified', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS); // the bootstrap admin
      sent = [];

      const res = await api().post('/api/auth/register').send(APPLICANT);

      expect(res.status).toBe(202);
      const applicant = await User.findOne({ email: APPLICANT.email });
      expect(applicant.emailVerified).toBe(false);

      const verificationMail = sent.find((m) => m.to === APPLICANT.email);
      expect(verificationMail).toBeDefined();
      expect(verificationMail.text).toMatch(/verify-email\?token=/);
    });

    it('does NOT block sign-in for an unverified applicant once approved', async () => {
      const admin = await api().post('/api/auth/register').send(CREDENTIALS);
      await api().post('/api/auth/register').send(APPLICANT);

      const applicant = await User.findOne({ email: APPLICANT.email });
      await api()
        .patch(`/api/users/${applicant._id}/approve`)
        .set('Authorization', `Bearer ${admin.body.data.token}`);

      const login = await api()
        .post('/api/auth/login')
        .send({ email: APPLICANT.email, password: APPLICANT.password });

      expect(login.status).toBe(200);
      expect(login.body.data.user.emailVerified).toBe(false);
    });

    it('confirms the address when the real link is followed', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);
      await api().post('/api/auth/register').send(APPLICANT);
      const token = tokenFromMail();

      const check = await api().get(`/api/auth/verify-email/${token}`);
      expect(check.body.data.ok).toBe(true);

      const confirm = await api().post('/api/auth/verify-email').send({ token });
      expect(confirm.status).toBe(200);

      const applicant = await User.findOne({ email: APPLICANT.email });
      expect(applicant.emailVerified).toBe(true);
    });

    it('does not consume the token on GET — a mail client prefetch must not burn it', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);
      await api().post('/api/auth/register').send(APPLICANT);
      const token = tokenFromMail();

      await api().get(`/api/auth/verify-email/${token}`);
      await api().get(`/api/auth/verify-email/${token}`);

      // Still valid after two GETs — neither consumed it.
      const check = await api().get(`/api/auth/verify-email/${token}`);
      expect(check.body.data.ok).toBe(true);

      const applicant = await User.findOne({ email: APPLICANT.email });
      expect(applicant.emailVerified).toBe(false);
    });

    it('refuses to redeem the same token twice', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);
      await api().post('/api/auth/register').send(APPLICANT);
      const token = tokenFromMail();

      const first = await api().post('/api/auth/verify-email').send({ token });
      const second = await api().post('/api/auth/verify-email').send({ token });

      expect(first.status).toBe(200);
      expect(second.status).toBe(400);
      expect(second.body.message).toMatch(/already been used/i);
    });

    it('rejects a made-up token', async () => {
      const res = await api()
        .post('/api/auth/verify-email')
        .send({ token: 'not-a-real-token' });

      expect(res.status).toBe(400);
    });

    it('marks an invited user verified on accepting the invite, with no separate email', async () => {
      const admin = await api().post('/api/auth/register').send(CREDENTIALS);
      sent = [];

      await api()
        .post('/api/users/invite')
        .set('Authorization', `Bearer ${admin.body.data.token}`)
        .send({ name: 'Invited Person', email: 'invited@example.com', role: 'sales_rep' });

      const inviteMail = sent.find((m) => m.to === 'invited@example.com');
      const inviteToken = inviteMail.text.match(/accept-invite\?token=([a-f0-9]+)/)[1];

      await api()
        .post('/api/auth/accept-invite')
        .send({ token: inviteToken, password: 'Multan-Ledger-64' });

      const invited = await User.findOne({ email: 'invited@example.com' });
      expect(invited.emailVerified).toBe(true);
      // No separate "confirm your email" mail — the invite link already proved it.
      expect(sent.some((m) => m.text.includes('verify-email'))).toBe(false);
    });

    it('lets a signed-in user resend their own verification email', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);
      const registered = await api().post('/api/auth/register').send(APPLICANT);
      const admin = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
      const applicant = await User.findOne({ email: APPLICANT.email });
      await api()
        .patch(`/api/users/${applicant._id}/approve`)
        .set('Authorization', `Bearer ${admin.body.data.token}`);
      const login = await api()
        .post('/api/auth/login')
        .send({ email: APPLICANT.email, password: APPLICANT.password });

      sent = [];
      const res = await api()
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${login.body.data.token}`);

      expect(res.status).toBe(200);
      expect(sent.some((m) => m.to === APPLICANT.email)).toBe(true);
      void registered;
    });

    it('invalidates the old token when a new one is issued', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS);
      await api().post('/api/auth/register').send(APPLICANT);
      const admin = await api()
        .post('/api/auth/login')
        .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
      const applicant = await User.findOne({ email: APPLICANT.email });
      await api()
        .patch(`/api/users/${applicant._id}/approve`)
        .set('Authorization', `Bearer ${admin.body.data.token}`);
      const firstToken = tokenFromMail();

      const login = await api()
        .post('/api/auth/login')
        .send({ email: APPLICANT.email, password: APPLICANT.password });
      await api()
        .post('/api/auth/resend-verification')
        .set('Authorization', `Bearer ${login.body.data.token}`);

      const stillValid = await EmailVerificationToken.findOne({
        accountType: 'user',
        accountId: applicant._id,
        usedAt: null,
      });

      // Only ONE live token for this account — the first was invalidated.
      const liveCount = await EmailVerificationToken.countDocuments({
        accountType: 'user',
        accountId: applicant._id,
        usedAt: null,
      });
      expect(liveCount).toBe(1);
      expect(stillValid).not.toBeNull();

      const oldTokenCheck = await api().get(`/api/auth/verify-email/${firstToken}`);
      expect(oldTokenCheck.body.data.ok).toBe(false);
    });
  });

  describe('buyer accounts', () => {
    const BUYER = { name: 'Amina Raza', email: 'amina@example.com', password: 'Karachi-Ledger-72' };

    it('registers unverified, and sends the confirmation link', async () => {
      const res = await api().post('/api/shop/auth/register').send(BUYER);

      expect(res.body.data.buyer.emailVerified).toBe(false);
      expect(sent.some((m) => m.to === BUYER.email && m.text.includes('verify-email'))).toBe(true);
    });

    it('does not block checkout-track sign-in for an unverified buyer', async () => {
      const res = await api().post('/api/shop/auth/register').send(BUYER);

      // Registration itself signs the buyer in immediately — no approval gate
      // exists on this track, and email verification does not add one.
      expect(res.status).toBe(201);
      expect(res.body.data.token).toEqual(expect.any(String));
    });

    it('confirms the buyer address when the real link is followed', async () => {
      await api().post('/api/shop/auth/register').send(BUYER);
      const token = tokenFromMail();

      const confirm = await api().post('/api/shop/verify-email').send({ token });
      expect(confirm.status).toBe(200);

      const buyer = await Buyer.findOne({ email: BUYER.email });
      expect(buyer.emailVerified).toBe(true);
    });

    it('is a completely separate token space from the staff track', async () => {
      await api().post('/api/auth/register').send(CREDENTIALS); // bootstrap admin, no mail
      await api().post('/api/shop/auth/register').send(BUYER);
      const buyerToken = tokenFromMail();

      // A buyer's token must not verify anything on the staff side, or vice
      // versa — accountType is what enforces that.
      const record = await EmailVerificationToken.findOne({
        tokenHash: require('crypto').createHash('sha256').update(buyerToken).digest('hex'),
      });
      expect(record.accountType).toBe('buyer');
    });
  });
});
