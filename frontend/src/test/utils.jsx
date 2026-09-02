import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import ProtectedRoute from '../components/ProtectedRoute';
import { ToastProvider } from '../components/Toast';
import { ConfirmProvider } from '../components/ConfirmDialog';

/**
 * Helpers shared by the component tests.
 *
 * Almost every screen in this app needs the same two things to render at all: a
 * router (for `<Link>`, `useNavigate`, `useParams`) and the auth context. Doing
 * that wiring inline in each test would bury the thing being tested under
 * boilerplate, and — worse — would let two tests set up subtly different
 * environments and disagree for reasons nobody notices.
 *
 * `MemoryRouter` rather than `BrowserRouter`: there is no real URL bar in
 * jsdom, and a memory router lets a test start at any route and assert on
 * navigation without touching global history.
 */

/**
 * Render a component inside the router and auth provider.
 *
 * `guarded` wraps the component in the REAL `ProtectedRoute`, which is how
 * every authenticated screen is mounted in the app. This matters more than it
 * looks: those components read `user.role` directly and would crash on the
 * first render, before `/auth/me` resolves, if anything rendered them
 * unguarded. Using the actual guard rather than a stand-in means the test
 * environment cannot drift from production — and a component that DID crash
 * unguarded would be a real bug, caught here rather than hidden by a friendlier
 * test harness.
 *
 * @param {React.ReactElement} ui
 * @param {object} [options]
 * @param {string} [options.route] the initial URL
 * @param {string} [options.path] a route pattern, when the component reads params
 * @param {boolean} [options.guarded] mount inside ProtectedRoute, as the app does
 */
export function renderWithProviders(ui, { route = '/', path, guarded = false } = {}) {
  const element = guarded ? <ProtectedRoute>{ui}</ProtectedRoute> : ui;

  /*
   * The provider tree mirrors App.jsx exactly.
   *
   * That is not tidiness — `useToast` throws outside its provider, so a harness
   * missing one fails every test on a screen that raises a notification, for a
   * reason that has nothing to do with the screen. Keeping the two trees in
   * step is what stops the tests and the app disagreeing about what is
   * available.
   */
  const wrapper = (
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            {path ? (
              <Routes>
                <Route path={path} element={element} />
              </Routes>
            ) : (
              element
            )}
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>
  );

  return render(wrapper);
}

/** A user object shaped like the one the API returns. */
export function fakeUser(overrides = {}) {
  return {
    _id: '650000000000000000000001',
    name: 'Ayesha Khan',
    email: 'ayesha@example.com',
    role: 'manager',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Build an axios-shaped error, since the app's `errorMessage` helper reads
 * `error.response.data.message` and a plain `new Error()` would not exercise
 * the path the real failure takes.
 */
export function apiError(status, message, details) {
  const error = new Error(message);
  error.response = { status, data: { success: false, message, details } };
  return error;
}
