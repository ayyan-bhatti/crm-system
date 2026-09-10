import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import usePermissions from '../hooks/usePermissions';
import { humanize } from '../ui';
import { Drawer, DropdownMenu, MenuItem } from './common';
import CommandPalette, { openCommandPalette } from './CommandPalette';

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
  deliveries:
    'M3 7h10v8H3V7zm10 3h4l3 3v2h-7v-5zM6.5 16.5a1.75 1.75 0 100 3.5 1.75 1.75 0 000-3.5zm10 0a1.75 1.75 0 100 3.5 1.75 1.75 0 000-3.5z',
  users:
    'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm7.5 0a3 3 0 100-6 3 3 0 000 6zM9 13c-3.9 0-7 1.9-7 4.3V19h14v-1.7C16 14.9 12.9 13 9 13zm7.8.2c1.9.6 3.2 1.9 3.2 3.4V19h2v-2.4c0-1.7-2.2-3-5.2-3.4z',
  audit:
    'M6 2h9l5 5v15H6V2zm8 1.5V8h4.5L14 3.5zM8 12h8v1.5H8V12zm0 4h8v1.5H8V16z',
  /* An envelope, for the marketing contacts list. */
  campaigns:
    'M3 5h18v14H3V5zm2 2.4V17h14V7.4l-7 4.6-7-4.6zm.9-.4L12 10.6 18.1 7H5.9z',
  /* A clock with a check, for the scheduled post-sale jobs. */
  automation:
    'M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm-1 3v6l5 2.9 1-1.7-4-2.3V7h-2z',
};

/**
 * The nav is grouped into sections rather than one flat list — the same
 * information, organised so a reader can find "the commerce stuff" or "the
 * marketing stuff" without scanning every label. Every entry below is a route
 * that genuinely exists and renders real data; nothing here is a placeholder
 * for a screen that isn't built, because a link to nothing reads as broken,
 * not as ambitious. `NAV_ITEMS` (the flattened form) stays exported for the
 * command palette, which does not want section headers, just results.
 */
export const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [{ to: '/crm', label: 'Dashboard', icon: 'dashboard', end: true }],
  },
  {
    label: 'Commerce',
    items: [
      { to: '/crm/products', label: 'Products', icon: 'products' },
      { to: '/crm/orders', label: 'Orders', icon: 'orders' },
      // No `requires`: every staff role reaches this, and the ENDPOINT scopes
      // it. A rep sees the parcels on their own orders, which is exactly the
      // list they work from — gating it to manager-or-admin would hide the
      // queue from the person actually holding the parcel.
      { to: '/crm/deliveries', label: 'Deliveries', icon: 'deliveries' },
    ],
  },
  {
    label: 'Customers',
    items: [
      // Hidden from a sales rep entirely — they have no customer book. Nav is
      // where an absence is least confusing: a missing section reads as "not
      // my job", where a section that 403s reads as broken.
      { to: '/crm/customers', label: 'Customers', icon: 'customers', requires: 'viewCustomers' },
    ],
  },
  {
    label: 'Marketing',
    items: [
      /*
       * `Contacts` has no `requires` for the same reason `Deliveries` has
       * none: every role reaches it and the endpoint scopes it. A rep sees
       * the people whose orders they are fulfilling, which is contact detail
       * they already receive with each order — and it is the one screen from
       * which they can message that customer.
       *
       * `Campaigns` does, because a bulk send is not a rep's decision.
       *
       * `Automation` has none either, deliberately: a scheduled job that
       * stops firing produces no error and no complaint, and the only
       * visible symptom is a last-run date that stopped moving. The more
       * people who can notice that, the shorter the silence — so reading it
       * is open and only CHANGING it is gated, inside the page.
       */
      { to: '/crm/contacts', label: 'Contacts', icon: 'customers', requires: 'viewContacts' },
      { to: '/crm/campaigns', label: 'Campaigns', icon: 'campaigns', requires: 'launchCampaigns' },
      { to: '/crm/automation', label: 'Automation', icon: 'automation' },
    ],
  },
  {
    label: 'System',
    items: [
      // `requires` names an ACTION, not a role. See hooks/usePermissions for
      // why: the role list is an implementation detail of the permission,
      // and repeating it here is how the app ended up with the same policy
      // spelled three ways.
      { to: '/crm/approvals', label: 'Approvals', icon: 'users', requires: 'approveChanges' },
      { to: '/crm/users', label: 'Users', icon: 'users', requires: 'manageUsers' },
      { to: '/crm/audit', label: 'Audit log', icon: 'audit', requires: 'viewAuditLog' },
    ],
  },
];

export const NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

function NavIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0 fill-current" aria-hidden="true">
      <path d={icons[name]} />
    </svg>
  );
}

/** The brand mark, shared with the storefront header so the two read as one product. */
function Wordmark({ className = '' }) {
  return (
    <Link to="/crm" className={`flex items-center gap-2.5 ${className}`}>
      <span className="flex h-8 w-8 items-center justify-center rounded-md bg-ink text-[15px] font-semibold text-plane">
        S
      </span>
      <span className="font-display text-[19px] leading-none text-ink">SimpleCRM</span>
    </Link>
  );
}

/**
 * The signed-in identity, as a menu rather than three stacked links.
 *
 * The account controls moved out of the sidebar and into the header because
 * the sidebar's job is navigation between screens, and "sign out" is not a
 * screen. It also buys back the vertical space the nav actually needs.
 */
function ProfileMenu({ user, initials, onLogout }) {
  return (
    <DropdownMenu
      label="Account menu"
      triggerClassName="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      trigger={
        <>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-wash text-xs font-semibold text-brand-ink">
            {initials}
          </span>
          <span className="hidden min-w-0 text-left lg:block">
            <span className="block truncate text-sm font-medium leading-tight text-ink">{user.name}</span>
            <span className="block truncate text-xs leading-tight text-muted">{humanize(user.role)}</span>
          </span>
          <svg viewBox="0 0 20 20" className="hidden h-4 w-4 shrink-0 fill-muted lg:block" aria-hidden="true">
            <path d="M5.6 7.5L10 11.9l4.4-4.4 1.4 1.4-5.8 5.8-5.8-5.8z" />
          </svg>
        </>
      }
    >
      {(close) => (
        <>
          <div className="border-b border-hairline px-3 pb-2 pt-1 lg:hidden">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="truncate text-xs text-muted">{humanize(user.role)}</p>
          </div>
          <MenuItem to="/crm/account" onClick={close}>
            Your account
          </MenuItem>
          <MenuItem to="/" onClick={close}>
            Back to store
          </MenuItem>
          <MenuItem onClick={onLogout} className="border-t border-hairline">
            Sign out
          </MenuItem>
        </>
      )}
    </DropdownMenu>
  );
}

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const { can } = usePermissions();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  // Awaited so the navigation happens after the server has revoked the refresh
  // token — otherwise a fast click-through could race the request.
  async function handleLogout() {
    await logout();
    navigate('/crm/login', { replace: true });
  }

  const visibleSections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.requires || can[item.requires]),
  })).filter((section) => section.items.length > 0);

  const navClass = ({ isActive }) =>
    `relative flex items-center gap-3 rounded-md py-2 pl-4 pr-3 text-sm font-medium transition-colors ${
      isActive ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken/70 hover:text-ink'
    }`;

  // Initials avatar — cheaper and more reliable than an image, and it never 404s.
  const initials = user.name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  const navigation = (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-6">
      {visibleSections.map((section) => (
        <div key={section.label}>
          <p className="label-mono px-4 pb-2">{section.label}</p>
          <div className="space-y-0.5">
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={navClass}
                onClick={() => setNavOpen(false)}
              >
                {({ isActive }) => (
                  <>
                    {/*
                      The active marker is a rail rather than a filled pill.
                      A solid orange nav item would spend the one accent
                      colour on "where you are", which is exactly the job a
                      quiet background does perfectly well — leaving the
                      orange free to mean "this is the action".
                    */}
                    {isActive && (
                      <span
                        className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-brand"
                        aria-hidden="true"
                      />
                    )}
                    <NavIcon name={item.icon} />
                    {item.label}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );

  const storeLink = (
    <Link
      to="/"
      className="flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-muted transition-colors hover:bg-sunken hover:text-ink"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-current" aria-hidden="true">
        <path d="M9.3 3.3a1 1 0 011.4 0l6 6a1 1 0 01-1.4 1.4L15 10.4V16a1 1 0 01-1 1h-3a1 1 0 01-1-1v-3H10v3a1 1 0 01-1 1H6a1 1 0 01-1-1v-5.6l-.3.3a1 1 0 01-1.4-1.4l6-6z" />
      </svg>
      Back to store
    </Link>
  );

  return (
    <div className="flex min-h-full">
      <CommandPalette />

      {/* --- Sidebar (desktop) -------------------------------------------- */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-hairline bg-surface lg:flex">
        <div className="flex h-16 shrink-0 items-center px-5">
          <Wordmark />
        </div>
        {navigation}
        <div className="border-t border-hairline p-3">{storeLink}</div>
      </aside>

      {/* --- Sidebar (mobile, as a drawer) --------------------------------- */}
      <Drawer open={navOpen} onClose={() => setNavOpen(false)} side="left" title="Menu" className="max-w-[17rem]">
        <div className="flex h-full flex-col pt-3">
          {navigation}
          <div className="border-t border-hairline p-3">{storeLink}</div>
        </div>
      </Drawer>

      {/* --- Main column --------------------------------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          The header carries search, what needs attention, and who you are —
          the three things that belong to the session rather than to any one
          screen. Sticky, because on a long table the search box is the first
          thing you reach for after scrolling.
        */}
        <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-hairline bg-plane/85 px-4 backdrop-blur-sm lg:px-8">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="-ml-1 rounded-md p-2 text-ink-2 transition-colors hover:bg-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:hidden"
          >
            <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
              <path d="M3 5h14v2H3V5zm0 4h14v2H3V9zm0 4h14v2H3v-2z" />
            </svg>
          </button>

          <Wordmark className="lg:hidden" />

          {/*
            Styled as a field rather than a button, because that is the
            affordance people recognise — and pressing it opens the identical
            palette Cmd/Ctrl+K does, rather than a second search UI.
          */}
          <button
            type="button"
            onClick={openCommandPalette}
            className="ml-auto flex w-full max-w-xs items-center justify-between gap-2 rounded-md border border-hairline bg-surface px-3 py-2 text-left text-sm text-muted transition-colors hover:border-rule hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand lg:ml-0 lg:mr-auto"
          >
            <span className="flex items-center gap-2 truncate">
              <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 fill-current" aria-hidden="true">
                <path d="M13 8a5 5 0 11-10 0 5 5 0 0110 0zm-1.6 4.6L15 16.2l-1.4 1.4-3.6-3.6 1.4-1.4z" />
              </svg>
              <span className="hidden sm:inline">Search customers, orders, products…</span>
              <span className="sm:hidden">Search…</span>
            </span>
            <kbd className="kbd-chip hidden sm:inline-flex">⌘K</kbd>
          </button>

          <div className="flex shrink-0 items-center gap-1">
            {/*
              A real queue, not a decorative bell: it goes to the approvals
              screen, and it only exists for the people who can act on it.
              No count badge, because inventing one would mean a second fetch
              on every screen to render a number nobody asked for.
            */}
            {can.approveChanges && (
              <NavLink
                to="/crm/approvals"
                aria-label="Approvals waiting for you"
                className={({ isActive }) =>
                  `rounded-md p-2 transition-colors hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                    isActive ? 'text-brand-ink' : 'text-ink-2 hover:text-ink'
                  }`
                }
              >
                <svg viewBox="0 0 20 20" className="h-5 w-5 fill-current" aria-hidden="true">
                  <path d="M10 2a5 5 0 00-5 5v2.6l-1.3 2.6a1 1 0 00.9 1.4h10.8a1 1 0 00.9-1.4L15 9.6V7a5 5 0 00-5-5zm0 16a2.5 2.5 0 002.4-1.8H7.6A2.5 2.5 0 0010 18z" />
                </svg>
              </NavLink>
            )}

            <ProfileMenu user={user} initials={initials} onLogout={handleLogout} />
          </div>
        </header>

        <main className="flex-1 overflow-x-hidden px-4 py-7 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1400px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
