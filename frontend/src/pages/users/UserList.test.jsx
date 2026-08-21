import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserList from './UserList';
import { renderWithProviders, fakeUser } from '../../test/utils';
import { authApi, usersApi } from '../../api/resources';

/**
 * Inviting a colleague.
 *
 * These tests exist because of a specific failure: with no mail transport
 * configured, the invite link only ever reached the server log, while this
 * screen reported "Invitation sent" and moved on. The feature looked like it
 * worked and did not — the admin waited for a delivery that was never going to
 * happen, and the invitee never received anything.
 *
 * So the assertions below are mostly about honesty. When the server says no
 * email went out, the screen has to say so and hand over the link.
 */

vi.mock('../../api/resources', () => ({
  authApi: {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
  },
  usersApi: {
    list: vi.fn(),
    invite: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setStatus: vi.fn(),
  },
}));

/** What the API returns when it could not email the invite. */
const NOT_EMAILED = {
  success: true,
  message: 'Invite link created. No email was sent, because this deployment has no mail '
    + 'transport configured — share the link below with them directly.',
  data: { _id: '2', name: 'Bilal Ahmed', email: 'bilal@example.com' },
  meta: {
    emailed: false,
    inviteLink: 'https://crm.example.com/accept-invite?token=' + 'a1b2c3d4'.repeat(8),
  },
};

/** What it returns when a real transport delivered it. */
const EMAILED = {
  success: true,
  message: 'Invitation emailed.',
  data: { _id: '2', name: 'Bilal Ahmed', email: 'bilal@example.com' },
  meta: { emailed: true },
};

describe('UserList invitations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authApi.me.mockResolvedValue(fakeUser({ role: 'admin' }));
    usersApi.list.mockResolvedValue([
      { ...fakeUser({ role: 'admin' }), status: 'active' },
    ]);
  });

  const render = () => renderWithProviders(<UserList />, { route: '/users', guarded: true });

  /*
   * jsdom exposes navigator.clipboard as a getter-only property, and
   * userEvent.setup() installs a stub of its own, so this has to be defined
   * rather than assigned, and only after setup() has run.
   */
  const stubClipboard = (writeText) => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    return writeText;
  };

  /** Fill in the invite form and submit it. */
  async function inviteSomeone(user) {
    await user.click(await screen.findByRole('button', { name: /invite user/i }));
    await user.type(screen.getByLabelText(/name/i), 'Bilal Ahmed');
    await user.type(screen.getByLabelText(/email/i), 'bilal@example.com');
    await user.click(screen.getByRole('button', { name: /send invitation|invite/i }));
  }

  describe('when the server could not send an email', () => {
    beforeEach(() => {
      usersApi.invite.mockResolvedValue(NOT_EMAILED);
    });

    /** The whole point: the link has to be reachable from the screen. */
    it('shows the invite link so the admin can pass it on', async () => {
      const user = userEvent.setup();
      render();

      await inviteSomeone(user);

      const field = await screen.findByLabelText(/invitation link/i);
      expect(field).toHaveValue(NOT_EMAILED.meta.inviteLink);
    });

    it('says plainly that no email was sent', async () => {
      const user = userEvent.setup();
      render();

      await inviteSomeone(user);

      expect(await screen.findByText(/no email was sent/i)).toBeInTheDocument();
    });

    it('names the person the link is for, so it is not sent to the wrong inbox', async () => {
      const user = userEvent.setup();
      render();

      await inviteSomeone(user);

      const panel = (await screen.findByLabelText(/invitation link/i)).closest('div')
        .parentElement;
      expect(within(panel).getByText('bilal@example.com')).toBeInTheDocument();
    });

    it('copies the link to the clipboard', async () => {
      const user = userEvent.setup();
      const writeText = stubClipboard(vi.fn().mockResolvedValue(undefined));
      render();

      await inviteSomeone(user);
      await user.click(await screen.findByRole('button', { name: /copy link/i }));

      expect(writeText).toHaveBeenCalledWith(NOT_EMAILED.meta.inviteLink);
      expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
    });

    /**
     * Clipboard access can be refused, and over plain HTTP the API is absent
     * entirely. The link must still be readable — otherwise a rejected
     * permission prompt strands the admin with no way to get it out.
     */
    it('still shows the link when the clipboard is unavailable', async () => {
      const user = userEvent.setup();
      stubClipboard(vi.fn().mockRejectedValue(new Error('denied')));
      render();

      await inviteSomeone(user);
      await user.click(await screen.findByRole('button', { name: /copy link/i }));

      expect(screen.getByLabelText(/invitation link/i)).toHaveValue(
        NOT_EMAILED.meta.inviteLink
      );
    });

    it('can be dismissed once the admin has the link', async () => {
      const user = userEvent.setup();
      render();

      await inviteSomeone(user);
      await user.click(await screen.findByRole('button', { name: /dismiss/i }));

      expect(screen.queryByLabelText(/invitation link/i)).not.toBeInTheDocument();
    });
  });

  describe('when the invite really was emailed', () => {
    beforeEach(() => {
      usersApi.invite.mockResolvedValue(EMAILED);
    });

    /**
     * The invitee's inbox should be the only place the link exists. Showing it
     * here as well would put a live credential on screen for no reason.
     */
    it('does not show a link', async () => {
      const user = userEvent.setup();
      render();

      await inviteSomeone(user);

      expect(await screen.findByText(/invitation emailed/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/invitation link/i)).not.toBeInTheDocument();
    });
  });
});
