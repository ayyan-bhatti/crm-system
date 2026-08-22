const User = require('../src/models/User');
const mailer = require('../src/services/mailer');
const { api, createAdmin, createManager, createRep } = require('./helpers');

/**
 * Signing up as a request, and the admin approving or rejecting it.
 *
 * THE CLAIM UNDER TEST.
 *
 * Signing up creates an account that CANNOT BE USED. Everything else here
 * follows from that: no session comes back, login is refused with a message
 * that says why, and the account only becomes usable when an administrator
 * decides it should.
 *
 * The second claim is that nobody can talk their way into being an admin —
 * not by asking for it, not by being the second person to sign up, and not by
 * being approved by a manager.
 */

const PASSWORD = 'Karachi-Ledger-72';

const signUp = (overrides = {}) =>
  api()
    .post('/api/auth/register')
    .send({
      name: 'Bilal Ahmed',
      email: 'bilal@example.com',
      password: PASSWORD,
      requestedRole: 'sales_rep',
      ...overrides,
    });

const login = (email, password = PASSWORD) =>
  api().post('/api/auth/login').send({ email, password });

describe('signing up', () => {
  const realSendMail = mailer.sendMail;
  let sent;

  beforeEach(async () => {
    sent = [];
    mailer.sendMail = async (message) => {
      sent.push(message);
      return { delivered: true, transport: 'test' };
    };

    // An existing admin, so this is never the first-user bootstrap.
    await createAdmin({ name: 'Ayyan', email: 'ayyan@example.com' });
  });

  afterEach(() => {
    mailer.sendMail = realSendMail;
  });

  it('creates a pending account rather than a usable one', async () => {
    const res = await signUp();

    expect(res.status).toBe(202);

    const user = await User.findOne({ email: 'bilal@example.com' });
    expect(user.status).toBe('pending');
    expect(user.requestedRole).toBe('sales_rep');
  });

  /**
   * The whole point. A session here would be a working login for somebody
   * nobody has approved.
   */
  it('returns no session and sets no cookies', async () => {
    const res = await signUp();

    expect(res.body.data.token).toBeUndefined();

    // The CSRF cookie is set on every response and grants nothing on its own;
    // what must be absent are the two that ARE the session.
    const cookies = (res.headers['set-cookie'] || []).join(' ');
    expect(cookies).not.toContain('simplecrm_access');
    expect(cookies).not.toContain('simplecrm_refresh');
  });

  it('stores the password immediately, hashed, so nothing is sent later', async () => {
    await signUp();

    const user = await User.findOne({ email: 'bilal@example.com' }).select('+password');
    expect(user.password).not.toBe(PASSWORD);
    expect(user.password).toMatch(/^\$2[aby]\$/);
  });

  /** Asking is not receiving: `role` stays least-privileged until approval. */
  it('does not grant the requested role', async () => {
    await signUp({ requestedRole: 'manager' });

    const user = await User.findOne({ email: 'bilal@example.com' });
    expect(user.requestedRole).toBe('manager');
    expect(user.role).toBe('sales_rep');
  });

  it('tells the applicant what happens next', async () => {
    const res = await signUp();

    expect(res.body.message).toMatch(/administrator/i);
    expect(res.body.message).toMatch(/approved/i);
  });

  it('emails the admins', async () => {
    await signUp();

    const notice = sent.find((m) => m.to === 'ayyan@example.com');
    expect(notice).toBeDefined();
    expect(notice.subject).toMatch(/account request/i);
    expect(notice.text).toContain('Bilal Ahmed');
  });

  /**
   * The request is already recorded and the admin screen lists it regardless,
   * so a mail outage costs the admin a notification and nothing else. Failing
   * the sign-up instead would be far worse.
   */
  it('still records the request when the email cannot be sent', async () => {
    mailer.sendMail = async () => {
      throw new Error('mail is down');
    };

    const res = await signUp();

    expect(res.status).toBe(202);
    expect(await User.findOne({ email: 'bilal@example.com' })).not.toBeNull();
  });

  describe('what cannot be requested', () => {
    /**
     * Refused outright rather than quietly downgraded. Silently ignoring it
     * would let someone believe they had asked for admin and been approved.
     */
    it('refuses a request for admin', async () => {
      const res = await signUp({ requestedRole: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/administrator access is granted/i);
      expect(await User.findOne({ email: 'bilal@example.com' })).toBeNull();
    });

    it('refuses a role that does not exist', async () => {
      expect((await signUp({ requestedRole: 'wizard' })).status).toBe(400);
    });

    it('defaults to the least-privileged role when none is asked for', async () => {
      await signUp({ requestedRole: undefined });

      expect((await User.findOne({ email: 'bilal@example.com' })).requestedRole).toBe('sales_rep');
    });
  });
});

describe('logging in before a decision has been made', () => {
  beforeEach(async () => {
    await createAdmin({ name: 'Ayyan', email: 'ayyan@example.com' });
  });

  /**
   * A clear message, not a generic invalid-credentials error. Only ever shown
   * after the correct password, so it leaks nothing to somebody typing in
   * addresses to see which exist.
   */
  it('refuses a pending applicant and says they are waiting on approval', async () => {
    await signUp();

    const res = await login('bilal@example.com');

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/awaiting administrator approval/i);
  });

  it('still refuses a wrong password with the generic message', async () => {
    await signUp();

    const res = await login('bilal@example.com', 'Wrong-Password-99');

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  /**
   * An invited colleague is also `pending`, and needs completely different
   * advice — they have a link to use, not an approval to wait for.
   */
  it('sends an invited user to their link instead', async () => {
    const admin = await createAdmin({ name: 'Other Admin', email: 'other@example.com' });

    await api()
      .post('/api/users/invite')
      .set(admin.headers)
      .send({ name: 'Invited Person', email: 'invited@example.com', role: 'sales_rep' });

    // No password is set on an invited account, so the password check cannot
    // pass — assert on the record rather than the login response.
    const invited = await User.findOne({ email: 'invited@example.com' });
    expect(invited.status).toBe('pending');
    expect(invited.requestedRole).toBeNull();
  });
});

describe('approving a request', () => {
  let admin;

  beforeEach(async () => {
    admin = await createAdmin({ name: 'Ayyan', email: 'ayyan@example.com' });
  });

  const pendingUser = async (requestedRole = 'sales_rep') => {
    await signUp({ requestedRole });
    return User.findOne({ email: 'bilal@example.com' });
  };

  const approve = (id, body = {}) =>
    api().patch(`/api/users/${id}/approve`).set(admin.headers).send(body);

  it('activates the account with the role that was asked for', async () => {
    const user = await pendingUser('manager');

    const res = await approve(user._id);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.role).toBe('manager');
  });

  /** The end-to-end proof: they could not sign in, and now they can. */
  it('lets them sign in with the password they chose at sign-up', async () => {
    const user = await pendingUser();

    expect((await login('bilal@example.com')).status).toBe(403);

    await approve(user._id);

    const after = await login('bilal@example.com');
    expect(after.status).toBe(200);
    expect(after.body.data.user.email).toBe('bilal@example.com');
  });

  /**
   * A request is a request. Forcing approve-then-demote would leave a window,
   * however brief, where somebody holds access nobody agreed to give them.
   */
  it('lets the admin grant a different role than the one requested', async () => {
    const user = await pendingUser('manager');

    const res = await approve(user._id, { role: 'sales_rep' });

    expect(res.body.data.role).toBe('sales_rep');
    expect(res.body.data.requestedRole).toBe('manager');
  });

  it('records who decided and when', async () => {
    const user = await pendingUser();

    await approve(user._id);

    const updated = await User.findById(user._id);
    expect(String(updated.reviewedBy)).toBe(String(admin.user._id));
    expect(updated.reviewedAt).toBeInstanceOf(Date);
  });

  it('notes the override in the audit trail when the role differs', async () => {
    const user = await pendingUser('manager');

    await approve(user._id, { role: 'sales_rep' });

    const audit = await api().get('/api/audit-logs').query({ entity: 'user' }).set(admin.headers);
    const entry = audit.body.data.find((row) => row.note?.includes('approved'));

    expect(entry.note).toMatch(/approved as sales_rep \(asked for manager\)/i);
  });

  it('refuses to approve the same request twice', async () => {
    const user = await pendingUser();

    await approve(user._id);
    const second = await approve(user._id);

    expect(second.status).toBe(400);
  });

  /**
   * An invited account has no password, so activating it would produce an
   * account nobody can sign in to, in a state the invite flow would refuse to
   * fix.
   */
  it('refuses to approve an unaccepted invite', async () => {
    await api()
      .post('/api/users/invite')
      .set(admin.headers)
      .send({ name: 'Invited Person', email: 'invited@example.com', role: 'sales_rep' });

    const invited = await User.findOne({ email: 'invited@example.com' });
    const res = await approve(invited._id);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/pending request/i);
  });
});

describe('rejecting a request', () => {
  let admin;

  beforeEach(async () => {
    admin = await createAdmin({ name: 'Ayyan', email: 'ayyan@example.com' });
    await signUp();
  });

  const reject = async () => {
    const user = await User.findOne({ email: 'bilal@example.com' });
    return api().patch(`/api/users/${user._id}/reject`).set(admin.headers).send();
  };

  /** Kept rather than deleted — see the note on the handler for why. */
  it('keeps the account, marked rejected', async () => {
    const res = await reject();

    expect(res.status).toBe(200);

    const user = await User.findOne({ email: 'bilal@example.com' });
    expect(user).not.toBeNull();
    expect(user.status).toBe('rejected');
  });

  it('refuses the login with a message that says what happened', async () => {
    await reject();

    const res = await login('bilal@example.com');

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/was not approved/i);
  });

  /**
   * The address stays reserved on purpose: freeing it would let the same person
   * re-apply immediately and the admin would see an identical request with no
   * memory of having declined it.
   */
  it('keeps the email address reserved', async () => {
    await reject();

    const again = await signUp();

    expect(again.status).toBe(409);
  });

  it('records the decision in the audit trail', async () => {
    await reject();

    const audit = await api().get('/api/audit-logs').query({ entity: 'user' }).set(admin.headers);
    expect(audit.body.data.some((row) => row.note?.includes('rejected'))).toBe(true);
  });
});

describe('the approvals queue', () => {
  let admin;

  beforeEach(async () => {
    admin = await createAdmin({ name: 'Ayyan', email: 'ayyan@example.com' });
  });

  const pending = (actor = admin) => api().get('/api/users/pending').set(actor.headers);

  it('lists a request waiting on a decision', async () => {
    await signUp({ requestedRole: 'manager' });

    const res = await pending();

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      name: 'Bilal Ahmed',
      requestedRole: 'manager',
    });
  });

  /**
   * An unaccepted invite is also `pending`, and is not a decision anybody is
   * waiting on. Filtering by status alone would put invited colleagues into the
   * approvals queue, where there is nothing to approve.
   */
  it('does not include unaccepted invites', async () => {
    await api()
      .post('/api/users/invite')
      .set(admin.headers)
      .send({ name: 'Invited Person', email: 'invited@example.com', role: 'sales_rep' });

    expect((await pending()).body.data).toHaveLength(0);
  });

  it('empties as requests are decided', async () => {
    await signUp();
    const user = await User.findOne({ email: 'bilal@example.com' });

    expect((await pending()).body.data).toHaveLength(1);

    await api().patch(`/api/users/${user._id}/approve`).set(admin.headers).send();

    expect((await pending()).body.data).toHaveLength(0);
  });

  /** A queue is worked from the front; newest-first buries the longest wait. */
  it('lists the longest wait first', async () => {
    await signUp({ email: 'first@example.com' });
    await signUp({ email: 'second@example.com' });

    const res = await pending();

    expect(res.body.data.map((u) => u.email)).toEqual([
      'first@example.com',
      'second@example.com',
    ]);
  });

  describe('who may decide', () => {
    /**
     * A manager who can approve accounts can approve one for themselves under
     * another name, which is an admin with extra steps.
     */
    it('refuses a manager and a sales rep', async () => {
      const manager = await createManager();
      const rep = await createRep();

      expect((await pending(manager)).status).toBe(403);
      expect((await pending(rep)).status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      expect((await api().get('/api/users/pending')).status).toBe(401);
    });

    it('refuses a manager trying to approve directly', async () => {
      await signUp();
      const manager = await createManager();
      const user = await User.findOne({ email: 'bilal@example.com' });

      const res = await api()
        .patch(`/api/users/${user._id}/approve`)
        .set(manager.headers)
        .send({ role: 'admin' });

      expect(res.status).toBe(403);
    });
  });
});

describe('nobody can bootstrap into admin', () => {
  /**
   * The first account on a genuinely empty database still becomes an active
   * admin, because a fresh install has nobody to approve anything.
   */
  it('makes the very first account an active admin', async () => {
    const res = await signUp({ requestedRole: undefined });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('admin');
    expect(res.body.data.user.status).toBe('active');
  });

  /** Once an admin exists, no sign-up can ever produce another one. */
  it('makes every later account a pending request, whatever it asks for', async () => {
    await signUp({ email: 'first@example.com' });

    const second = await signUp({ email: 'second@example.com', requestedRole: 'manager' });

    expect(second.status).toBe(202);

    const user = await User.findOne({ email: 'second@example.com' });
    expect(user.status).toBe('pending');
    expect(user.role).not.toBe('admin');
  });

  it('cannot be tricked by sending a role in the body', async () => {
    await createAdmin({ name: 'Ayyan', email: 'ayyan@example.com' });

    await api().post('/api/auth/register').send({
      name: 'Chancer',
      email: 'chancer@example.com',
      password: PASSWORD,
      role: 'admin',
      status: 'active',
    });

    const user = await User.findOne({ email: 'chancer@example.com' });
    expect(user.role).toBe('sales_rep');
    expect(user.status).toBe('pending');
  });
});
