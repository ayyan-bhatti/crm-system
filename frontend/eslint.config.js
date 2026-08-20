import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * Lint rules for the frontend.
 *
 * Same principle as the backend config: this catches mistakes, not style. The
 * one thing worth having here that the backend does not need is the rules of
 * hooks — the single React mistake that is genuinely hard to see in review and
 * produces bugs that look like anything but their cause.
 */
export default [
  js.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...react.configs.flat.recommended.rules,

      /*
       * THE RULE THAT EARNS ITS KEEP.
       *
       * Calling a hook conditionally, or in a loop, breaks React's assumption
       * that the same hooks run in the same order every render. The symptom is
       * state appearing on the wrong component or a stale value that makes no
       * sense — never an error pointing at the cause. It is not reliably
       * catchable by review, which is exactly what a linter is for.
       */
      'react-hooks/rules-of-hooks': 'error',

      /*
       * Missing dependencies are a WARNING, not an error, and that is a
       * deliberate call.
       *
       * The rule is right most of the time and wrong in one case this codebase
       * has repeatedly: a `fetcher` passed as an inline arrow is a new function
       * every render, so obeying the rule would make the effect loop forever.
       * Those sites carry an eslint-disable and a comment explaining the
       * contract. Making the rule an error would mean either an unreadable pile
       * of disables or an infinite loop shipped to satisfy a linter.
       */
      'react-hooks/exhaustive-deps': 'warn',

      /*
       * React 17+ does not need React in scope for JSX, and this project uses
       * the automatic runtime.
       */
      'react/react-in-jsx-scope': 'off',

      /*
       * Prop types are off: this is a small app with no TypeScript, and
       * requiring runtime prop validation on every component would be ceremony
       * that catches less than the tests already do.
       */
      'react/prop-types': 'off',

      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-cond-assign': ['error', 'always'],
    },
  },

  {
    // Vitest globals (`globals: true` in the Vitest config) plus jsdom.
    files: ['**/*.test.{js,jsx}', 'src/test/**/*.{js,jsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },

  {
    // Playwright specs and its config run in Node, not the browser.
    files: ['e2e/**/*.js', 'playwright.config.js', 'vite.config.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  {
    ignores: ['node_modules/**', 'dist/**', 'playwright-report/**', 'test-results/**'],
  },
];
