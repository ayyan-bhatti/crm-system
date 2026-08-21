const { sendMail } = require('../src/services/mailer');
const env = require('../src/config/env');

/**
 * The mail transports.
 *
 * The webhook branch is the one that matters here. It is the transport a real
 * deployment is told to use, and until these tests it was the only part of the
 * password-reset and invite flows never exercised — the other suites stub
 * delivery out, so a broken webhook would have passed the entire suite and
 * failed the first time someone tried to reset a password in production.
 */

const message = { to: 'someone@example.com', subject: 'Reset your password', text: 'link' };

describe('sendMail', () => {
  const realTransport = env.mailTransport;
  const realUrl = env.mailWebhookUrl;
  const realAuth = env.mailWebhookAuth;
  const realFetch = global.fetch;

  afterEach(() => {
    env.mailTransport = realTransport;
    env.mailWebhookUrl = realUrl;
    env.mailWebhookAuth = realAuth;
    global.fetch = realFetch;
  });

  describe('the console transport', () => {
    it('reports delivery, because the link really is in the log', async () => {
      env.mailTransport = 'console';

      await expect(sendMail(message)).resolves.toEqual({
        delivered: true,
        transport: 'console',
      });
    });
  });

  describe('the webhook transport', () => {
    /** Captures the request instead of making one. */
    const stubFetch = (response) => {
      const calls = [];
      global.fetch = async (url, options) => {
        calls.push({ url, options });
        return response;
      };
      return calls;
    };

    const ok = () => ({ ok: true, status: 200, text: async () => '' });

    it('posts the message to the configured URL', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = 'https://mail.example.com/send';
      env.mailWebhookAuth = '';
      const calls = stubFetch(ok());

      const result = await sendMail(message);

      expect(result).toEqual({ delivered: true, transport: 'webhook' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://mail.example.com/send');
      expect(calls[0].options.method).toBe('POST');
      expect(JSON.parse(calls[0].options.body)).toEqual({
        to: message.to,
        subject: message.subject,
        text: message.text,
        from: env.mailFrom,
      });
    });

    /**
     * The reason MAIL_WEBHOOK_AUTH exists. Without the header, every hosted
     * provider answers 401, so "point MAIL_WEBHOOK_URL at your email provider"
     * only worked if you first wrote a relay that accepts anonymous POSTs.
     */
    it('sends MAIL_WEBHOOK_AUTH as the Authorization header', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = 'https://api.resend.com/emails';
      env.mailWebhookAuth = 'Bearer re_test_key';
      const calls = stubFetch(ok());

      await sendMail(message);

      expect(calls[0].options.headers.Authorization).toBe('Bearer re_test_key');
    });

    /**
     * Verbatim, not `Bearer ${key}` — Resend and SendGrid want Bearer, an
     * internal relay may want Basic, and prefixing here would break the latter.
     */
    it('does not rewrite the header value it was given', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = 'https://relay.internal/send';
      env.mailWebhookAuth = 'Basic dXNlcjpwYXNz';
      const calls = stubFetch(ok());

      await sendMail(message);

      expect(calls[0].options.headers.Authorization).toBe('Basic dXNlcjpwYXNz');
    });

    it('omits the header entirely when no auth is configured', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = 'https://relay.internal/send';
      env.mailWebhookAuth = '';
      const calls = stubFetch(ok());

      await sendMail(message);

      expect(calls[0].options.headers).not.toHaveProperty('Authorization');
    });

    /**
     * Never throwing is the contract — the password-reset controller returns
     * the same response whether or not delivery worked, so an exception here
     * would turn a mail outage into a 500 on a public endpoint.
     */
    it('reports failure rather than throwing when the provider rejects it', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = 'https://api.resend.com/emails';
      env.mailWebhookAuth = 'Bearer wrong';
      stubFetch({
        ok: false,
        status: 401,
        text: async () => '{"message":"API key is invalid"}',
      });

      await expect(sendMail(message)).resolves.toEqual({
        delivered: false,
        transport: 'webhook',
      });
    });

    it('reports failure rather than throwing when the request cannot be made', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = 'https://mail.example.com/send';
      global.fetch = async () => {
        throw new Error('connect ETIMEDOUT');
      };

      await expect(sendMail(message)).resolves.toEqual({
        delivered: false,
        transport: 'webhook',
      });
    });

    /**
     * Misconfiguration should be loud in its own right rather than showing up
     * later as mail that silently never arrives.
     */
    it('fails when the transport is selected but no URL is set', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = '';
      const calls = stubFetch(ok());

      const result = await sendMail(message);

      expect(result.delivered).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });
});
