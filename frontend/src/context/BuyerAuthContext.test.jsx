import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { BuyerAuthProvider, useBuyerAuth } from './BuyerAuthContext';
import { shopAuthApi } from '../api/shopResources';
import { apiError } from '../test/utils';

/**
 * The buyer-track session context.
 *
 * Only `api/shopResources` is mocked, not `api/shopClient` — same convention
 * `Login.test.jsx` uses for the staff side: the axios instance and its
 * interceptors are real, only the outermost API call is replaced.
 */
vi.mock('../api/shopResources', () => ({
  shopAuthApi: {
    me: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  },
}));

function setup() {
  return renderHook(() => useBuyerAuth(), { wrapper: BuyerAuthProvider });
}

describe('BuyerAuthContext', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls /shop/auth/me on mount to restore a session', async () => {
    shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza', email: 'amina@example.com' });

    const { result } = setup();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(shopAuthApi.me).toHaveBeenCalledTimes(1);
    expect(result.current.isSignedIn).toBe(true);
    expect(result.current.buyer.name).toBe('Amina Raza');
  });

  /**
   * A 401 here means "no session", which is the ordinary case for a fresh
   * visitor — it must not be surfaced as an error state anywhere.
   */
  it('treats a 401 from /shop/auth/me as "not signed in", not an error', async () => {
    shopAuthApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));

    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isSignedIn).toBe(false);
    expect(result.current.buyer).toBeNull();
  });

  it('login stores the returned buyer and flips isSignedIn', async () => {
    shopAuthApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    shopAuthApi.login.mockResolvedValue({ buyer: { _id: 'b1', name: 'Amina Raza' } });

    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isSignedIn).toBe(false);

    await act(async () => {
      await result.current.login('amina@example.com', 'Karachi-Ledger-72');
    });

    expect(shopAuthApi.login).toHaveBeenCalledWith({
      email: 'amina@example.com',
      password: 'Karachi-Ledger-72',
    });
    expect(result.current.isSignedIn).toBe(true);
    expect(result.current.buyer.name).toBe('Amina Raza');
  });

  it('register stores the returned buyer and flips isSignedIn', async () => {
    shopAuthApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    shopAuthApi.register.mockResolvedValue({ buyer: { _id: 'b2', name: 'New Buyer' } });

    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.register({
        name: 'New Buyer',
        email: 'new@example.com',
        password: 'a-long-enough-password',
      });
    });

    expect(shopAuthApi.register).toHaveBeenCalledWith({
      name: 'New Buyer',
      email: 'new@example.com',
      password: 'a-long-enough-password',
    });
    expect(result.current.isSignedIn).toBe(true);
    expect(result.current.buyer.name).toBe('New Buyer');
  });

  it('logout clears the buyer', async () => {
    shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza' });
    shopAuthApi.logout.mockResolvedValue({});

    const { result } = setup();
    await waitFor(() => expect(result.current.isSignedIn).toBe(true));

    await act(async () => {
      await result.current.logout();
    });

    expect(shopAuthApi.logout).toHaveBeenCalled();
    expect(result.current.isSignedIn).toBe(false);
    expect(result.current.buyer).toBeNull();
  });

  /** A dropped network call must not strand the UI in a signed-in state. */
  it('still ends the local session when the logout request itself fails', async () => {
    shopAuthApi.me.mockResolvedValue({ _id: 'b1', name: 'Amina Raza' });
    shopAuthApi.logout.mockRejectedValue(new Error('network down'));

    const { result } = setup();
    await waitFor(() => expect(result.current.isSignedIn).toBe(true));

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.isSignedIn).toBe(false);
    expect(result.current.buyer).toBeNull();
  });
});
