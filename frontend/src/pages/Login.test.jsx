import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Login from './Login';
import { renderWithProviders, fakeUser, apiError } from '../test/utils';
import { authApi } from '../api/resources';

/**
 * The login screen.
 *
 * The API layer is mocked, not the network: the tests drive the real form, the
 * real context and the real submit handler, and only the outermost call is
 * replaced. That keeps them honest about everything between the keyboard and
 * the request, which is where login bugs actually live.
 */
vi.mock('../api/resources', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
  },
}));

describe('Login', () => {
  beforeEach(() => {
    // The AuthProvider calls /auth/me on mount to restore a session. A rejected
    // promise is the "not signed in" case, which is the state this screen is
    // reached in.
    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
  });

  it('renders the sign-in form', async () => {
    renderWithProviders(<Login />);

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('submits the credentials that were typed', async () => {
    const user = userEvent.setup();
    authApi.login.mockResolvedValue({ user: fakeUser() });

    renderWithProviders(<Login />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Karachi-Ledger-72');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() =>
      expect(authApi.login).toHaveBeenCalledWith({
        email: 'ayesha@example.com',
        password: 'Karachi-Ledger-72',
      })
    );
  });

  /**
   * The failure a user hits most often. The message must appear on the screen —
   * a form that silently does nothing after a wrong password is the worst
   * possible outcome, because the user cannot tell whether it was even sent.
   */
  it('shows the server’s message when the credentials are wrong', async () => {
    const user = userEvent.setup();
    authApi.login.mockRejectedValue(apiError(401, 'Invalid email or password'));

    renderWithProviders(<Login />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
  });

  /**
   * Account lockout returns a 429 with a wait time. That is a different
   * situation from a wrong password and the user needs to be told which — "try
   * again in 2 minutes" is actionable, "invalid credentials" would send them
   * round the same loop.
   */
  it('shows the lockout message and wait time on a 429', async () => {
    const user = userEvent.setup();
    authApi.login.mockRejectedValue(
      apiError(429, 'Too many failed sign-in attempts. Try again in 2 minutes.')
    );

    renderWithProviders(<Login />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/try again in 2 minutes/i)).toBeInTheDocument();
  });

  /** The form must come back to life, or a mistyped password locks the user out of their own UI. */
  it('re-enables the button after a failed attempt', async () => {
    const user = userEvent.setup();
    authApi.login.mockRejectedValue(apiError(401, 'Invalid email or password'));

    renderWithProviders(<Login />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByText(/invalid email or password/i);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in/i })).not.toBeDisabled()
    );
  });

  /**
   * No credential may be written anywhere JavaScript can read it. This is the
   * regression test for the whole Phase 1.1 change — if someone reintroduces
   * `localStorage.setItem(token)`, this fails.
   */
  it('never stores a token in localStorage or sessionStorage', async () => {
    const user = userEvent.setup();
    authApi.login.mockResolvedValue({ user: fakeUser(), token: 'a.jwt.token' });

    renderWithProviders(<Login />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.type(screen.getByLabelText(/password/i), 'Karachi-Ledger-72');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(authApi.login).toHaveBeenCalled());

    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
  });

  it('marks the password field so browsers offer to fill it', async () => {
    renderWithProviders(<Login />);

    const password = await screen.findByLabelText(/password/i);

    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
  });

  /**
   * "Request one", not "Create one". Signing up does not produce a working
   * account — it produces a request an administrator has to approve — and
   * saying so here sets the expectation before anyone fills in a form.
   */
  it('offers a link to request an account', async () => {
    renderWithProviders(<Login />);

    expect(await screen.findByRole('link', { name: /request one/i })).toHaveAttribute(
      'href',
      '/crm/register'
    );
  });
});
