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

  /** console (default) | webhook — see services/mailer.js. */
  mailTransport: process.env.MAIL_TRANSPORT || 'console',
  mailWebhookUrl: process.env.MAIL_WEBHOOK_URL || '',
  mailFrom: process.env.MAIL_FROM || 'SimpleCRM <no-reply@simplecrm.local>',

  /**
   * Log verbosity: fatal | error | warn | info | debug | trace.
   *
   * `info` in production is the right default — one line per request plus
   * anything notable. `debug` locally when chasing something.
   */
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
};

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
 * How long audit entries are kept, in days. Unset means keep them forever.
 *
 * Deliberately opt-in. An audit trail that expires on a schedule nobody
 * remembers setting is one whose absence is discovered on the day it matters —
 * see services/auditRetention.js. Pruning is also a manual command rather than
 * a background job, so a deletion is an operational act with a log line.
 */
env.auditRetentionDays = Number(process.env.AUDIT_RETENTION_DAYS) || null;
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
