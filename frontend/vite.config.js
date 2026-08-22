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
     * Capped concurrency, deliberately below the core count.
     *
     * Vitest defaults to roughly one worker per core, and each worker builds
     * its own jsdom. On a twelve-core machine that is eleven DOM environments
     * at once, which is fine until memory is tight — and then it is not a
     * slowdown, it is intermittent FAILURES. Timing-sensitive assertions
     * started losing races that have nothing to do with the code under test,
     * roughly one full run in five, always in a different file.
     *
     * A flaky suite is worse than a slow one: people learn to re-run it instead
     * of reading it, and a real regression gets re-run away with the noise. Four
     * is comfortably stable here and costs a few seconds. CI runners have two to
     * four cores anyway, so this gives up nothing there.
     */
    maxWorkers: 4,
    minWorkers: 1,

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
