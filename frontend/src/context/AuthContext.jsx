import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../api/resources';
import { TOKEN_KEY } from '../api/client';

/**
 * Holds the signed-in user for the whole app.
 *
 * The token lives in localStorage (the axios client reads it on every request);
 * this context holds the decoded *user*, which is what the UI actually needs in
 * order to greet someone and to decide which nav links to show.
 *
 * On mount it calls GET /auth/me to restore the session after a page refresh.
 * That round trip is also a free validity check: a token that was revoked or
 * expired while the tab was closed fails here and the user is logged out
 * cleanly, rather than hitting a 401 on whatever screen they open first.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // `loading` guards the first paint. Without it, a refresh would flash the
  // login page for a moment before /auth/me comes back.
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);

    if (!token) {
      setLoading(false);
      return;
    }

    authApi
      .me()
      .then(setUser)
      .catch(() => localStorage.removeItem(TOKEN_KEY))
      .finally(() => setLoading(false));
  }, []);

  /** Store the token first, so the very next request is already authenticated. */
  function persistSession({ user: nextUser, token }) {
    localStorage.setItem(TOKEN_KEY, token);
    setUser(nextUser);
    return nextUser;
  }

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),

      login: (email, password) => authApi.login({ email, password }).then(persistSession),

      register: (payload) => authApi.register(payload).then(persistSession),

      logout: () => {
        localStorage.removeItem(TOKEN_KEY);
        setUser(null);
      },

      /** `hasRole('admin', 'manager')` — used by RoleGate and the nav. */
      hasRole: (...roles) => Boolean(user) && roles.includes(user.role),
    }),
    [user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an <AuthProvider>');
  return context;
}
