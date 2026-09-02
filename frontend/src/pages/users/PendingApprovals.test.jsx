import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PendingApprovals from './PendingApprovals';
import { renderWithProviders, fakeUser } from '../../test/utils';
import { authApi, usersApi } from '../../api/resources';

/**
 * The approvals queue.
 *
 * Somebody who has signed up is blocked until an administrator acts, and the
 * cost of missing them is a colleague who cannot do their job while believing
 * they have already done everything asked of them. So the two behaviours that
 * matter are: it is impossible to miss when there is something waiting, and it
 * takes up no room at all when there is not.
 */

vi.mock('../../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  usersApi: { pending: vi.fn(), approve: vi.fn(), reject: vi.fn() },
}));

const REQUEST = {
  _id: 'u9',
  name: 'Bilal Ahmed',
  email: 'bilal@example.com',
  role: 'sales_rep',
  requestedRole: 'manager',
  createdAt: '2026-08-01T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  authApi.me.mockResolvedValue(fakeUser({ role: 'admin' }));
  usersApi.pending.mockResolvedValue([REQUEST]);
  usersApi.approve.mockResolvedValue({ ...REQUEST, status: 'active', role: 'manager' });
  usersApi.reject.mockResolvedValue({ ...REQUEST, status: 'rejected' });
});

const render = () =>
  renderWithProviders(<PendingApprovals />, { route: '/users', guarded: true });

describe('when somebody is waiting', () => {
  it('shows who, and what they asked for', async () => {
    render();

    expect(await screen.findByText('Bilal Ahmed')).toBeInTheDocument();
    expect(screen.getByText('bilal@example.com')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /pending approvals/i })).toBeInTheDocument();
  });

  /** A count in the way, so a queue of one is as visible as a queue of ten. */
  it('shows how many are waiting', async () => {
    usersApi.pending.mockResolvedValue([REQUEST, { ...REQUEST, _id: 'u10' }]);
    render();

    const heading = await screen.findByRole('heading', { name: /pending approvals/i });
    expect(within(heading).getByText('2')).toBeInTheDocument();
  });

  /** Pre-selected because it is usually right, editable because it is a request. */
  it('preselects the role that was requested', async () => {
    render();

    expect(await screen.findByLabelText(/role to grant bilal/i)).toHaveValue('manager');
  });

  it('approves with the requested role by default', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /approve/i }));

    await waitFor(() => expect(usersApi.approve).toHaveBeenCalledWith('u9', 'manager'));
  });

  /**
   * Approving with a different role in ONE action. Approve-then-demote would
   * leave a window, however brief, where they hold access nobody agreed to.
   */
  it('can grant a different role than the one asked for', async () => {
    const user = userEvent.setup();
    render();

    await user.selectOptions(await screen.findByLabelText(/role to grant bilal/i), 'sales_rep');
    await user.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(usersApi.approve).toHaveBeenCalledWith('u9', 'sales_rep'));
  });

  it('does not offer administrator as something to grant here', async () => {
    render();

    const select = await screen.findByLabelText(/role to grant bilal/i);
    expect(Array.from(select.options).map((o) => o.value)).not.toContain('admin');
  });

  /**
   * Confirmed because the applicant cannot undo it: they cannot re-apply, since
   * the address stays reserved.
   */
  it('confirms before rejecting', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /reject/i }));

    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    expect(usersApi.reject).not.toHaveBeenCalled();
  });

  it('rejects when confirmed', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /reject/i }));

    const dialog = await screen.findByRole('alertdialog');
    // Scoped to the dialog: the row's own "Reject" trigger is still in the
    // document behind it, and its accessible name matches the same regex.
    await user.click(within(dialog).getByRole('button', { name: /^reject$/i }));

    await waitFor(() => expect(usersApi.reject).toHaveBeenCalledWith('u9'));
  });

  it('refreshes the queue after a decision', async () => {
    const user = userEvent.setup();
    render();

    await user.click(await screen.findByRole('button', { name: /approve/i }));

    // Once on mount, once after the decision.
    await waitFor(() => expect(usersApi.pending.mock.calls.length).toBeGreaterThan(1));
  });

  it('reports a failed decision rather than appearing to succeed', async () => {
    const user = userEvent.setup();
    usersApi.approve.mockRejectedValue({
      response: { data: { message: 'That account does not have a pending request to approve' } },
    });
    render();

    await user.click(await screen.findByRole('button', { name: /approve/i }));

    expect(await screen.findByText(/does not have a pending request/i)).toBeInTheDocument();
  });
});

describe('when nobody is waiting', () => {
  /**
   * Renders nothing at all, so it costs no space in the normal case. An empty
   * "no pending approvals" panel on every visit is how people learn to skip
   * past the area entirely — including on the day it is not empty.
   */
  it('takes up no room', async () => {
    usersApi.pending.mockResolvedValue([]);
    const { container } = render();

    await waitFor(() => expect(usersApi.pending).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  /**
   * Silent on failure too: this is an extra panel above a working screen, and
   * an error about the queue would obscure the user list underneath it.
   */
  it('stays out of the way when the queue cannot be loaded', async () => {
    usersApi.pending.mockRejectedValue(new Error('boom'));
    const { container } = render();

    await waitFor(() => expect(usersApi.pending).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
