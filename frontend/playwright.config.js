import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests.
 *
 * These start the REAL backend (against a throwaway in-memory MongoDB) and the
 * real frontend, and drive a real browser. That is deliberately heavier than
 * the Vitest component tests, and it buys something they cannot: proof that the
 * pieces work TOGETHER.
 *
 * Specifically, the riskiest work in this project — httpOnly cookies, the CSRF
 * double-submit header, refresh rotation, the order transaction — is all
 * interaction between browser and server. A component test mocks the server and
 * an API test has no browser, so neither can tell you the cookie was actually
 * accepted or the CSRF header actually sent. Only this can.
 *
 * Scope is kept deliberately narrow: the login → create order path, plus the
 * auth behaviours that path depends on. E2E tests are slow and the flakiest
 * thing in any suite, so they cover the flow that must never break rather than
 * trying to duplicate the 440 backend and 43 component tests.
 */
export default defineConfig({
  testDir: './e2e',

  // A generous per-test budget: the first run of a spec pays for the dev
  // server's on-demand compilation of each lazily-loaded route.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  // Serial by default. The backend seeds one shared dataset and the order specs
  // consume stock from it, so parallel workers would race over the same rows —
  // exactly the kind of flakiness that teaches people to ignore E2E failures.
  workers: 1,
  fullyParallel: false,

  // Retry in CI only. Locally a flake should be seen and fixed; in CI a single
  // retry distinguishes a genuine failure from infrastructure noise.
  retries: process.env.CI ? 1 : 0,

  // Fail the build if a spec was left focused with test.only.
  forbidOnly: Boolean(process.env.CI),

  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    // Artefacts only for failures — traces are large and nobody opens the ones
    // from passing tests.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /*
   * Both servers are started by Playwright, in this order.
   *
   * `reuseExistingServer` locally means a developer who already has the app
   * running is not forced to stop it; in CI it is off, so a stale process can
   * never make a run pass against the wrong build.
   */
  webServer: [
    {
      command: 'node ../backend/scripts/e2eServer.js',
      /*
       * The script chdirs to the backend itself — see the note at the top of
       * e2eServer.js about the mongod binary cache. Doing it there rather than
       * with a `cwd` here keeps the fix working however the server is launched.
       */
      url: 'http://localhost:5000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
