const { api, createAdmin, createManager, createRep } = require('./helpers');
const User = require('../src/models/User');
const InviteToken = require('../src/models/InviteToken');
const RefreshToken = require('../src/models/RefreshToken');
const mailer = require('../src/services/mailer');

/**
 * Invite-based user management.
 *
 * Mail is captured rather than sent, so the tests can read the link that would
 * have gone out and follow it — the only way to exercise the flow end to end
 * without an email provider.
 *
 * The properties that matter most here are the ones that make this a security
 * improvement rather than just a nicer signup: a pending account cannot
 * authenticate, a deactivated one is cut off mid-session, and a manager cannot
 * use the invite endpoint to mint an administrator.
 */

const PASSWORD = 'Karachi-Ledger-72';

describe('Invitations', () => {
  const realSendMail = mailer.sendMail;
  let sent;
  let admin;

  beforeEach(async () => {
    sent = [];
    mailer.sendMail = async (message) => {
      sent.push(message);
      return { delivered: true, transport: 'test' };
    };

    admin = await createAdmin();
  });

  afterEach(() => {
    mailer.sendMail = realSendMail;
  });

  const tokenFromMail = () => {
    const match = sent[sent.length - 1].text.match(/accept-invite\?token=([a-f0-9]+)/);
    return match && match[1];
  };

  const invite = (body, actor = admin) =>
    api().post('/api/users/invite').set(actor.headers).send(body);

  const NEW_HIRE = { name: 'Bilal Ahmed', email: 'bilal@example.com', role: 'sales_rep' };

  describe('sending an invitation', () => {
    it('creates a pending account and emails a link', async () => {
      const res = await invite(NEW_HIRE);

      expect(res.status).toBe(201);

      const user = await User.findOne({ email: NEW_HIRE.email });
      expect(user.status).toBe('pending');
      expect(sent[0].to).toBe(NEW_HIRE.email);
      expect(tokenFromMail()).toEqual(expect.any(String));
    });

    /**
     * The account exists but has NO password — that is what makes it safe to
     * create it before the invitee has done anything.
     */
    it('creates the account with no password at all', async () => {
      await invite(NEW_HIRE);

      const user = await User.findOne({ email: NEW_HIRE.email }).select('+password');
      expect(user.password).toBeUndefined();
    });

    it('stores only a hash of the token', async () => {
      await invite(NEW_HIRE);
      const token = tokenFromMail();

      const [record] = await InviteToken.find({});
      expect(record.tokenHash).not.toBe(token);
      expect(record.tokenHash).toHaveLength(64);
    });

    it('records who sent it', async () => {
      await invite(NEW_HIRE);

      const user = await User.findOne({ email: NEW_HIRE.email });
      expect(String(user.invitedBy)).toBe(String(admin.user._id));
    });

    it('defaults to the least-privileged role', async () => {
      await invite({ name: 'Bilal', email: 'bilal@example.com' });

      expect((await User.findOne({ email: 'bilal@example.com' })).role).toBe('sales_rep');
    });

    it('refuses an email that already has an active account', async () => {
      const existing = await createRep();

      const res = await invite({ name: 'Duplicate', email: existing.user.email });

      expect(res.status).toBe(409);
    });

    /**
     * Re-sending is the common case — the first invite went to spam, or was
     * sent before the person's start date. Treating it as a duplicate would
     * force the admin to delete and recreate the account.
     */
    it('re-sends to a pending user instead of refusing', async () => {
      await invite(NEW_HIRE);
      const res = await invite(NEW_HIRE);

      expect(res.status).toBe(200);
      expect(sent).toHaveLength(2);
      expect(await User.countDocuments({ email: NEW_HIRE.email })).toBe(1);
    });

    /** Otherwise a re-send leaves two working links in two inboxes. */
    it('invalidates the earlier link when re-sending', async () => {
      await invite(NEW_HIRE);
      const firstToken = tokenFromMail();

      await invite(NEW_HIRE);

      const res = await api()
        .post('/api/auth/accept-invite')
        .send({ token: firstToken, password: PASSWORD });

      expect(res.status).toBe(400);
    });

    it('lets a re-invite correct the name and role', async () => {
      await invite({ name: 'Bilal', email: 'bilal@example.com', role: 'sales_rep' });
      await invite({ name: 'Bilal Ahmed', email: 'bilal@example.com', role: 'manager' });

      const user = await User.findOne({ email: 'bilal@example.com' });
      expect(user.name).toBe('Bilal Ahmed');
      expect(user.role).toBe('manager');
    });

    it('requires a name and an email', async () => {
      expect((await invite({ email: 'a@b.co' })).status).toBe(400);
      expect((await invite({ name: 'No Email' })).status).toBe(400);
    });

    /**
     * The invite link is withheld when the invitee genuinely received one.
     * Their inbox should be the only place it exists — there is no reason for
     * a second copy to travel back to the admin's browser.
     */
    it('does not return the link when mail actually went out', async () => {
      const res = await invite(NEW_HIRE);

      expect(res.body.meta).toMatchObject({ emailed: true });
      expect(res.body.meta.inviteLink).toBeUndefined();
      expect(res.body.message).toMatch(/emailed/i);
    });
  });

  /**
   * WHAT THIS DESCRIBE BLOCK IS ACTUALLY ABOUT.
   *
   * With no mail provider configured — which is the state of any deployment
   * that has not bought one — the console transport writes the invite to the
   * log and nowhere else. The endpoint still answered "Invitation sent", so the
   * feature looked like it worked and did not: the admin waited for a delivery
   * that never happened, the invitee never got an email, and the only copy of
   * the link was in a log neither of them reads.
   *
   * So the response now says what actually happened, and hands the link back so
   * the admin can pass it on themselves.
   */
  describe('when no mail transport is configured', () => {
    beforeEach(() => {
      mailer.sendMail = async (message) => {
        sent.push(message);
        return { delivered: true, transport: 'console' };
      };
    });

    it('returns the invite link so the admin can share it', async () => {
      const res = await invite(NEW_HIRE);

      expect(res.status).toBe(201);
      expect(res.body.meta.emailed).toBe(false);
      expect(res.body.meta.inviteLink).toMatch(/\/accept-invite\?token=[a-f0-9]{64}$/);
    });

    /** Saying "sent" when nothing was sent is the bug being fixed. */
    it('does not claim an email was sent', async () => {
      const res = await invite(NEW_HIRE);

      expect(res.body.message).not.toMatch(/emailed/i);
      expect(res.body.message).toMatch(/no email was sent/i);
    });

    /** A link that cannot be redeemed would be worse than no link. */
    it('returns a link that actually works', async () => {
      const res = await invite(NEW_HIRE);
      const token = res.body.meta.inviteLink.match(/token=([a-f0-9]+)/)[1];

      const accepted = await api()
        .post('/api/auth/accept-invite')
        .send({ token, password: 'Karachi-Ledger-72' });

      expect(accepted.status).toBe(201);

      const login = await api()
        .post('/api/auth/login')
        .send({ email: NEW_HIRE.email, password: 'Karachi-Ledger-72' });

      expect(login.status).toBe(200);
    });

    it('returns a fresh link on a re-invite, and the message says so', async () => {
      const first = await invite(NEW_HIRE);
      const second = await invite(NEW_HIRE);

      expect(second.status).toBe(200);
      expect(second.body.meta.inviteLink).toBeDefined();
      expect(second.body.meta.inviteLink).not.toBe(first.body.meta.inviteLink);
      expect(second.body.message).toMatch(/no longer works/i);
    });

    /**
     * A failed webhook is the same situation as no transport at all: nothing
     * reached the invitee, so the admin needs the link.
     */
    it('returns the link when delivery failed outright', async () => {
      mailer.sendMail = async () => ({ delivered: false, transport: 'webhook' });

      const res = await invite(NEW_HIRE);

      expect(res.status).toBe(201);
      expect(res.body.meta.emailed).toBe(false);
      expect(res.body.meta.inviteLink).toBeDefined();
    });
  });

  describe('who may invite', () => {
    it('allows a manager, so onboarding does not bottleneck on one admin', async () => {
      const manager = await createManager();

      const res = await invite(NEW_HIRE, manager);

      expect(res.status).toBe(201);
    });

    /**
     * THE PRIVILEGE-ESCALATION GUARD. A manager who could mint an admin account
     * would effectively be an admin.
     */
    it('stops a manager inviting an administrator', async () => {
      const manager = await createManager();

      const res = await invite({ ...NEW_HIRE, role: 'admin' }, manager);

      expect(res.status).toBe(403);
      expect(await User.countDocuments({ email: NEW_HIRE.email })).toBe(0);
    });

    it('lets an admin invite an administrator', async () => {
      const res = await invite({ ...NEW_HIRE, role: 'admin' });

      expect(res.status).toBe(201);
    });

    it('refuses a sales rep', async () => {
      const rep = await createRep();

      expect((await invite(NEW_HIRE, rep)).status).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      expect((await api().post('/api/users/invite').send(NEW_HIRE)).status).toBe(401);
    });
  });

  describe('a pending account cannot be used', () => {
    beforeEach(async () => {
      await invite(NEW_HIRE);
    });

    /** No password means nothing can match — and it must not 500 trying. */
    it('cannot sign in, whatever password is tried', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: NEW_HIRE.email, password: PASSWORD });

      expect(res.status).toBe(401);
    });

    it('cannot sign in with an empty password either', async () => {
      const res = await api()
        .post('/api/auth/login')
        .send({ email: NEW_HIRE.email, password: '' });

      expect(res.status).toBe(400);
    });
  });

  describe('previewing an invitation', () => {
    it('says who it is for and which role it grants', async () => {
      await invite(NEW_HIRE);

      const res = await api().get(`/api/auth/invite/${tokenFromMail()}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        name: NEW_HIRE.name,
        email: NEW_HIRE.email,
        role: 'sales_rep',
      });
    });

    it('refuses a forged token', async () => {
      expect((await api().get(`/api/auth/invite/${'f'.repeat(64)}`)).status).toBe(400);
    });
  });

  describe('accepting an invitation', () => {
    beforeEach(async () => {
      await invite(NEW_HIRE);
    });

    const accept = (token, password = PASSWORD) =>
      api().post('/api/auth/accept-invite').send({ token, password });

    it('sets the password and activates the account', async () => {
      const res = await accept(tokenFromMail());

      expect(res.status).toBe(201);
      expect((await User.findOne({ email: NEW_HIRE.email })).status).toBe('active');
    });

    /**
     * Signed in on the spot: they have just proved control of the mailbox AND
     * chosen the credential, so asking them to retype it gains nothing.
     */
    it('signs the new user in immediately', async () => {
      const res = await accept(tokenFromMail());

      const cookies = res.headers['set-cookie'] || [];
      expect(cookies.some((c) => c.startsWith('simplecrm_access'))).toBe(true);
      expect(res.body.data.user.email).toBe(NEW_HIRE.email);
    });

    it('lets the new user sign in normally afterwards', async () => {
      await accept(tokenFromMail());

      const login = await api()
        .post('/api/auth/login')
        .send({ email: NEW_HIRE.email, password: PASSWORD });

      expect(login.status).toBe(200);
    });

    it('cannot be used twice', async () => {
      const token = tokenFromMail();
      await accept(token);

      const second = await accept(token, 'Lahore-Inventory-91');

      expect(second.status).toBe(400);
      expect(second.body.message).toMatch(/already been used/i);
    });

    it('rejects an expired invitation with a message that says so', async () => {
      const token = tokenFromMail();
      await InviteToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

      const res = await accept(token);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/expired/i);
    });

    it('applies the password policy', async () => {
      const res = await accept(tokenFromMail(), 'password123');

      expect(res.status).toBe(400);
    });

    /** The invite is single use, so a rejected password must not burn it. */
    it('does not consume the invitation when the password is rejected', async () => {
      const token = tokenFromMail();

      await accept(token, 'password123');
      const retry = await accept(token, PASSWORD);

      expect(retry.status).toBe(201);
    });

    it('requires both a token and a password', async () => {
      expect((await api().post('/api/auth/accept-invite').send({ token: 'x' })).status).toBe(400);
    });
  });
});

describe('Deactivating and reactivating', () => {
  let admin;
  let victim;

  beforeEach(async () => {
    admin = await createAdmin();
    /*
     * A MANAGER, not a sales rep.
     *
     * The test proves an existing session dies on the next request, and it
     * proves it by watching a request that used to succeed start failing. A rep
     * has no access to /api/customers any more, so that request was already a
     * 403 and the test would have passed whether deactivation worked or not.
     */
    victim = await createManager();
  });

  const setStatus = (id, status, actor = admin) =>
    api().patch(`/api/users/${id}/status`).set(actor.headers).send({ status });

  it('deactivates an account', async () => {
    const res = await setStatus(victim.user._id, 'deactivated');

    expect(res.status).toBe(200);
    expect((await User.findById(victim.user._id)).status).toBe('deactivated');
  });

  it('stops a deactivated user signing in', async () => {
    await setStatus(victim.user._id, 'deactivated');

    const res = await api()
      .post('/api/auth/login')
      .send({ email: victim.user.email, password: 'Karachi-Ledger-72' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/deactivated/i);
  });

  /**
   * THE ONE THAT MATTERS MOST.
   *
   * Checking only at login would leave an offboarded employee working normally
   * until their access token expired — up to fifteen minutes of continued
   * access to the customer list after someone pressed deactivate. `protect`
   * reloads the user every request, so it takes effect on the next one.
   */
  it('cuts off an EXISTING session on the very next request', async () => {
    // The session is working before.
    expect((await api().get('/api/customers').set(victim.headers)).status).toBe(200);

    await setStatus(victim.user._id, 'deactivated');

    // ...and dead immediately after, with no new login required.
    const after = await api().get('/api/customers').set(victim.headers);
    expect(after.status).toBe(401);
  });

  it('revokes the refresh token so the session cannot be resurrected', async () => {
    await api()
      .post('/api/auth/login')
      .send({ email: victim.user.email, password: 'Karachi-Ledger-72' });

    expect(await RefreshToken.countDocuments({ user: victim.user._id, revokedAt: null })).toBe(1);

    await setStatus(victim.user._id, 'deactivated');

    expect(await RefreshToken.countDocuments({ user: victim.user._id, revokedAt: null })).toBe(0);
  });

  it('reactivates an account', async () => {
    await setStatus(victim.user._id, 'deactivated');
    await setStatus(victim.user._id, 'active');

    const login = await api()
      .post('/api/auth/login')
      .send({ email: victim.user.email, password: 'Karachi-Ledger-72' });

    expect(login.status).toBe(200);
  });

  /** Unrecoverable through the UI on a single-admin install. */
  it('stops an admin deactivating themselves', async () => {
    const res = await setStatus(admin.user._id, 'deactivated');

    expect(res.status).toBe(400);
    expect((await User.findById(admin.user._id)).status).toBe('active');
  });

  it('refuses a status that is not active or deactivated', async () => {
    expect((await setStatus(victim.user._id, 'pending')).status).toBe(400);
    expect((await setStatus(victim.user._id, 'banana')).status).toBe(400);
  });

  /**
   * A pending user has no password, so "activating" them would produce an
   * account that looks usable and is not.
   */
  it('refuses to activate a user who has not accepted their invite', async () => {
    const pending = await User.create({
      name: 'Pending Person',
      email: 'pending@example.com',
      role: 'sales_rep',
      status: 'pending',
    });

    const res = await setStatus(pending._id, 'active');

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invitation/i);
  });

  it('is admin only', async () => {
    const manager = await createManager();

    expect((await setStatus(victim.user._id, 'deactivated', manager)).status).toBe(403);
  });

  it('is recorded in the audit trail', async () => {
    const AuditLog = require('../src/models/AuditLog');

    await setStatus(victim.user._id, 'deactivated');

    const log = await AuditLog.findOne({ entity: 'user', action: 'update' });
    expect(log.changes.find((c) => c.field === 'status')).toMatchObject({
      from: 'active',
      to: 'deactivated',
    });
  });
});
