import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Register from './Register';
import { renderWithProviders, apiError } from '../test/utils';
import { authApi } from '../api/resources';

/**
 * Asking for an account.
 *
 * The thing this page must not do is imply a working account. Submitting
 * creates one that cannot be used until an administrator approves it, and the
 * failure mode if the page is vague about that is somebody filling in a form,
 * seeing "success", and then being unable to sign in with no idea why.
 *
 * So these tests are mostly about what the page SAYS, and about the one
 * behaviour that would undermine all of it: signing the person in.
 */

vi.mock('../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
}));

const ACCEPTED = {
  success: true,
  message:
    'Your request has been sent to an administrator. You will be able to sign in once it has been approved.',
  data: { name: 'Bilal Ahmed', email: 'bilal@example.com', requestedRole: 'sales_rep' },
};

beforeEach(() => {
  vi.clearAllMocks();
  // No session — the visitor is anonymous, which is the only state this page
  // is ever rendered in.
  authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
  authApi.register.mockResolvedValue(ACCEPTED);
});

const render = () => renderWithProviders(<Register />, { route: '/register' });

const fillIn = async (user, { role } = {}) => {
  await user.type(await screen.findByLabelText(/^name/i), 'Bilal Ahmed');
  await user.type(screen.getByLabelText(/email/i), 'bilal@example.com');
  if (role) await user.selectOptions(screen.getByLabelText(/role you are requesting/i), role);
  await user.type(screen.getByLabelText(/password/i), 'Karachi-Ledger-72');
};

describe('the form', () => {
  it('asks for a role', async () => {
    render();

    const select = await screen.findByLabelText(/role you are requesting/i);
    expect(select).toBeInTheDocument();
  });

  /**
   * The most important assertion on this page. Offering admin as a selectable
   * option would put a tired administrator's attention between a stranger and
   * full control of the CRM.
   */
  it('does not offer administrator as a choice', async () => {
    render();

    const select = await screen.findByLabelText(/role you are requesting/i);
    const options = Array.from(select.options).map((o) => o.value);

    expect(options).toEqual(['manager', 'sales_rep']);
    expect(options).not.toContain('admin');
  });

  it('sends the chosen role with the request', async () => {
    const user = userEvent.setup();
    render();

    await fillIn(user, { role: 'manager' });
    await user.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() =>
      expect(authApi.register).toHaveBeenCalledWith({
        name: 'Bilal Ahmed',
        email: 'bilal@example.com',
        password: 'Karachi-Ledger-72',
        requestedRole: 'manager',
      })
    );
  });

  /** Set before anyone touches the dropdown, so the common case needs no thought. */
  it('defaults to the least-privileged role', async () => {
    const user = userEvent.setup();
    render();

    await fillIn(user);
    await user.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() => expect(authApi.register).toHaveBeenCalled());
    expect(authApi.register.mock.calls[0][0].requestedRole).toBe('sales_rep');
  });

  /** Set the expectation before the form is filled in, not after. */
  it('says up front that the account will not work yet', async () => {
    render();

    expect(await screen.findByText(/cannot be used until an administrator/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send request/i })).toBeInTheDocument();
  });
});

describe('after submitting', () => {
  it('confirms that the request is waiting on someone', async () => {
    const user = userEvent.setup();
    render();

    await fillIn(user);
    await user.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByRole('heading', { name: /request sent/i })).toBeInTheDocument();
    expect(screen.getByText(/once it has been approved/i)).toBeInTheDocument();
  });

  /**
   * Setting a user here would put the app into a signed-in state with no
   * credentials behind it: every request would 401 and the person would be
   * bounced to the login screen having apparently been logged in for a second.
   */
  it('does not sign the person in', async () => {
    const user = userEvent.setup();
    render();

    await fillIn(user);
    await user.click(screen.getByRole('button', { name: /send request/i }));

    await screen.findByRole('heading', { name: /request sent/i });
    expect(screen.queryByRole('button', { name: /send request/i })).not.toBeInTheDocument();
  });

  /** Nothing else to do: the password is already set. */
  it('tells them the password they chose is the one to use', async () => {
    const user = userEvent.setup();
    render();

    await fillIn(user);
    await user.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByText(/password you just chose/i)).toBeInTheDocument();
  });
});

describe('when the request is refused', () => {
  it('shows why and keeps what was typed', async () => {
    const user = userEvent.setup();
    authApi.register.mockRejectedValue(apiError(409, 'An account with that email already exists'));
    render();

    await fillIn(user);
    await user.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^name/i)).toHaveValue('Bilal Ahmed');
  });
});
