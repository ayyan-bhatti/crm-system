/**
 * Central place where every environment variable is read.
 *
 * Reading process.env in exactly one file means:
 *   - you can see the app's full configuration surface at a glance
 *   - defaults live next to the value they belong to
 *   - misconfiguration is reported in one place, loudly, with the fix attached
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
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
};

env.isTest = env.nodeEnv === 'test';
env.isProduction = env.nodeEnv === 'production';
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
    // eslint-disable-next-line no-console
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
  // eslint-disable-next-line no-console
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
