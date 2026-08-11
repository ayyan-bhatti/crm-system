import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Spinner } from './common';

/**
 * Route guard.
 *
 * Wraps the authenticated part of the app. While the session is being restored
 * it renders a spinner rather than redirecting — otherwise every page refresh
 * would bounce a logged-in user to /login before /auth/me had answered.
 *
 * `roles` optionally narrows access further. Note this is a *usability* guard,
 * not a security one: the real enforcement is the role middleware on the API.
 * Hiding a page a user cannot use is a courtesy; the server is what says no.
 */
export default function ProtectedRoute({ children, roles }) {
  const { isAuthenticated, loading, user } = useAuth();
  const location = useLocation();

  if (loading) return <Spinner full />;

  if (!isAuthenticated) {
    // `state.from` lets the login page send the user back where they were
    // heading once they authenticate.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}

/**
 * Conditionally renders children based on role. Used for nav links and buttons
 * that only some roles should see (e.g. "New product" for managers/admins).
 */
export function RoleGate({ roles, children, fallback = null }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return fallback;
  return children;
}
