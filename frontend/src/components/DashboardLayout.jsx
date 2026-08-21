import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import usePermissions from '../hooks/usePermissions';
import { humanize } from '../ui';

/**
 * The shell every authenticated page renders inside: sidebar, header, content.
 *
 * The nav is role-aware — `roles` on an item lists who may see it, and items the
 * current user cannot use are simply not rendered. This is presentation only;
 * the API enforces the same rules independently.
 */

/* Inline SVGs rather than an icon package: seven glyphs is not worth a
   dependency, and these inherit currentColor so they follow the nav state. */
const icons = {
  dashboard: 'M3 3h7v7H3V3zm0 11h7v7H3v-7zm11 0h7v7h-7v-7zm0-11h7v7h-7V3z',
  customers:
    'M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4.4 0-8 2.2-8 5v1h16v-1c0-2.8-3.6-5-8-5z',
  products: 'M12 2l9 5v10l-9 5-9-5V7l9-5zm0 2.3L5.5 8 12 11.7 18.5 8 12 4.3zM5 9.6v6.2l6 3.3v-6.2L5 9.6zm14 0l-6 3.3v6.2l6-3.3V9.6z',
  orders:
    'M4 4h3l.9 4M7.9 8H20l-1.6 8H9.5L7.9 8zm2.1 12a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm8 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  users:
    'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm7.5 0a3 3 0 100-6 3 3 0 000 6zM9 13c-3.9 0-7 1.9-7 4.3V19h14v-1.7C16 14.9 12.9 13 9 13zm7.8.2c1.9.6 3.2 1.9 3.2 3.4V19h2v-2.4c0-1.7-2.2-3-5.2-3.4z',
  audit:
    'M6 2h9l5 5v15H6V2zm8 1.5V8h4.5L14 3.5zM8 12h8v1.5H8V12zm0 4h8v1.5H8V16z',
};

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/customers', label: 'Customers', icon: 'customers' },
  { to: '/products', label: 'Products', icon: 'products' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  // `requires` names an ACTION, not a role. See hooks/usePermissions for why:
  // the role list is an implementation detail of the permission, and repeating
  // it here is how the app ended up with the same policy spelled three ways.
  { to: '/users', label: 'Users', icon: 'users', requires: 'manageUsers' },
  { to: '/audit', label: 'Audit log', icon: 'audit', requires: 'viewAuditLog' },
];

function NavIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0 fill-current" aria-hidden="true">
      <path d={icons[name]} />
    </svg>
  );
}

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const { can } = usePermissions();
  const navigate = useNavigate();

  // Awaited so the navigation happens after the server has revoked the refresh
  // token — otherwise a fast click-through could race the request.
  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const visibleItems = NAV_ITEMS.filter((item) => !item.requires || can[item.requires]);

  const navClass = ({ isActive }) =>
    `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      isActive
        ? 'bg-brand text-white shadow-card'
        : 'text-ink-2 hover:bg-neutral-wash hover:text-ink'
    }`;

  // Initials avatar — cheaper and more reliable than an image, and it never 404s.
  const initials = user.name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return (
    <div className="flex min-h-full">
      {/* --- Sidebar ----------------------------------------------------- */}
      <aside className="hidden w-60 shrink-0 border-r border-hairline bg-surface sm:flex sm:flex-col">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">
            S
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-ink">SimpleCRM</span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {visibleItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
              <NavIcon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Signed-in identity, pinned to the bottom where account controls live. */}
        <div className="border-t border-hairline p-3">
          <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-wash text-xs font-semibold text-brand-ink">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">{user.name}</p>
              <p className="truncate text-xs text-muted">{humanize(user.role)}</p>
            </div>
          </div>

          {/* The account page holds the change-password form. Reachable from
              the identity block, which is where people look for it. */}
          <NavLink
            to="/account"
            className="mt-1 block w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-2 transition-colors hover:bg-neutral-wash hover:text-ink"
          >
            Your account
          </NavLink>

          <button
            type="button"
            onClick={handleLogout}
            className="mt-1 w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-ink-2 transition-colors hover:bg-neutral-wash hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* --- Main column -------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header: the sidebar is hidden below sm, so the nav repeats
            here as a scrolling row. */}
        <header className="flex h-16 items-center justify-between gap-4 border-b border-hairline bg-surface px-5 sm:hidden">
          <span className="text-[15px] font-semibold tracking-tight text-ink">SimpleCRM</span>
          <div className="flex items-center gap-3">
            <NavLink
              to="/account"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-wash text-xs font-semibold text-brand-ink"
              aria-label="Your account"
            >
              {initials}
            </NavLink>
            <button
              type="button"
              onClick={handleLogout}
              className="text-sm font-medium text-ink-2 hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </header>

        <nav className="flex gap-1 overflow-x-auto border-b border-hairline bg-surface px-3 py-2 sm:hidden">
          {visibleItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${
                  isActive ? 'bg-brand text-white' : 'text-ink-2'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="flex-1 overflow-x-hidden px-5 py-6 lg:px-8">
          <div className="mx-auto max-w-[1400px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
