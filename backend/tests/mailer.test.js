const { sendMail, isConfigured, activeTransport } = require('../src/services/mailer');
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
  const realKey = env.brevoApiKey;
  const realFrom = env.mailFrom;
  const realFetch = global.fetch;

  afterEach(() => {
    env.mailTransport = realTransport;
    env.mailWebhookUrl = realUrl;
    env.mailWebhookAuth = realAuth;
    env.brevoApiKey = realKey;
    env.mailFrom = realFrom;
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

      const result = await sendMail(message);

      expect(result).toMatchObject({ delivered: false, transport: 'webhook' });
      /*
       * The reason travels with the failure, not just into the log.
       * messagingService writes `result.error` onto the recipient row and falls
       * back to the bare string "delivery failed" when it is missing — so
       * without this the campaign screen showed every failed email as
       * indistinguishable from every other, no matter the cause.
       */
      expect(result.error).toContain('401');
      expect(result.error).toContain('API key is invalid');
    });

    it('reports failure rather than throwing when the request cannot be made', async () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = 'https://mail.example.com/send';
      global.fetch = async () => {
        throw new Error('connect ETIMEDOUT');
      };

      await expect(sendMail(message)).resolves.toMatchObject({
        delivered: false,
        transport: 'webhook',
        error: 'connect ETIMEDOUT',
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

  /**
   * The Brevo transport.
   *
   * Worth its own block rather than trusting it to look like the webhook one,
   * because the two things it does differently are exactly the two things that
   * cannot be configured around: the `api-key` header (an `Authorization`
   * header is ignored and comes back 401 saying nothing useful) and the nested
   * sender/recipient body. Both are asserted below, because getting either
   * wrong produces a failure that names neither.
   */
  describe('the brevo transport', () => {
    const stubFetch = (response) => {
      const calls = [];
      global.fetch = async (url, options) => {
        calls.push({ url, options });
        return response;
      };
      return calls;
    };

    const ok = () => ({ ok: true, status: 201, text: async () => '' });

    it('posts the Brevo payload with the api-key header', async () => {
      env.mailTransport = 'brevo';
      env.brevoApiKey = 'xkeysib-test';
      env.mailFrom = 'SimpleCRM <no-reply@example.com>';
      const calls = stubFetch(ok());

      const result = await sendMail(message);

      expect(result).toEqual({ delivered: true, transport: 'brevo' });
      expect(calls[0].url).toBe('https://api.brevo.com/v3/smtp/email');
      expect(calls[0].options.headers['api-key']).toBe('xkeysib-test');
      expect(calls[0].options.headers).not.toHaveProperty('Authorization');
      expect(JSON.parse(calls[0].options.body)).toEqual({
        sender: { name: 'SimpleCRM', email: 'no-reply@example.com' },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
      });
    });

    /**
     * MAIL_FROM is one RFC 5322 string because that is what a mail header is.
     * Brevo wants the two halves apart, so the split happens here — and a bare
     * address with no display name has to stay valid, since that is what the
     * setting looks like for most deployments.
     */
    it('sends a bare address with no display name as just an email', async () => {
      env.mailTransport = 'brevo';
      env.brevoApiKey = 'xkeysib-test';
      env.mailFrom = 'no-reply@example.com';
      const calls = stubFetch(ok());

      await sendMail(message);

      expect(JSON.parse(calls[0].options.body).sender).toEqual({
        email: 'no-reply@example.com',
      });
    });

    it('reports the reason when Brevo rejects the sender', async () => {
      env.mailTransport = 'brevo';
      env.brevoApiKey = 'xkeysib-test';
      stubFetch({
        ok: false,
        status: 400,
        text: async () => '{"code":"invalid_parameter","message":"sender not valid"}',
      });

      const result = await sendMail(message);

      expect(result).toMatchObject({ delivered: false, transport: 'brevo' });
      expect(result.error).toContain('sender not valid');
    });

    it('fails without sending when the key is missing', async () => {
      env.mailTransport = 'brevo';
      env.brevoApiKey = '';
      const calls = stubFetch(ok());

      const result = await sendMail(message);

      expect(result.delivered).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  /**
   * `isConfigured` is what /api/health and the campaign builder read to decide
   * whether the email channel is live. The case that matters is a transport
   * NAMED but not credentialed: that used to report live — the campaign
   * builder would offer email, and every message would fail.
   */
  describe('isConfigured', () => {
    const realKey = env.brevoApiKey;
    afterEach(() => {
      env.brevoApiKey = realKey;
    });

    it('is false for the console default', () => {
      env.mailTransport = 'console';
      expect(activeTransport()).toBe('console');
      expect(isConfigured()).toBe(false);
    });

    it('is false when brevo is selected with no key', () => {
      env.mailTransport = 'brevo';
      env.brevoApiKey = '';
      expect(isConfigured()).toBe(false);
    });

    it('is false when webhook is selected with no URL', () => {
      env.mailTransport = 'webhook';
      env.mailWebhookUrl = '';
      expect(isConfigured()).toBe(false);
    });

    it('is true once the selected transport has its credential', () => {
      env.mailTransport = 'brevo';
      env.brevoApiKey = 'xkeysib-test';
      expect(isConfigured()).toBe(true);
    });

    /** An unrecognised value falls back to console rather than half-sending. */
    it('treats an unknown transport as console', () => {
      env.mailTransport = 'carrier-pigeon';
      expect(activeTransport()).toBe('console');
      expect(isConfigured()).toBe(false);
    });
  });
});
