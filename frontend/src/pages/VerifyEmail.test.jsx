import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render } from '@testing-library/react';
import VerifyEmail from './VerifyEmail';
import { authApi } from '../api/resources';

/**
 * The check-then-confirm shape: GET must never be what redeems the token
 * (see Unsubscribe.jsx for the identical reasoning), so an invalid check
 * must stop before the confirming POST is ever called.
 */
vi.mock('../api/resources', () => ({
  authApi: { checkEmailVerification: vi.fn(), verifyEmail: vi.fn() },
}));

function renderAt(token) {
  return render(
    <MemoryRouter initialEntries={[`/crm/verify-email?token=${token}`]}>
      <Routes>
        <Route path="/crm/verify-email" element={<VerifyEmail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VerifyEmail (staff)', () => {
  it('confirms the email when the check passes', async () => {
    authApi.checkEmailVerification.mockResolvedValue({ ok: true });
    authApi.verifyEmail.mockResolvedValue({ success: true, message: 'Email confirmed.' });

    renderAt('real-token');

    expect(await screen.findByText(/email confirmed/i)).toBeInTheDocument();
    expect(authApi.verifyEmail).toHaveBeenCalledWith('real-token');
  });

  it('never calls the confirming POST when the check says the token is invalid', async () => {
    authApi.checkEmailVerification.mockResolvedValue({ ok: false });

    renderAt('bad-token');

    expect(await screen.findByText(/we could not do that/i)).toBeInTheDocument();
    expect(authApi.verifyEmail).not.toHaveBeenCalled();
  });

  it('says the link is missing its code when there is no token in the URL', async () => {
    render(
      <MemoryRouter initialEntries={['/crm/verify-email']}>
        <Routes>
          <Route path="/crm/verify-email" element={<VerifyEmail />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/missing its confirmation code/i)).toBeInTheDocument();
    expect(authApi.checkEmailVerification).not.toHaveBeenCalled();
  });
});
