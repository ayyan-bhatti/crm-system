import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../api/resources';
import { onSessionExpired } from '../api/client';

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
  const [user, setUser] = useState(null);
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
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),

      login: (email, password) =>
        authApi.login({ email, password }).then(({ user: nextUser }) => {
          setUser(nextUser);
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
