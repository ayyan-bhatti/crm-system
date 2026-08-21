import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Account from './Account';
import { renderWithProviders, fakeUser, apiError } from '../test/utils';
import { authApi } from '../api/resources';

/**
 * The account page.
 *
 * It exists because `POST /api/auth/change-password` had been built, tested and
 * documented while nothing in the UI called it — an endpoint, not a feature.
 * These tests are what stops that happening again: they fail if the form stops
 * reaching the API.
 */
vi.mock('../api/resources', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    changePassword: vi.fn(),
  },
}));

describe('Account', () => {
  beforeEach(() => {
    authApi.me.mockResolvedValue(fakeUser());
    authApi.changePassword.mockResolvedValue({});
  });

  const render = () => renderWithProviders(<Account />, { route: '/account', guarded: true });

  it('shows the signed-in user’s details', async () => {
    render();

    expect(await screen.findByText('Ayesha Khan')).toBeInTheDocument();
    expect(screen.getByText('ayesha@example.com')).toBeInTheDocument();
  });

  /** The whole point of the page: the form must actually reach the endpoint. */
  it('sends the current and new password to the API', async () => {
    const user = userEvent.setup();
    render();

    await user.type(await screen.findByLabelText(/current password/i), 'Karachi-Ledger-72');
    await user.type(screen.getByLabelText(/^new password/i), 'Lahore-Inventory-91');
    await user.type(screen.getByLabelText(/confirm/i), 'Lahore-Inventory-91');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() =>
      expect(authApi.changePassword).toHaveBeenCalledWith({
        currentPassword: 'Karachi-Ledger-72',
        newPassword: 'Lahore-Inventory-91',
      })
    );
  });

  it('will not submit two new passwords that differ', async () => {
    const user = userEvent.setup();
    render();

    await user.type(await screen.findByLabelText(/current password/i), 'Karachi-Ledger-72');
    await user.type(screen.getByLabelText(/^new password/i), 'Lahore-Inventory-91');
    await user.type(screen.getByLabelText(/confirm/i), 'Lahore-Inventory-92');

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change password/i })).toBeDisabled();
    expect(authApi.changePassword).not.toHaveBeenCalled();
  });

  /** A wrong current password is the most likely failure and must be visible. */
  it('shows the reason a change was rejected', async () => {
    const user = userEvent.setup();
    authApi.changePassword.mockRejectedValue(apiError(401, 'Current password is incorrect'));

    render();

    await user.type(await screen.findByLabelText(/current password/i), 'wrong');
    await user.type(screen.getByLabelText(/^new password/i), 'Lahore-Inventory-91');
    await user.type(screen.getByLabelText(/confirm/i), 'Lahore-Inventory-91');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    expect(await screen.findByText(/current password is incorrect/i)).toBeInTheDocument();
  });

  it('clears the form after a successful change', async () => {
    const user = userEvent.setup();
    render();

    const current = await screen.findByLabelText(/current password/i);
    await user.type(current, 'Karachi-Ledger-72');
    await user.type(screen.getByLabelText(/^new password/i), 'Lahore-Inventory-91');
    await user.type(screen.getByLabelText(/confirm/i), 'Lahore-Inventory-91');
    await user.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => expect(current).toHaveValue(''));
  });

  /** Signing out other devices is a consequence worth warning about up front. */
  it('warns that other devices will be signed out', async () => {
    render();

    expect(await screen.findByText(/signs you out on every other device/i)).toBeInTheDocument();
  });
});
