/**
 * Central place where every environment variable is read.
 *
 * Reading process.env in exactly one file means:
 *   - you can see the app's full configuration surface at a glance
 *   - defaults live next to the value they belong to
 *   - misconfiguration is reported in one place, loudly, with the fix attached
 *
 * WHY THIS FILE STILL USES console AND NOT THE STRUCTURED LOGGER
 *
 * config/logger reads this module to decide its level and whether to pretty
 * print, so requiring it here would be a circular dependency — and the failure
 * it would cause is the worst possible one: the config error you are trying to
 * report becomes an unrelated module-load crash. Configuration problems are
 * reported before any logger exists, so console is the only thing guaranteed to
 * work. The same reasoning applies to the CLI scripts (seed, syncIndexes,
 * pruneAuditLog), where the output is prose for a human at a terminal rather
 * than records for a log platform.
 *
 * IMPORTANT — this module must never call process.exit().
 *
 * It used to. On a long-running server that is a reasonable fail-fast, but on
 * a serverless platform this file is evaluated inside the function instance:
 * exiting kills the instance during module load, so the platform reports a
 * generic crash with no message, every route 500s identically, and the logs say
 * nothing about the missing variable. Instead this module *records* what is
 * wrong, logs it once, and lets each runtime decide:
 *
 *   server.js  reads `configErrors` and exits (fail fast locally)
 *   app.js     serves /api/health so you can read the problem over HTTP, and
 *              refuses other routes with a logged, explicit 500
 */
const path = require('path');
const dotenv = require('dotenv');

// Load backend/.env regardless of the directory the process was started from.
// On Vercel there is no .env file — variables come from the project settings —
// so a missing file here is expected and not an error.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const env = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Deliberately NOT defaulted in production — see the validation below. A
  // silent fallback to localhost is the single most confusing failure mode on a
  // hosted platform, because the app looks configured and can never connect.
  mongoUri: process.env.MONGO_URI || '',

  jwtSecret: process.env.JWT_SECRET || '',

  /*
   * Token lifetimes.
   *
   * The access token is deliberately short. It is a bearer credential: anyone
   * holding it is the user until it expires, and there is no way to revoke a
   * signed JWT without keeping a denylist. Fifteen minutes keeps the blast
   * radius of a leaked token small while still being long enough that the
   * refresh endpoint is not hit on every other request.
   *
   * The refresh token is long-lived (7 days = "stay signed in for a week") but
   * it IS revocable, because it is stored server-side — see models/RefreshToken.
   *
   * JWT_EXPIRES_IN is the old single-token setting. It is read only as a
   * fallback for existing deployments and is no longer the access-token TTL;
   * see ACCESS_TOKEN_TTL below.
   */
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL || '15m',
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL || '7d',

  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  /*
   * Cookie behaviour.
   *
   * `secure` must be on in production (cookies then only travel over HTTPS) but
   * must be OFF for local http://localhost development, or the browser silently
   * drops them and every request looks unauthenticated for no visible reason.
   *
   * `sameSite: 'lax'` is the right default here because the frontend and API
   * share an origin behind the Vercel rewrites, so no cross-site cookie is ever
   * needed. 'lax' also blocks the cross-site POST that CSRF depends on, which
   * is a second layer under the explicit CSRF token added later.
   * Deployments that genuinely split the two origins can set COOKIE_SAME_SITE=none,
   * which then requires secure cookies.
   */
  cookieSameSite: process.env.COOKIE_SAME_SITE || 'lax',

  /**
   * The app's own public URL, used to build password-reset links.
   *
   * Defaults to the client origin, which is correct in every setup where the
   * frontend and API share a domain (including the Vercel deployment). A
   * separate variable exists because CLIENT_ORIGIN may be a comma-separated
   * ALLOW-LIST for CORS, and a link has to point at exactly one place.
   */
  appUrl: (process.env.APP_URL || process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')[0]
    .trim()
    .replace(/\/$/, ''),

  /*
   * Whether the value above came from configuration or from the fallback.
   *
   * utils/publicUrl needs to tell those apart. An explicitly configured origin
   * is authoritative and is used for every link; the localhost fallback is a
   * developer default that must NOT be baked into an invitation sent from a
   * deployment, because it points the recipient at their own machine.
   */
  appUrlConfigured: Boolean(process.env.APP_URL || process.env.CLIENT_ORIGIN),

  /** console (default) | webhook — see services/mailer.js. */
  mailTransport: process.env.MAIL_TRANSPORT || 'console',
  mailWebhookUrl: process.env.MAIL_WEBHOOK_URL || '',

  /**
   * Sent as the `Authorization` header on the webhook POST, verbatim.
   *
   * Verbatim, and not a bare key, because the scheme differs per provider:
   * Resend and SendGrid want `Bearer <key>`, an internal relay might want
   * `Basic <base64>`. Prefixing "Bearer " here would silently break the ones
   * that do not use it, so the full header value is the setting.
   *
   * Optional. Left unset the POST goes out unauthenticated, which is correct
   * for a relay on a private network and wrong for anything on the internet.
   */
  mailWebhookAuth: process.env.MAIL_WEBHOOK_AUTH || '',
  mailFrom: process.env.MAIL_FROM || 'SimpleCRM <no-reply@simplecrm.local>',

  /* -------------------------------------------------------------------------
   * SMS and WhatsApp
   *
   * Both follow `MAIL_TRANSPORT`'s pattern exactly, and the repetition is the
   * point: three channels behaving identically means one thing to learn rather
   * than three, and the console default means every one of them works end to
   * end with no account anywhere. See services/smsClient.js and
   * services/whatsappClient.js.
   *
   * Neither is validated below. A missing SMS account is not a configuration
   * ERROR — it is a deployment that does not send SMS, which is the default
   * and entirely reasonable state. What would be an error is claiming to send
   * and not sending, and that is prevented by the transport refusing to start
   * rather than by a check here.
   * ---------------------------------------------------------------------- */

  /** console (default) | twilio */
  smsTransport: process.env.SMS_TRANSPORT || 'console',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  /** The sending number, in E.164 (`+441234567890`). */
  twilioFrom: process.env.TWILIO_FROM || '',

  /** console (default) | meta */
  whatsappTransport: process.env.WHATSAPP_TRANSPORT || 'console',
  /** The Cloud API phone-number id — NOT the phone number itself. */
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
  /**
   * The Meta-APPROVED template to send outside the 24-hour service window.
   *
   * Not optional in practice, and the reason is a platform rule rather than a
   * preference: outside 24 hours of the customer's own last message, Meta
   * accepts ONLY a pre-approved template. Marketing is by definition outside
   * that window — nobody messages a shop to ask to be marketed at — so an
   * unset template name means live WhatsApp marketing cannot work, and the
   * transport says so at the point of sending rather than failing at Meta's.
   * See services/whatsappClient.js and the README.
   */
  whatsappTemplateName: process.env.WHATSAPP_TEMPLATE_NAME || '',
  whatsappTemplateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en',

  /**
   * A free DHL API Developer Portal key, for live status on a `dhl` shipment.
   *
   * Self-serve: sign up at developer.dhl.com, subscribe to "Shipment Tracking -
   * Unified", and a sandbox key is issued immediately — no business account, no
   * merchant application, no cost. That is not true of TCS or Leopards, which is
   * why this is the one courier services/courierService.js can actually call.
   *
   * Unset, tracking still works for every courier — buildTrackingUrl() links out
   * to the courier's own public tracking page, which needs no key at all — this
   * only adds a live "Delivered / In transit / ..." status pulled into the app
   * itself for DHL shipments specifically.
   */
  dhlTrackingApiKey: process.env.DHL_TRACKING_API_KEY || '',

  /**
   * The shared secret the scheduled post-sale jobs authenticate with.
   *
   * A MACHINE CREDENTIAL, NOT A USER SESSION. The daily job is invoked by a
   * scheduler (Vercel Cron), which has no login, no cookie and no CSRF token,
   * so gating it on a staff session would be either impossible or a lie —
   * a service account whose password sits in an environment variable is
   * a shared secret wearing a costume.
   *
   * Unset, the endpoint refuses EVERY request rather than running unprotected.
   * An automation endpoint open to the internet sends real messages to real
   * people on demand, so failing closed is the only safe default; see
   * routes/cronRoutes.js.
   */
  cronSecret: process.env.CRON_SECRET || '',

  /**
   * Log verbosity: fatal | error | warn | info | debug | trace.
   *
   * `info` in production is the right default — one line per request plus
   * anything notable. `debug` locally when chasing something.
   */
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  /**
   * Gemini, from Google AI Studio.
   *
   * No fallback to the old ANTHROPIC_* names. A deployment that still has the
   * old variable set would otherwise appear configured while every call failed
   * against a key for a different provider — which is precisely the silent
   * degradation `/api/internal/ai-status` exists to make impossible. Better to
   * report "not configured" truthfully and have somebody set one variable.
   */
  geminiApiKey: process.env.GEMINI_API_KEY || '',

  /**
   * Flash rather than Pro, deliberately.
   *
   * Every call this app makes is a short prompt with a small, strictly-shaped
   * reply: translate a question into a filter, summarise six numbers. Those are
   * latency-sensitive and reasoning-light, which is exactly the trade Flash is
   * built for — and the user is waiting on the answer while a fallback sits
   * ready behind it.
   */
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',

  /* -------------------------------------------------------------------------
   * Stripe
   *
   * Three values, and it is worth being explicit about which one does what,
   * because two of them are secrets that do completely different jobs and
   * swapping them produces a confusing failure rather than an obvious one.
   *
   *   STRIPE_SECRET_KEY     `sk_test_...`  authenticates OUR calls TO Stripe:
   *                                        creating a Checkout Session,
   *                                        issuing a refund.
   *   STRIPE_WEBHOOK_SECRET `whsec_...`    verifies STRIPE'S calls TO US. It is
   *                                        NOT an API key and cannot be used as
   *                                        one; it is the shared secret the
   *                                        signature on an incoming webhook is
   *                                        computed with.
   *   STRIPE_PUBLISHABLE_KEY `pk_test_...` not read here at all — it belongs to
   *                                        the frontend build. Named in the
   *                                        README so nobody hunts for it.
   *
   * Getting the webhook secret wrong does not stop payments: the buyer pays
   * happily, Stripe posts the event, we reject the signature, and no order is
   * ever created. That failure is silent from the buyer's side and expensive,
   * so `/api/internal/ai-status`'s sibling — the payments block on
   * `/api/health` — reports whether both are configured.
   * ---------------------------------------------------------------------- */
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',

  /**
   * Where Stripe sends the buyer back to. Defaults to the app's own URL, which
   * is right in every deployment where the storefront and API share a domain.
   */
  stripeSuccessPath: process.env.STRIPE_SUCCESS_PATH || '/order-confirmation',
  stripeCancelPath: process.env.STRIPE_CANCEL_PATH || '/checkout',
};

/**
 * Whether card payment is available at all.
 *
 * Deliberately NOT fatal when unset, matching how a missing GEMINI_API_KEY is
 * handled: the storefront still works, card checkout is hidden, and
 * cash-on-delivery remains. A shop that refuses to boot because one payment
 * method is unconfigured is a worse outcome than a shop that takes orders by
 * another route — but a shop that OFFERS a card button leading nowhere is worse
 * than both, so the button is gated on this rather than shown optimistically.
 */
env.stripeEnabled = Boolean(env.stripeSecretKey);

env.isTest = env.nodeEnv === 'test';
env.isProduction = env.nodeEnv === 'production';
/** Cookies are only marked Secure where HTTPS actually exists. */
env.cookieSecure = env.isProduction;

/**
 * Whether the per-IP rate limiters are active.
 *
 * Off in the test suite by default — the existing tests hammer login and
 * register from a single address, which is precisely the traffic the limiters
 * exist to reject, so leaving them on would fail unrelated tests for unrelated
 * reasons. The rate-limit tests set this to true for themselves.
 *
 * RATE_LIMIT_DISABLED=true is an escape hatch for local load testing.
 */
env.rateLimitEnabled = !env.isTest && process.env.RATE_LIMIT_DISABLED !== 'true';

/**
 * Whether to check new passwords against the Have I Been Pwned corpus.
 *
 * Off in tests: a unit test must not depend on a third-party service being
 * reachable, and several hundred tests hitting a public API would be rude as
 * well as slow. Off also when explicitly disabled, for an air-gapped
 * deployment or one whose firewall blocks outbound HTTPS — the local rules
 * still apply, so the policy degrades rather than disappearing.
 */
env.breachCheckEnabled = !env.isTest && process.env.BREACH_CHECK_DISABLED !== 'true';

/**
 * Whether anyone may create their own account at /register.
 *
 * ON by default, and this is a real trade-off rather than an oversight, so it
 * is stated plainly:
 *
 *   Open  anyone who can reach the sign-up page gets an account, and the
 *         customer list is behind a login rather than behind an invitation.
 *         The role granted is always the least-privileged one, so the blast
 *         radius is "can read the CRM", not "can administer it" — but a
 *         stranger reading the CRM is usually the thing you minded about.
 *   Shut  accounts exist only because an admin invited someone. Correct for an
 *         internal tool whose users are employees, and the reason invites were
 *         built in the first place.
 *
 * If this deployment is reachable from the public internet and holds real
 * customer data, set ALLOW_PUBLIC_SIGNUP=false and invite people instead.
 *
 * Note what is NOT gated by this: the first-user bootstrap below. A fresh
 * install has nobody to send an invitation, so the first account can always be
 * created. Otherwise closing sign-up would lock everyone out of a new
 * deployment permanently.
 */
env.allowPublicSignup = process.env.ALLOW_PUBLIC_SIGNUP !== 'false';

/**
 * How long audit entries are kept, in days. Unset means keep them forever.
 *
 * Deliberately opt-in. An audit trail that expires on a schedule nobody
 * remembers setting is one whose absence is discovered on the day it matters —
 * see services/auditRetention.js. Pruning is also a manual command rather than
 * a background job, so a deletion is an operational act with a log line.
 */
env.auditRetentionDays = Number(process.env.AUDIT_RETENTION_DAYS) || null;

/**
 * Cache identical AI requests for a few minutes. On by default.
 *
 * Off in tests, where a cached response from a previous test would make the
 * next one assert against a stale stub — a cache is exactly the kind of shared
 * state that turns an independent test into an order-dependent one.
 */
env.aiCacheEnabled = !env.isTest && process.env.AI_CACHE_DISABLED !== 'true';

/** Persist AI token usage. Tests opt in per file; see services/aiUsageService. */
env.aiUsageTrackingInTests = false;

/**
 * Hard ceiling on the characters sent as a prompt.
 *
 * Tokens are billed, and the input is partly user-supplied — a pasted document
 * in the search box would otherwise become a large, and entirely pointless,
 * bill. Characters rather than tokens because the limit has to be enforced
 * BEFORE the call, and counting tokens locally would mean shipping a tokeniser
 * to approximate a number the API will compute anyway.
 *
 * Roughly 4 characters per token, so 8000 is about 2000 tokens — far more than
 * any legitimate question and far less than a document.
 */
env.aiMaxPromptChars = Number(process.env.AI_MAX_PROMPT_CHARS) || 8000;
/** True on Vercel (and most FaaS platforms), which set this automatically. */
env.isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

// ---------------------------------------------------------------------------
// Validation
//
// Tests run against an in-memory database and generate their own secret, so
// nothing below applies to them.
// ---------------------------------------------------------------------------

/** Human-readable problems with the current configuration. */
const configErrors = [];

if (env.isTest) {
  // Deterministic throwaway secret so the test suite needs no .env file.
  env.jwtSecret = env.jwtSecret || 'test-secret-not-used-outside-tests';
} else {
  // --- JWT_SECRET --------------------------------------------------------
  if (!env.jwtSecret) {
    configErrors.push(
      'JWT_SECRET is not set. Tokens cannot be signed or verified, so every ' +
        'login and registration will fail. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  } else if (env.jwtSecret.length < 32) {
    configErrors.push(
      `JWT_SECRET is only ${env.jwtSecret.length} characters. Use at least 32 ` +
        'so tokens cannot be brute-forced.'
    );
  }

  // --- MONGO_URI ---------------------------------------------------------
  if (!env.mongoUri) {
    if (env.isProduction || env.isServerless) {
      configErrors.push(
        'MONGO_URI is not set. A hosted deployment has no local MongoDB, so ' +
          'this must be a MongoDB Atlas connection string ' +
          '(mongodb+srv://user:pass@cluster/db).'
      );
    } else {
      // Local development is the one place a localhost default is helpful.
      env.mongoUri = 'mongodb://127.0.0.1:27017/simplecrm';
    }
  } else if (!/^mongodb(\+srv)?:\/\//.test(env.mongoUri)) {
    configErrors.push(
      `MONGO_URI does not look like a connection string (got "${env.mongoUri.slice(0, 24)}…"). ` +
        'It must start with mongodb:// or mongodb+srv://.'
    );
  } else if (
    (env.isProduction || env.isServerless) &&
    /(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(env.mongoUri)
  ) {
    // Catching this is the difference between a clear message and ten minutes
    // of staring at a connection timeout.
    configErrors.push(
      'MONGO_URI points at localhost, which cannot exist in a hosted ' +
        'deployment — the function has no local MongoDB. Use a MongoDB Atlas ' +
        'connection string instead.'
    );
  }

  // --- GEMINI_API_KEY (a warning, not an error) --------------------------
  /*
   * Deliberately not fatal. Every AI feature has a working non-AI path, so a
   * missing key degrades the product rather than breaking it, and refusing to
   * boot would be the wrong trade for a CRM whose core is not the AI.
   *
   * It is warned about LOUDLY because the failure is invisible otherwise. The
   * key was missing in production and nothing said so: AI search returned
   * keyword results behind a label that said AI, the summary card rendered its
   * deterministic fallback, and every response was a 200. The only evidence was
   * a `mode` field nobody was reading. A degraded feature that looks identical
   * to a working one is the kind of bug that survives for months.
   *
   * GET /api/internal/ai-status reports the same thing at any time, for when
   * nobody is watching the boot logs — which, on serverless, is everybody.
   */
  if (env.isProduction && !env.geminiApiKey) {
    console.warn(
      '[config] GEMINI_API_KEY is not set. The app will run, but every AI ' +
        'feature is falling back to its non-AI path: AI search is a plain ' +
        'keyword search, and customer summaries are generated from the figures ' +
        'rather than written. Check GET /api/internal/ai-status to confirm.'
    );
  }

  // --- STRIPE (a warning, not an error) ----------------------------------
  /*
   * Same reasoning as the Gemini warning above, with one addition that makes
   * it more urgent rather than less: a HALF-configured Stripe is worse than an
   * unconfigured one. With a secret key and no webhook secret the buyer reaches
   * the card form, pays, and no order is ever created — because the event that
   * creates it cannot be verified. Nothing in that sequence looks like an error
   * to the person who just spent money, which is why the half-configured case
   * is called out separately rather than folded into "not configured".
   */
  if (env.isProduction && env.stripeSecretKey && !env.stripeWebhookSecret) {
    console.warn(
      '[config] STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not. Card ' +
        'payments will be TAKEN and no order will ever be created, because the ' +
        'webhook that creates it cannot be verified. Set the webhook secret from ' +
        'the Stripe dashboard (Developers → Webhooks → your endpoint → signing secret).'
    );
  } else if (env.isProduction && !env.stripeSecretKey) {
    console.warn(
      '[config] STRIPE_SECRET_KEY is not set. The storefront will run, but card ' +
        'checkout is hidden and only cash-on-delivery and bank transfer are offered.'
    );
  }

  // --- CLIENT_ORIGIN (a warning, not an error) ---------------------------
  // Not fatal: when the frontend and API share an origin (which they do behind
  // the Vercel rewrites) the browser sends no Origin header and CORS never
  // engages. It only matters for a cross-origin caller.
  if (env.isProduction && env.clientOrigin.includes('localhost')) {
    console.warn(
      '[config] CLIENT_ORIGIN is still "%s" in production. This is harmless ' +
        'while the frontend and API share a domain, but any cross-origin ' +
        'browser client will be blocked by CORS.',
      env.clientOrigin
    );
  }
}

env.configErrors = configErrors;
env.isConfigValid = configErrors.length === 0;

/**
 * Log the problems once, at module load.
 *
 * This is what shows up in the platform's function logs, and it is deliberately
 * verbose: a deployment failure is read by someone who cannot attach a debugger.
 */
if (configErrors.length && !env.isTest) {
  console.error(
    [
      '',
      '='.repeat(72),
      `[config] ${configErrors.length} configuration problem(s) — the API cannot serve requests:`,
      '',
      ...configErrors.map((msg, i) => `  ${i + 1}. ${msg}`),
      '',
      env.isServerless
        ? 'Set these in your Vercel project: Settings → Environment Variables, then redeploy.'
        : 'Set these in backend/.env (copy backend/.env.example to start).',
      '='.repeat(72),
      '',
    ].join('\n')
  );
}

module.exports = env;
