import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite configuration.
 *
 * Tailwind v4 is wired in as a Vite plugin, so there is no tailwind.config.js
 * or postcss.config.js — the plugin scans the source files itself.
 *
 * The dev server proxies /api to the Express backend. That means the browser
 * only ever talks to one origin during development, which sidesteps CORS
 * entirely while developing. `VITE_API_URL` still exists for deployments where
 * the API lives somewhere else.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],

  /**
   * Vitest.
   *
   * Configured here rather than in a separate vitest.config.js so the tests run
   * through the same plugin pipeline as the app — the JSX transform and the
   * `import.meta.env` handling are identical, which means a test cannot pass
   * against a build the browser would never produce.
   */
  test: {
    // React components need a DOM. jsdom is the lighter of the two options and
    // sufficient here — nothing in these tests depends on real layout.
    environment: 'jsdom',

    /*
     * The `threads` pool rather than the default `forks`.
     *
     * Vitest's forked workers fail to start when the project path contains a
     * space — which this one does ("digisofts project") — and the failure is an
     * opaque "Timeout waiting for worker to respond" rather than anything
     * naming the cause. Threads have no such problem, and for a suite of pure
     * component tests the isolation difference does not matter.
     */
    pool: 'threads',

    /*
     * Capped concurrency, deliberately below the core count on a dev
     * machine — and forced to a SINGLE worker under CI specifically, which
     * is the part that actually had to be right.
     *
     * Vitest defaults to roughly one worker per core, and each worker builds
     * its own jsdom. On a twelve-core dev machine that is eleven DOM
     * environments at once, which is fine until memory is tight — and then
     * it is not a slowdown, it is intermittent FAILURES: timing-sensitive
     * assertions lose races that have nothing to do with the code under
     * test. `maxWorkers: 4` was the first fix, on the assumption that "CI
     * runners have two to four cores anyway, so this gives up nothing
     * there." That assumption was never checked against what GitHub
     * Actions' `ubuntu-latest` standard runners actually provide: 2 vCPUs.
     * A worker count is an explicit override, not a hint bounded by real
     * hardware — Vitest spawns exactly the number configured regardless of
     * core count — so CI was running two workers' worth of contention on
     * every single run, not as an occasional unlucky scheduling event.
     *
     * Lowering the CI-side number and hoping a smaller one would finally be
     * small enough turned out to be the wrong shape of fix: this was
     * reproduced locally under heavy background load at both 4 and 2
     * workers, and once at 2 workers alone was shown not to be reliable
     * either — the failure is CPU-contention-shaped (a `findByRole` finding
     * NOTHING for the entire timeout window, not "a bit late"), and CPU
     * contention does not have a single safe worker count independent of
     * whatever else is sharing the machine at that moment. The only number
     * that removes the contention outright is one: `process.env.CI` (set by
     * every GitHub Actions runner) forces every file through a single
     * worker there, so two files' jsdom/React work is never scheduled onto
     * the same 2 vCPUs at once. Local development keeps the faster
     * multi-worker default, since an occasional flake a developer can
     * just re-run is a different cost than a red CI check blocking main.
     */
    maxWorkers: process.env.CI ? 1 : 4,
    minWorkers: 1,

    /*
     * Comfortably above the 5s `asyncUtilTimeout` set in the test setup.
     *
     * With the two equal, a `waitFor` that is genuinely going to fail dies of
     * the test timeout at the same instant it would have reported what it was
     * waiting for — so the output says "test timed out" instead of naming the
     * element it could not find. The gap is what makes a failure diagnosable.
     */
    testTimeout: 15000,

    globals: true,
    setupFiles: './src/test/setup.js',
    css: false,
    // Playwright specs live in e2e/ and are driven by a real browser; Vitest
    // must not try to run them.
    exclude: ['node_modules/**', 'e2e/**', 'dist/**'],
  },

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
});
