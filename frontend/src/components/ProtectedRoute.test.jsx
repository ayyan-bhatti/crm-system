import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import Can from './Can';
import { renderWithProviders, fakeUser, apiError } from '../test/utils';
import { authApi } from '../api/resources';

/**
 * Route guarding.
 *
 * Worth being clear about what these tests do and do not prove. The guard is a
 * USABILITY control — it stops people opening screens they cannot use. It is
 * not the security boundary; the API enforces the same rules independently and
 * has its own tests. A passing test here says "the right screen was shown", not
 * "the data is protected".
 *
 * The case that matters most is the third one: a page refresh must not bounce a
 * signed-in user to /login while the session is still being restored.
 */
vi.mock('../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
}));

/** A tiny app with a public and a guarded route, so redirects are observable. */
function TestApp({ roles }) {
  return (
    <Routes>
      <Route path="/login" element={<p>Login screen</p>} />
      <Route path="/" element={<p>Home screen</p>} />
      <Route
        path="/secret"
        element={
          <ProtectedRoute roles={roles}>
            <p>Secret screen</p>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page for a signed-in user', async () => {
    authApi.me.mockResolvedValue(fakeUser());

    renderWithProviders(<TestApp />, { route: '/secret' });

    expect(await screen.findByText('Secret screen')).toBeInTheDocument();
  });

  it('redirects to login when there is no session', async () => {
    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));

    renderWithProviders(<TestApp />, { route: '/secret' });

    expect(await screen.findByText('Login screen')).toBeInTheDocument();
    expect(screen.queryByText('Secret screen')).not.toBeInTheDocument();
  });

  /**
   * THE ONE THAT MATTERS.
   *
   * On a page refresh the app cannot know whether a session exists until
   * /auth/me answers — there is no token to inspect any more. If the guard
   * treated "not yet known" as "not signed in", every refresh would flash the
   * login page and throw the user out of the screen they were on.
   */
  it('waits for the session check instead of redirecting while it is pending', async () => {
    // A promise that never settles: the request is in flight forever.
    authApi.me.mockReturnValue(new Promise(() => {}));

    renderWithProviders(<TestApp />, { route: '/secret' });

    // Neither the page nor a redirect — it holds.
    expect(screen.queryByText('Login screen')).not.toBeInTheDocument();
    expect(screen.queryByText('Secret screen')).not.toBeInTheDocument();
  });

  describe('role restrictions', () => {
    it('lets an allowed role through', async () => {
      authApi.me.mockResolvedValue(fakeUser({ role: 'admin' }));

      renderWithProviders(<TestApp roles={['admin']} />, { route: '/secret' });

      expect(await screen.findByText('Secret screen')).toBeInTheDocument();
    });

    /**
     * Sent home rather than to /login: they ARE signed in, so offering the
     * login form would be a confusing answer to "you cannot see this".
     */
    it('sends a disallowed role home, not to login', async () => {
      authApi.me.mockResolvedValue(fakeUser({ role: 'sales_rep' }));

      renderWithProviders(<TestApp roles={['admin']} />, { route: '/secret' });

      expect(await screen.findByText('Home screen')).toBeInTheDocument();
      expect(screen.queryByText('Login screen')).not.toBeInTheDocument();
    });

    it('keeps the admin-only audit screen away from a manager', async () => {
      authApi.me.mockResolvedValue(fakeUser({ role: 'manager' }));

      renderWithProviders(<TestApp roles={['admin']} />, { route: '/secret' });

      expect(await screen.findByText('Home screen')).toBeInTheDocument();
    });
  });
});

/**
 * <Can> replaced <RoleGate>, which took a ROLE LIST.
 *
 * The difference is not cosmetic: with a role list, every call site restated
 * the policy, so changing who may do something meant finding and editing all of
 * them consistently — which is how the customer and order detail pages ended up
 * with no checks at all. Naming the ACTION puts the policy in one table.
 */
describe('Can', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows its children to a role that has the permission', async () => {
    authApi.me.mockResolvedValue(fakeUser({ role: 'manager' }));

    renderWithProviders(
      <Can do="manageProducts">
        <button type="button">New product</button>
      </Can>
    );

    expect(await screen.findByRole('button', { name: /new product/i })).toBeInTheDocument();
  });

  it('hides them from a role that does not', async () => {
    authApi.me.mockResolvedValue(fakeUser({ role: 'sales_rep' }));

    renderWithProviders(
      <Can do="manageProducts">
        <button type="button">New product</button>
      </Can>
    );

    // Wait for the session to resolve before asserting an absence, or the test
    // would pass simply because nothing had rendered yet.
    await screen.findByText((_, element) => element?.tagName === 'BODY');
    expect(screen.queryByRole('button', { name: /new product/i })).not.toBeInTheDocument();
  });

  it('renders nothing when there is no user at all', async () => {
    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));

    const { container } = renderWithProviders(
      <Can do="manageUsers">
        <button type="button">Delete everything</button>
      </Can>
    );

    expect(container.textContent).toBe('');
  });

  /** The escape hatch, for when an unexplained absence is worse than a hole. */
  it('renders the fallback instead of nothing when one is given', async () => {
    authApi.me.mockResolvedValue(fakeUser({ role: 'sales_rep' }));

    renderWithProviders(
      <Can do="manageProducts" fallback={<p>Products are read-only for your role.</p>}>
        <button type="button">New product</button>
      </Can>
    );

    expect(await screen.findByText(/read-only for your role/i)).toBeInTheDocument();
  });

  /**
   * A misspelled action would otherwise be silently falsy: the control
   * disappears for everyone including the admin, and looks exactly like a
   * deliberate rule. Loud in development is the right trade — the API still
   * enforces the real permission, so a stray visible button is a far smaller
   * problem than an invisible missing one.
   */
  it('throws on an unknown action rather than hiding silently', async () => {
    authApi.me.mockResolvedValue(fakeUser({ role: 'admin' }));

    // React logs the error it re-throws; silence it so the output stays readable.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() =>
        renderWithProviders(
          <Can do="manageProdcuts">
            <button type="button">Typo</button>
          </Can>
        )
      ).toThrow(/not a known action/i);
    } finally {
      spy.mockRestore();
    }
  });
});
