import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/*
 * Testing Library's default async timeout is 1000ms, which is generous on an
 * idle machine and not generous at all on a busy one. Two tests failed
 * intermittently for that reason alone — a render that normally takes 40ms
 * takes rather longer when the whole suite is competing for the same cores,
 * and the assertion had nothing wrong with it.
 *
 * Raised rather than patched per test, because the fix belongs to the class of
 * problem and not to the two tests that happened to surface it. This costs
 * nothing when things pass: `waitFor` polls until the condition holds and
 * returns immediately, so a higher ceiling only changes how long a genuine
 * failure takes to be reported.
 */
configure({ asyncUtilTimeout: 5000 });

/**
 * Test environment setup, run before every test file.
 *
 * WHAT THESE TESTS ARE FOR
 *
 * They exercise the app the way a user does — find the field by its label, type
 * into it, click the button, assert what appears — rather than reaching into
 * component internals. That is a deliberate choice: a test that asserts on
 * state or props breaks when the component is refactored and passes when the
 * screen is broken, which is exactly backwards. Testing Library makes the
 * user-facing route the easy one.
 *
 * The API is mocked at the axios boundary in each test rather than globally, so
 * every test states the server responses it depends on. A shared mock server
 * would be less repetitive and much harder to read: you could no longer tell
 * what a test assumes without opening another file.
 */

// Unmount everything between tests. Without it, a component left mounted keeps
// its timers and subscriptions running and can fail an unrelated later test.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/**
 * jsdom does not implement `matchMedia`, and anything doing responsive work
 * throws on it. Stubbed rather than left to fail, so a component that starts
 * using it does not break a suite for a reason unrelated to the change.
 */
if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * jsdom has no layout engine, so `scrollIntoView` is undefined. The picker
 * calls it when moving the highlight with the arrow keys.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
