import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AcceptInvite from './AcceptInvite';
import { renderWithProviders, fakeUser, apiError } from '../test/utils';
import { authApi } from '../api/resources';

/**
 * Accepting an invitation.
 *
 * The property worth pinning is that the page identifies the invitee BEFORE
 * asking for a password. An anonymous "choose a password" box reached from an
 * email link is indistinguishable from a phishing page; the thing that makes it
 * legitimate is that it already knows who you are and what you were offered.
 */
vi.mock('../api/resources', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    getInvite: vi.fn(),
    acceptInvite: vi.fn(),
  },
}));

const TOKEN = 'a'.repeat(64);

const INVITE = {
  name: 'Bilal Ahmed',
  email: 'bilal@example.com',
  role: 'sales_rep',
};

describe('AcceptInvite', () => {
  beforeEach(() => {
    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    authApi.getInvite.mockResolvedValue(INVITE);
    authApi.acceptInvite.mockResolvedValue({ success: true });
  });

  const render = (token = TOKEN) =>
    renderWithProviders(<AcceptInvite />, { route: `/accept-invite?token=${token}` });

  it('loads the invitation before showing the form', async () => {
    render();

    await waitFor(() => expect(authApi.getInvite).toHaveBeenCalledWith(TOKEN));
  });

  /** The anti-phishing property: it greets you by name. */
  it('greets the invitee and shows what they are accepting', async () => {
    render();

    expect(await screen.findByText(/welcome, bilal/i)).toBeInTheDocument();
    expect(screen.getByText('bilal@example.com')).toBeInTheDocument();
    expect(screen.getByText(/sales rep/i)).toBeInTheDocument();
  });

  it('sends the token and chosen password', async () => {
    const user = userEvent.setup();
    authApi.me.mockResolvedValue(fakeUser());

    render();

    await user.type(await screen.findByLabelText(/^password/i), 'Karachi-Ledger-72');
    await user.type(screen.getByLabelText(/confirm/i), 'Karachi-Ledger-72');
    await user.click(screen.getByRole('button', { name: /activate my account/i }));

    await waitFor(() =>
      expect(authApi.acceptInvite).toHaveBeenCalledWith({
        token: TOKEN,
        password: 'Karachi-Ledger-72',
      })
    );
  });

  it('will not submit two passwords that differ', async () => {
    const user = userEvent.setup();
    render();

    await user.type(await screen.findByLabelText(/^password/i), 'Karachi-Ledger-72');
    await user.type(screen.getByLabelText(/confirm/i), 'Karachi-Ledger-73');

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activate my account/i })).toBeDisabled();
    expect(authApi.acceptInvite).not.toHaveBeenCalled();
  });

  /**
   * Reported on arrival rather than after the person has chosen and typed a
   * password twice.
   */
  it('reports an expired invitation before asking for anything', async () => {
    authApi.getInvite.mockRejectedValue(
      apiError(400, 'This invitation is not valid, has expired, or has already been used.')
    );

    render();

    expect(await screen.findByText(/cannot be used/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password/i)).not.toBeInTheDocument();
  });

  /**
   * Unlike a password reset, the recipient cannot issue themselves another —
   * only an administrator can, so the page says that rather than offering a
   * button that would not work.
   */
  it('tells the user to ask for a new invitation rather than offering one', async () => {
    authApi.getInvite.mockRejectedValue(apiError(400, 'Invalid'));

    render();

    expect(await screen.findByText(/ask whoever invited you/i)).toBeInTheDocument();
  });

  it('handles a link with no token', async () => {
    renderWithProviders(<AcceptInvite />, { route: '/accept-invite' });

    expect(await screen.findByText(/incomplete/i)).toBeInTheDocument();
    expect(authApi.getInvite).not.toHaveBeenCalled();
  });

  it('shows the reason an activation was rejected', async () => {
    const user = userEvent.setup();
    authApi.acceptInvite.mockRejectedValue(
      apiError(400, 'This invitation has expired. Ask an administrator to send a new one.')
    );

    render();

    await user.type(await screen.findByLabelText(/^password/i), 'Karachi-Ledger-72');
    await user.type(screen.getByLabelText(/confirm/i), 'Karachi-Ledger-72');
    await user.click(screen.getByRole('button', { name: /activate my account/i }));

    expect(await screen.findByText(/has expired/i)).toBeInTheDocument();
  });
});
