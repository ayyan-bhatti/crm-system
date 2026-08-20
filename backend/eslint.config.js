const js = require('@eslint/js');
const globals = require('globals');

/**
 * Lint rules for the backend.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR
 *
 * Not formatting. There is no style config here, no line-length rule, no
 * opinion about quotes — those are arguments that cost more than they settle,
 * and CI failing because a line is 101 characters teaches people to ignore CI.
 *
 * What it does catch is the class of mistake that is invisible in review and
 * only shows up at runtime: a typo'd variable, an unused import left behind by
 * a refactor, a promise nobody awaited. `eslint:recommended` covers most of it;
 * the additions below are the ones this codebase specifically wants.
 */
module.exports = [
  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      /*
       * `console` is a deliberate part of this backend, not a leftover.
       * Configuration problems, CORS rejections, refresh-token reuse and AI
       * usage are all reported through it — on a hosted platform the log stream
       * is the only view into a running deployment. Warning about it would mean
       * eslint-disable comments on every one of those lines.
       */
      'no-console': 'off',

      /*
       * Unused variables are an error, not a warning, with one exception:
       * arguments prefixed with `_`. Express identifies error handlers by their
       * ARITY, so `(err, req, res, next)` must keep four parameters even when
       * `next` is never called — removing it silently turns the error handler
       * into ordinary middleware and every error becomes an unhandled 500.
       */
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_|^next$', varsIgnorePattern: '^_' },
      ],

      // A `catch {}` that swallows an error is almost always a bug in waiting.
      // Where it is genuinely correct, the code says why in a comment.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // Catches `if (x = 1)` — a typo that is valid JavaScript and always wrong.
      'no-cond-assign': ['error', 'always'],

      /*
       * Off, after seeing what it actually flags here.
       *
       * It reports `req.user = user` after an `await` as a possible race. In
       * Express that is not merely safe but the standard pattern: each request
       * has its own `req` object and no other code holds a reference to it, so
       * there is nothing to race with. Every occurrence in this codebase was a
       * false positive, and thirty warnings nobody can act on is how a team
       * learns to ignore lint output entirely.
       */
      'require-atomic-updates': 'off',
    },
  },

  {
    // Jest's globals, so `describe` and `expect` are not reported as undefined.
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },

  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
];
