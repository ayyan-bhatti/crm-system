import { useState } from 'react';
import { usersApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { Button, Card, Select, Table } from '../../components/common';
import { REQUESTABLE_ROLES } from '../../constants';
import { formatDate, humanize, td, th } from '../../ui';

/**
 * People waiting for an account.
 *
 * WHY THIS SITS ABOVE THE USER LIST RATHER THAN BEHIND A TAB.
 *
 * It is a work queue, and a queue nobody looks at is a queue that does not
 * work. Somebody who signed up is blocked until an administrator acts, and the
 * cost of missing it is a colleague who cannot do their job while believing
 * they have already done everything asked of them. A tab would hide the count
 * behind a click; this puts it in the way, and disappears entirely when there
 * is nothing waiting.
 *
 * THE REQUESTED ROLE IS SHOWN, AND IS NOT THE DECISION.
 *
 * The dropdown starts on whatever the person asked for, because that is
 * usually right and pre-selecting it saves the common case. It is editable
 * because a request is a request — someone asking to be a manager is telling
 * you what they believe their job is, which is useful and not binding.
 * Approving with a different role in one action matters: approve-then-demote
 * would leave a window, however brief, where they hold access nobody agreed to.
 */
export default function PendingApprovals({ onDecided }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, loading, error, reload } = useFetch(() => usersApi.pending(), []);

  // The row currently being acted on, so both its buttons can be disabled
  // without freezing the whole queue.
  const [busyId, setBusyId] = useState(null);

  /** Role to grant, per request. Defaults to what was asked for. */
  const [roles, setRoles] = useState({});

  async function decide(user, approved) {
    setBusyId(user._id);

    try {
      if (approved) {
        await usersApi.approve(user._id, roles[user._id] || user.requestedRole);
        toast.success(`${user.name} approved and can now sign in.`);
      } else {
        await usersApi.reject(user._id);
        toast.success(`${user.name}'s request was rejected.`);
      }

      reload();
      // The main user list changes too — an approved person appears in it, so
      // leaving it stale would show a queue that emptied into nowhere.
      onDecided?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not record that decision'));
    } finally {
      setBusyId(null);
    }
  }

  // A failure here is silent: this is an extra panel above a working screen,
  // and an error banner about a queue would obscure the user list underneath.
  if (loading || error || !data?.length) return null;

  return (
    /*
      An attention panel, marked by the accent on its edge rather than by a
      coloured fill. The queue is urgent, not alarming — nothing has gone
      wrong, somebody is simply waiting — so it borrows the brand's "this is
      the thing to deal with" meaning instead of a status colour that would
      say "problem".
    */
    <Card className="mb-4 overflow-hidden border-brand/40">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline bg-brand-wash px-4 py-3.5">
        <div>
          <p className="label-mono text-brand-ink">Waiting on you</p>
          <h2 className="mt-1 flex items-center gap-2 text-base font-semibold text-ink">
            Pending approvals
            <span className="rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-on-brand">
              {data.length}
            </span>
          </h2>
          <p className="mt-1 max-w-xl text-sm text-ink-2">
            These people have signed up and chosen a password. They cannot sign in until you
            approve them.
          </p>
        </div>
      </div>

      <Table caption="Account requests waiting for a decision">
        <thead className="bg-sunken">
          <tr className="border-b border-hairline">
            <th className={th}>Name</th>
            <th className={th}>Email</th>
            <th className={th}>Requested</th>
            <th className={th}>Grant as</th>
            <th className={th}>Waiting since</th>
            <th className={`${th} text-right`}>Decision</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {data.map((user) => {
            const busy = busyId === user._id;

            return (
              <tr key={user._id} className="transition-colors hover:bg-sunken/60">
                <td className={td}>
                  <div className="flex items-center gap-3">
                    <Avatar name={user.name} />
                    <span className="font-medium text-ink">{user.name}</span>
                  </div>
                </td>
                <td className={td}>{user.email}</td>
                <td className={td}>{humanize(user.requestedRole)}</td>
                <td className={td}>
                  <Select
                    className="w-36"
                    aria-label={`Role to grant ${user.name}`}
                    value={roles[user._id] || user.requestedRole}
                    onChange={(e) => setRoles({ ...roles, [user._id]: e.target.value })}
                  >
                    {REQUESTABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {humanize(role)}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className={`${td} whitespace-nowrap tabular`}>{formatDate(user.createdAt)}</td>
                <td className={`${td} text-right`}>
                  {/*
                    Both decisions stay visible rather than hiding behind a "⋯"
                    menu. This is the one table in the CRM whose whole reason to
                    exist is a decision, and a decision one click away is a
                    decision that waits.
                  */}
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="bare"
                      className="border border-good/40 bg-good-wash text-good-ink hover:bg-good-wash/70"
                      loading={busy}
                      loadingLabel="Saving…"
                      onClick={() => decide(user, true)}
                    >
                      Approve
                    </Button>

                    {/*
                      Confirmed, because rejecting is not reversible by the
                      applicant: they cannot re-apply, since the address stays
                      reserved. An admin can still change their mind, but the
                      person on the other end cannot.
                    */}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="hover:text-critical-ink"
                      disabled={busy}
                      onClick={async () => {
                        const ok = await confirm(
                          `Reject ${user.name}'s request? They will not be able to sign in ` +
                            'or apply again with this email address.',
                          { confirmLabel: 'Reject', tone: 'danger' }
                        );
                        if (ok) decide(user, false);
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}

function initialsOf(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Initials disc; hidden from screen readers since the name follows it. */
function Avatar({ name }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-wash text-[11px] font-semibold tracking-wide text-brand-ink"
    >
      {initialsOf(name)}
    </span>
  );
}
