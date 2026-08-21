import usePermissions, { ACTIONS } from '../hooks/usePermissions';

/**
 * Render children only if the user may perform `do`.
 *
 *   <Can do="manageProducts">
 *     <Link to="/products/new">New product</Link>
 *   </Can>
 *
 * This is the JSX face of `usePermissions`; the hook is the source of truth and
 * this is sugar for the common case. It replaced `<RoleGate roles={[...]}>`,
 * which took a ROLE LIST — so every call site restated the policy, and changing
 * who may do something meant finding and editing all of them consistently.
 * Naming the action instead means the policy lives in exactly one table.
 *
 * WHEN TO USE `fallback` INSTEAD OF HIDING.
 *
 * Hiding is the default and is usually right: an action someone cannot take is
 * noise, and offering it teaches them to expect errors. But hiding is wrong
 * when the absence is itself confusing — a column that vanishes, a toolbar that
 * looks broken. In those cases pass a `fallback` that explains, rather than
 * leaving a hole the user has to interpret.
 *
 * NOT A SECURITY BOUNDARY. The API enforces all of this independently; see the
 * note at the top of hooks/usePermissions.js.
 */
export default function Can({ do: action, fallback = null, children }) {
  const { can } = usePermissions();

  /*
   * A misspelled action would otherwise be silently falsy, which fails in the
   * quietest and worst possible way: the control disappears for everyone,
   * including the admin, and looks exactly like a deliberate permission rule.
   * Better to be loud in development and let it through — the API is still
   * enforcing the real rule, so a visible extra button is a far smaller problem
   * than an invisible missing one.
   */
  if (!Object.prototype.hasOwnProperty.call(can, action)) {
    if (import.meta.env.DEV) {
      throw new Error(
        `<Can do="${action}"> is not a known action. Expected one of: ${ACTIONS.join(', ')}`
      );
    }
    return children;
  }

  return can[action] ? children : fallback;
}
