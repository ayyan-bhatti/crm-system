/**
 * Central place where every environment variable is read.
 *
 * Reading process.env in exactly one file means:
 *   - you can see the app's full configuration surface at a glance
 *   - defaults live next to the value they belong to
 *   - misconfiguration fails loudly at boot instead of mysteriously at runtime
 */
const path = require('path');
const dotenv = require('dotenv');

// Load backend/.env regardless of the directory the process was started from.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const env = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',

  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/simplecrm',

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
};

env.isTest = env.nodeEnv === 'test';
env.isProduction = env.nodeEnv === 'production';

/**
 * Validate configuration that the app genuinely cannot run without.
 *
 * Tests run against an in-memory database and generate their own secret, so we
 * only enforce this outside the test environment.
 */
if (!env.jwtSecret) {
  if (env.isTest) {
    // Deterministic throwaway secret so the test suite needs no .env file.
    env.jwtSecret = 'test-secret-not-used-outside-tests';
  } else {
    // eslint-disable-next-line no-console
    console.error(
      '\n[config] JWT_SECRET is not set. Copy backend/.env.example to backend/.env and fill it in.\n'
    );
    process.exit(1);
  }
}

module.exports = env;
