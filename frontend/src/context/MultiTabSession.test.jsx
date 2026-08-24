import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, fakeUser, apiError } from '../test/utils';
import { authApi } from '../api/resources';
import { announceSession } from '../api/sessionChannel';
import { useAuth } from './AuthContext';

/**
 * Three tabs, three roles, one browser.
 *
 * THE REPORTED SYMPTOM AND THE ACTUAL BUG ARE DIFFERENT.
 *
 * Reported: sign in as a rep in tab A, a manager in tab B, an admin in tab C,
 * reload, and all three show the same role. That is correct browser behaviour
 * and cannot be otherwise — a cookie is keyed on (name, domain, path), there is
 * no tab dimension in that key, so one origin holds exactly one session.
 *
 * The real bug is what happened BEFORE the reload. Tab A kept its own React
 * state, so it went on rendering the rep's name, role and navigation while its
 * requests were authenticated as the admin. It never found out, because
 * replacing a session does not invalidate anything: the new cookie is valid, so
 * every request came back 200 with the NEW user's data behind the OLD user's
 * interface. `onSessionExpired` only fires on a 401, and there is no 401.
 *
 * These tests are about that: a tab must not go on claiming to be somebody it
 * is no longer acting as.
 */

vi.mock('../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
}));

const REP = fakeUser({ _id: 'u-rep', name: 'Sara Iqbal', role: 'sales_rep' });
const ADMIN = fakeUser({ _id: 'u-admin', name: 'Ayyan', role: 'admin' });

/** A component that renders whoever this tab currently believes it is. */
function WhoAmI() {
  const { user, loading } = useAuth();

  if (loading) return <p>loading</p>;
  if (!user) return <p>signed out</p>;

  return (
    <p>
      {user.name} ({user.role})
    </p>
  );
}

/** One tab, already signed in as `who`. */
const openTabAs = async (who) => {
  authApi.me.mockResolvedValue(who);
  const rendered = renderWithProviders(<WhoAmI />);
  await screen.findByText(`${who.name} (${who.role})`);
  return rendered;
};

/*
 * DRAIN THE CHANNEL BEFORE EACH TEST, OR ANNOUNCEMENTS LEAK BETWEEN THEM.
 *
 * Every test in this file shares one realm and one channel name, and a
 * BroadcastChannel delivers on a later task rather than synchronously. So an
 * announcement posted at the end of one test can still be queued when the next
 * one mounts its tab — and that tab, being a fresh subscriber, does exactly
 * what it should: re-reads /auth/me. Which is precisely what the "does nothing"
 * test asserts must not happen. It failed about one full-suite run in four.
 *
 * A real browser does not have this problem: a tab is not delivered a message
 * posted before it subscribed, and if it somehow were, re-checking would simply
 * converge it on the truth. This is a boundary between tests, not a bug in the
 * app — but a suite that fails one run in four teaches people to re-run it,
 * which is how a real failure gets waved through.
 *
 * Yielding a macrotask here flushes any pending delivery while no tab is
 * mounted, so it lands on nobody.
 */
beforeEach(async () => {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('when another tab signs in as somebody else', () => {
  /**
   * THE BUG, DIRECTLY.
   *
   * Before the fix this tab kept rendering "Sara Iqbal (sales_rep)"
   * indefinitely while every request it made was the admin's.
   */
  it('stops claiming to be the previous user', async () => {
    await openTabAs(REP);

    // Tab C signs in as the admin. The cookies this tab relies on are now the
    // admin's — the only thing that reaches this tab is the announcement.
    authApi.me.mockResolvedValue(ADMIN);
    announceSession(ADMIN._id);

    await waitFor(() => expect(screen.queryByText(/Sara Iqbal/)).not.toBeInTheDocument());
  });

  /**
   * Convergence rather than sign-out: there is one live session in this
   * browser and this tab is part of it. Signing the person out of a tab they
   * did not touch, to protest a change they made themselves, is theatre.
   */
  it('re-renders as whoever the browser now belongs to', async () => {
    await openTabAs(REP);

    authApi.me.mockResolvedValue(ADMIN);
    announceSession(ADMIN._id);

    expect(await screen.findByText('Ayyan (admin)')).toBeInTheDocument();
  });

  /** Silently swapping somebody's identity would be its own kind of wrong. */
  it('tells the person why the tab changed under them', async () => {
    await openTabAs(REP);

    authApi.me.mockResolvedValue(ADMIN);
    announceSession(ADMIN._id);

    expect(await screen.findByText(/another tab/i)).toBeInTheDocument();
    expect(screen.getByText(/one session at a time/i)).toBeInTheDocument();
  });

  /**
   * A tab announcing the identity it already holds is the common case — every
   * tab receives its own announcement — and must cost nothing.
   */
  it('does nothing when the announced session is the one it already has', async () => {
    await openTabAs(REP);
    authApi.me.mockClear();

    announceSession(REP._id);

    // Give the listener a chance to do the wrong thing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(authApi.me).not.toHaveBeenCalled();
    expect(screen.getByText('Sara Iqbal (sales_rep)')).toBeInTheDocument();
  });
});

describe('when another tab signs out', () => {
  it('signs this tab out too, because there is no session left to adopt', async () => {
    await openTabAs(REP);

    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    announceSession(null);

    expect(await screen.findByText('signed out')).toBeInTheDocument();
  });

  /** Already signed out is not news. */
  it('says nothing to a tab that was already signed out', async () => {
    authApi.me.mockRejectedValue(apiError(401, 'Not authenticated'));
    renderWithProviders(<WhoAmI />);
    await screen.findByText('signed out');

    announceSession(null);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText(/another tab/i)).not.toBeInTheDocument();
  });
});

/**
 * The fallback path. BroadcastChannel does not exist in every browser, a
 * message posted while a tab was discarded is gone, and a session can be
 * replaced from a different window entirely. Re-checking when the tab is
 * brought to the front covers all three — and that is exactly the moment it
 * must not be lying, because somebody is about to read it.
 */
describe('when the tab is brought back to the front', () => {
  it('re-checks who the browser belongs to', async () => {
    await openTabAs(REP);

    authApi.me.mockClear();
    authApi.me.mockResolvedValue(ADMIN);

    window.dispatchEvent(new Event('focus'));

    expect(await screen.findByText('Ayyan (admin)')).toBeInTheDocument();
  });

  /** No change, no interruption. */
  it('leaves an unchanged session alone', async () => {
    await openTabAs(REP);

    authApi.me.mockResolvedValue(REP);
    window.dispatchEvent(new Event('focus'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText('Sara Iqbal (sales_rep)')).toBeInTheDocument();
    expect(screen.queryByText(/another tab/i)).not.toBeInTheDocument();
  });
});
