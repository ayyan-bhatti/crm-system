import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { authApi } from '../api/resources';
import { onSessionExpired } from '../api/client';
import { announceSession, onSessionAnnounced } from '../api/sessionChannel';
import { useToast } from '../components/Toast';

/**
 * Holds the signed-in user for the whole app.
 *
 * There is no token here, and no token anywhere else in the frontend. The
 * session lives entirely in httpOnly cookies the browser attaches on its own,
 * so the only thing this context tracks is the *user* — which is what the UI
 * actually needs in order to greet someone and decide which nav links to show.
 *
 * On mount it calls GET /auth/me. Since we cannot look at a token to guess
 * whether a session exists, asking the server is the only way to know — and it
 * is also a free validity check: a session revoked while the tab was closed
 * fails here and the app renders the login page cleanly, instead of throwing a
 * 401 on whatever screen the user opens first.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const toast = useToast();
  const [user, setUser] = useState(null);

  /*
   * The signed-in user id, mirrored into a ref.
   *
   * The cross-tab listener and the focus handler are registered once and would
   * otherwise close over whatever `user` was at that moment — comparing the
   * server's answer against a value from several sessions ago. Re-registering
   * the listeners on every user change would fix that and would also mean
   * tearing down and rebuilding a BroadcastChannel every time anybody logs in.
   */
  const currentUserId = useRef(null);
  // `loading` guards the first paint. Without it, a refresh would flash the
  // login page for a moment before /auth/me comes back.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    authApi
      .me()
      .then((nextUser) => {
        if (!cancelled) setUser(nextUser);
      })
      // A 401 here just means "not signed in" — the normal state for a first
      // visit — so it is not an error worth showing anyone.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The api client tells us when a session has died mid-use (a 401 that even a
   * token refresh could not rescue). Dropping the user here makes every
   * ProtectedRoute redirect to /login at once, in React, with no full page
   * reload — the old code called window.location.assign, which threw away any
   * unsaved form state and the error message with it.
   */
  useEffect(() => onSessionExpired(() => setUser(null)), []);

  /**
   * Re-read the session from the server.
   *
   * Needed when something OUTSIDE this context has changed the cookies — the
   * accept-invite flow is signed in by the API as part of accepting, so the
   * session exists but this tab does not know it yet. Without this the user
   * would be bounced to /login by the route guard immediately after
   * successfully activating their account.
   */
  const refresh = useCallback(async () => {
    const nextUser = await authApi.me();
    setUser(nextUser);
    return nextUser;
  }, []);

  // One place to record who this tab believes it is, so the ref cannot drift
  // from the state it mirrors.
  useEffect(() => {
    currentUserId.current = user?._id ? String(user._id) : null;
  }, [user]);

  /**
   * Adopt whoever this browser now actually belongs to.
   *
   * CONVERGENCE RATHER THAN SIGN-OUT, and the choice is worth explaining.
   *
   * The obvious alternative is to log this tab out and send it to the login
   * screen. That is wrong in the common case: the person at the keyboard has
   * just signed in as somebody else deliberately, in another tab, and there is
   * exactly one live session in this browser. Signing them out of a tab they
   * did not touch to protest a change they made themselves is theatre — and
   * they would only sign straight back in as the same user this tab is about to
   * become anyway.
   *
   * So the tab re-reads the session and re-renders as the truth. That is also
   * precisely what a reload does, which means a tab left open and a tab
   * reloaded end up in the same state instead of two.
   */
  const adoptCurrentSession = useCallback(async () => {
    try {
      const nextUser = await authApi.me();
      const nextId = nextUser?._id ? String(nextUser._id) : null;

      if (nextId === currentUserId.current) return;

      setUser(nextUser);
      toast.info(
        `Signed in as ${nextUser.name} in another tab, so this tab has switched too. ` +
          'A browser can only hold one session at a time.'
      );
    } catch {
      /*
       * A 401 here means the browser signed OUT elsewhere. Clearing the user
       * sends every guarded route to the login screen, which is right — there
       * is no session left to adopt.
       */
      if (currentUserId.current !== null) {
        setUser(null);
        toast.info('Signed out in another tab.');
      }
    }
  }, [toast]);

  /*
   * The subscriptions below are registered ONCE and call through this ref.
   *
   * Depending on `adoptCurrentSession` directly would re-subscribe whenever it
   * changed identity, and re-subscribing tears down a BroadcastChannel and
   * builds a new one — losing any message in flight at that moment. That is not
   * hypothetical: it is what made the sign-out test fail about two runs in five,
   * with the listener simply never firing.
   *
   * A listener registered once cannot miss a message because of a render.
   */
  const adoptRef = useRef(adoptCurrentSession);
  useEffect(() => {
    adoptRef.current = adoptCurrentSession;
  }, [adoptCurrentSession]);

  /**
   * Another tab announced a change. This is the fast path.
   *
   * The id in the message is compared against this tab's own before anything is
   * fetched, so a tab announcing the identity it already has — which every tab
   * receives, including on its own login — costs nothing.
   */
  useEffect(
    () =>
      onSessionAnnounced((announcedId) => {
        if (announcedId === currentUserId.current) return;
        adoptRef.current();
      }),
    []
  );

  /**
   * The slow path, for when the fast one is unavailable or was missed.
   *
   * BroadcastChannel does not exist in every browser, a message posted while
   * this tab was discarded is gone, and a session can be replaced from an
   * entirely different window. Re-checking when the tab is brought to the front
   * covers all three: the user is about to look at it, which is exactly when it
   * must not be lying about who they are.
   *
   * Checked on becoming VISIBLE rather than on an interval, because a poll
   * would run forever in a background tab to answer a question nobody is
   * currently asking.
   */
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') adoptRef.current();
    };

    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);

    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      // Server-side revocation matters more than the local state change: it is
      // what stops a previously captured refresh token from working.
      await authApi.logout();
    } catch {
      // Even if the call fails (offline, server down) the local session must
      // still end — refusing to log someone out because the network is down is
      // the wrong failure mode.
    }
    setUser(null);
    announceSession(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),

      login: (email, password) =>
        authApi.login({ email, password }).then(({ user: nextUser }) => {
          setUser(nextUser);

          /*
           * Told to the other tabs immediately, because they have no way of
           * finding out on their own: replacing a session does not invalidate
           * anything, so their next request succeeds as this new user and they
           * would go on showing the previous one indefinitely.
           */
          announceSession(nextUser?._id);
          return nextUser;
        }),

      /**
       * Sign up. Deliberately does NOT set the user.
       *
       * Signing up creates a REQUEST, not a session — the account cannot be
       * used until an administrator approves it. Setting the user here would
       * put the app into a signed-in state with no credentials behind it: every
       * subsequent request would 401 and the person would be bounced back to
       * the login screen having apparently been logged in for a second.
       *
       * The caller shows the "waiting for approval" message instead.
       */
      register: (payload) => authApi.register(payload),

      logout,
      refresh,
      /** For flows signed in by the API itself — accepting an invitation. */
      announceSession,

      /** `hasRole('admin', 'manager')` — used by RoleGate and the nav. */
      hasRole: (...roles) => Boolean(user) && roles.includes(user.role),
    }),
    [user, loading, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an <AuthProvider>');
  return context;
}
