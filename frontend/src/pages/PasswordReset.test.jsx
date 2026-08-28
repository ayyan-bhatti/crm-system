import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForgotPassword from './ForgotPassword';
import ResetPassword from './ResetPassword';
import { renderWithProviders, apiError } from '../test/utils';
import { authApi } from '../api/resources';

/**
 * The forgot-password screens.
 *
 * The behaviour worth pinning is the one that is easy to undo by accident: the
 * API deliberately answers identically whether or not an address has an
 * account, and this UI has to hold that line. A helpful "no account with that
 * email" here would hand back the enumeration oracle the API refused to give.
 */
vi.mock('../api/resources', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    forgotPassword: vi.fn(),
    resetPassword: vi.fn(),
  },
}));

describe('ForgotPassword', () => {
  beforeEach(() => {
    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    authApi.forgotPassword.mockResolvedValue({ success: true });
  });

  it('sends the address to the API', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() =>
      expect(authApi.forgotPassword).toHaveBeenCalledWith('ayesha@example.com')
    );
  });

  /**
   * THE ONE THAT MATTERS. The confirmation must be phrased so it reveals
   * nothing — "if an account exists", never "we've sent you an email".
   */
  it('confirms without revealing whether the account exists', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);

    await user.type(await screen.findByLabelText(/email/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument();
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
  });

  it('shows the same confirmation for a known address', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument();
  });

  it('says how long the link lasts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ForgotPassword />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/30 minutes/i)).toBeInTheDocument();
  });

  /** Rate limiting is a real outcome on this endpoint, so its message must land. */
  it('surfaces a genuine failure, such as being rate limited', async () => {
    const user = userEvent.setup();
    authApi.forgotPassword.mockRejectedValue(
      apiError(429, 'Too many password change attempts. Please try again later.')
    );

    renderWithProviders(<ForgotPassword />);

    await user.type(await screen.findByLabelText(/email/i), 'ayesha@example.com');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(/too many password change attempts/i)).toBeInTheDocument();
  });

  it('offers a way back to sign in', async () => {
    renderWithProviders(<ForgotPassword />);

    expect(await screen.findByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/crm/login'
    );
  });
});

describe('ResetPassword', () => {
  const TOKEN = 'a'.repeat(64);

  beforeEach(() => {
    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    authApi.resetPassword.mockResolvedValue({ success: true });
  });

  const renderWithToken = (token = TOKEN) =>
    renderWithProviders(<ResetPassword />, { route: `/reset-password?token=${token}` });

  it('submits the token with the new password', async () => {
    const user = userEvent.setup();
    renderWithToken();

    await user.type(await screen.findByLabelText(/^new password/i), 'Lahore-Inventory-91');
    await user.type(screen.getByLabelText(/confirm/i), 'Lahore-Inventory-91');
    await user.click(screen.getByRole('button', { name: /set new password/i }));

    await waitFor(() =>
      expect(authApi.resetPassword).toHaveBeenCalledWith({
        token: TOKEN,
        password: 'Lahore-Inventory-91',
      })
    );
  });

  /**
   * Not a security control — the server has no opinion about the confirmation
   * field. It exists so a typo in a password nobody can see does not lock
   * someone out of the account they are recovering.
   */
  it('will not submit two passwords that differ', async () => {
    const user = userEvent.setup();
    renderWithToken();

    await user.type(await screen.findByLabelText(/^new password/i), 'Lahore-Inventory-91');
    await user.type(screen.getByLabelText(/confirm/i), 'Lahore-Inventory-92');

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set new password/i })).toBeDisabled();
    expect(authApi.resetPassword).not.toHaveBeenCalled();
  });

  it('warns that every device will be signed out', async () => {
    renderWithToken();

    expect(await screen.findByText(/signs you out on every device/i)).toBeInTheDocument();
  });

  /**
   * An expired link is the most likely failure on this screen, and the message
   * has to say what to do about it rather than failing blankly.
   */
  it('shows the reason a link was rejected', async () => {
    const user = userEvent.setup();
    authApi.resetPassword.mockRejectedValue(
      apiError(400, 'This reset link has expired. Please request a new one.')
    );

    renderWithToken();

    await user.type(await screen.findByLabelText(/^new password/i), 'Lahore-Inventory-91');
    await user.type(screen.getByLabelText(/confirm/i), 'Lahore-Inventory-91');
    await user.click(screen.getByRole('button', { name: /set new password/i }));

    expect(await screen.findByText(/has expired/i)).toBeInTheDocument();
  });

  it('shows a password-policy rejection', async () => {
    const user = userEvent.setup();
    authApi.resetPassword.mockRejectedValue(
      apiError(400, 'Password does not meet the security requirements', {
        password: 'Password is too common',
      })
    );

    renderWithToken();

    await user.type(await screen.findByLabelText(/^new password/i), 'password123');
    await user.type(screen.getByLabelText(/confirm/i), 'password123');
    await user.click(screen.getByRole('button', { name: /set new password/i }));

    expect(await screen.findByText(/too common/i)).toBeInTheDocument();
  });

  /** The form must come back to life, or one rejection ends the recovery. */
  it('lets the user try again after a rejection', async () => {
    const user = userEvent.setup();
    authApi.resetPassword.mockRejectedValue(apiError(400, 'Password is too common'));

    renderWithToken();

    await user.type(await screen.findByLabelText(/^new password/i), 'password123');
    await user.type(screen.getByLabelText(/confirm/i), 'password123');
    await user.click(screen.getByRole('button', { name: /set new password/i }));

    await screen.findByText(/too common/i);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /set new password/i })).not.toBeDisabled()
    );
  });

  /** A truncated URL is a real thing email clients do. */
  it('explains a link with no token instead of failing silently', async () => {
    renderWithProviders(<ResetPassword />, { route: '/reset-password' });

    expect(await screen.findByText(/this link is incomplete/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute(
      'href',
      '/crm/forgot-password'
    );
  });
});
