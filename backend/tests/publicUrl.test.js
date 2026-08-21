const { publicUrl, publicOrigin } = require('../src/utils/publicUrl');
const env = require('../src/config/env');
const mailer = require('../src/services/mailer');
const { api, createAdmin } = require('./helpers');

/**
 * Which origin ends up in a link someone is expected to click.
 *
 * THE BUG THIS EXISTS FOR.
 *
 * `env.appUrl` falls back to http://localhost:5173 when neither APP_URL nor
 * CLIENT_ORIGIN is set. On a laptop that is right. On a deployment where nobody
 * set either variable, every invitation and every password reset pointed at the
 * recipient's own machine — so the token was perfectly valid and the URL was
 * useless, and it presented as "the invite link doesn't work" rather than as a
 * missing environment variable.
 */

/** A request object shaped the way Express hands one to a service. */
const fakeRequest = (headers = {}) => {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    headers: lower,
    protocol: lower['x-forwarded-proto'] || 'http',
    get: (name) => lower[String(name).toLowerCase()],
  };
};

/** Behind a proxy, as Vercel presents it. */
const proxied = (host, proto = 'https') =>
  fakeRequest({ 'x-forwarded-host': host, 'x-forwarded-proto': proto });

describe('publicOrigin', () => {
  const realConfigured = env.appUrlConfigured;
  const realAppUrl = env.appUrl;

  afterEach(() => {
    env.appUrlConfigured = realConfigured;
    env.appUrl = realAppUrl;
  });

  describe('when APP_URL or CLIENT_ORIGIN is configured', () => {
    beforeEach(() => {
      env.appUrlConfigured = true;
      env.appUrl = 'https://crm.mycompany.com';
    });

    /**
     * Configuration is authoritative, and must not be overridable by a header.
     * This is what makes a properly configured deployment immune to the
     * host-header injection the request fallback would otherwise expose.
     */
    it('uses it, whatever the request claims', () => {
      expect(publicOrigin(proxied('attacker.example.com'))).toBe('https://crm.mycompany.com');
    });

    it('uses it when there is no request at all', () => {
      expect(publicOrigin(undefined)).toBe('https://crm.mycompany.com');
    });
  });

  describe('when nothing is configured', () => {
    beforeEach(() => {
      env.appUrlConfigured = false;
      env.appUrl = 'http://localhost:5173';
    });

    /** The fix: a deployed request produces a link to the deployment. */
    it('uses the host the request arrived on', () => {
      expect(publicOrigin(proxied('crm-system.vercel.app'))).toBe(
        'https://crm-system.vercel.app'
      );
    });

    it('prefers the forwarded host over the internal one', () => {
      const req = fakeRequest({
        'x-forwarded-host': 'crm-system.vercel.app',
        'x-forwarded-proto': 'https',
        host: 'localhost:3000',
      });

      expect(publicOrigin(req)).toBe('https://crm-system.vercel.app');
    });

    /** A proxy may append rather than replace. The first entry is the client's. */
    it('takes the first entry when the proxy sent a list', () => {
      const req = fakeRequest({
        'x-forwarded-host': 'crm-system.vercel.app, internal.local',
        'x-forwarded-proto': 'https, http',
      });

      expect(publicOrigin(req)).toBe('https://crm-system.vercel.app');
    });

    /** Keeps the port, which req.hostname would drop. */
    it('keeps a non-default port', () => {
      expect(publicOrigin(fakeRequest({ host: 'crm.internal:8080' }))).toBe(
        'http://crm.internal:8080'
      );
    });

    /**
     * A developer on their laptop: env.appUrl points at the FRONTEND's port,
     * where the accept page is actually served. Deriving from the request would
     * give the API's port, where it is not.
     */
    it('falls back to the configured default for a localhost request', () => {
      expect(publicOrigin(fakeRequest({ host: 'localhost:5000' }))).toBe(
        'http://localhost:5173'
      );
      expect(publicOrigin(fakeRequest({ host: '127.0.0.1:5000' }))).toBe(
        'http://localhost:5173'
      );
    });

    it('falls back when the request carries no host at all', () => {
      expect(publicOrigin(fakeRequest({}))).toBe('http://localhost:5173');
      expect(publicOrigin(undefined)).toBe('http://localhost:5173');
    });

    /**
     * The header goes straight into a URL someone will click, so anything that
     * is not a hostname and port is refused rather than sanitised. A value with
     * a slash in it is not a hostname needing rescue; it is someone trying to
     * append their own path to our link.
     */
    it('refuses a host header that is not a hostname', () => {
      for (const host of [
        'evil.com/path',
        'evil.com?next=x',
        'evil.com#frag',
        'evil com',
        'evil.com"onload=x',
        'evil.com\\@real.com',
      ]) {
        expect(publicOrigin(fakeRequest({ host }))).toBe('http://localhost:5173');
      }
    });

    /** Surrounding whitespace is trimmed, not treated as an attack. */
    it('accepts a host with whitespace around it', () => {
      expect(publicOrigin(fakeRequest({ host: '  crm.example.com  ' }))).toBe(
        'http://crm.example.com'
      );
    });

    it('refuses a protocol that is not http or https', () => {
      expect(publicOrigin(proxied('crm.example.com', 'javascript'))).toBe(
        'http://localhost:5173'
      );
    });
  });
});

describe('publicUrl', () => {
  it('joins the origin and the path', () => {
    const realConfigured = env.appUrlConfigured;
    const realAppUrl = env.appUrl;
    env.appUrlConfigured = true;
    env.appUrl = 'https://crm.mycompany.com';

    try {
      expect(publicUrl(undefined, '/accept-invite?token=abc')).toBe(
        'https://crm.mycompany.com/accept-invite?token=abc'
      );
    } finally {
      env.appUrlConfigured = realConfigured;
      env.appUrl = realAppUrl;
    }
  });
});

/**
 * The end-to-end version of the bug, through the real endpoint.
 */
describe('invite links on an unconfigured deployment', () => {
  const realSendMail = mailer.sendMail;
  const realConfigured = env.appUrlConfigured;

  beforeEach(() => {
    env.appUrlConfigured = false;
    // The console transport, so the link comes back in the response.
    mailer.sendMail = async () => ({ delivered: true, transport: 'console' });
  });

  afterEach(() => {
    env.appUrlConfigured = realConfigured;
    mailer.sendMail = realSendMail;
  });

  it('points the invitee at the deployment, not at their own machine', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/users/invite')
      .set(admin.headers)
      .set('x-forwarded-host', 'crm-system.vercel.app')
      .set('x-forwarded-proto', 'https')
      .send({ name: 'New Hire', email: 'hire@example.com', role: 'sales_rep' });

    expect(res.status).toBe(201);
    expect(res.body.meta.inviteLink).toMatch(
      /^https:\/\/crm-system\.vercel\.app\/accept-invite\?token=[a-f0-9]{64}$/
    );
    expect(res.body.meta.inviteLink).not.toContain('localhost');
  });

  /** A link at the right origin is no use if the token in it does not redeem. */
  it('issues a link whose token still works', async () => {
    const admin = await createAdmin();

    const res = await api()
      .post('/api/users/invite')
      .set(admin.headers)
      .set('x-forwarded-host', 'crm-system.vercel.app')
      .set('x-forwarded-proto', 'https')
      .send({ name: 'New Hire', email: 'hire@example.com', role: 'sales_rep' });

    const token = res.body.meta.inviteLink.match(/token=([a-f0-9]+)/)[1];

    const accepted = await api()
      .post('/api/auth/accept-invite')
      .send({ token, password: 'Karachi-Ledger-72' });

    expect(accepted.status).toBe(201);
  });
});
