/**
 * Telling the other tabs of this browser that the session has changed.
 *
 * WHY THIS IS NEEDED AT ALL.
 *
 * The session lives in httpOnly cookies, and a cookie is keyed on
 * (name, domain, path). There is no tab dimension in that key and there cannot
 * be one — so every tab of this origin shares ONE session, and signing in
 * anywhere replaces it everywhere.
 *
 * That is browser behaviour rather than a bug, and it is not fixable from here.
 * What IS fixable is the consequence: a tab that signed in earlier keeps its
 * own React state, so it goes on rendering the previous user's name, role and
 * navigation while its requests are quietly authenticated as somebody else. It
 * never finds out, because a replaced session does not produce a 401 — the new
 * cookie is perfectly valid, so every request comes back 200 with the NEW
 * user's data behind the OLD user's interface.
 *
 * This channel is how the other tabs hear about it immediately.
 *
 * NOT A SECURITY BOUNDARY, AND WORTH SAYING WHY.
 *
 * Nobody gains access they did not have: the backend authenticates the cookie
 * on every request and is the only authority on what may be read. The person at
 * the keyboard is also, necessarily, whoever just typed the newer credentials.
 * The problem is honesty rather than authorisation — an interface claiming to
 * be one person while acting as another is wrong even when nothing is leaked.
 */

/** One name for the whole app, so every tab joins the same conversation. */
const CHANNEL = 'simplecrm-session';

/**
 * BroadcastChannel is not everywhere.
 *
 * Absent in some older Safari builds, and absent in any non-browser context
 * this module might be imported into — a server render, a unit test in a bare
 * jsdom. Every function here degrades to doing nothing rather than throwing,
 * because a browser without it must still be able to sign in; it simply falls
 * back to the focus check, which is slower and always available.
 */
function open() {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
}

/**
 * ONE long-lived channel for sending, created on first use.
 *
 * The first version opened a channel, posted, and closed it immediately. That
 * looked tidy and was a race: closing a channel in the same tick as a
 * `postMessage` can drop the message before it is delivered, and the tests
 * caught it — they failed about two runs in five, in whichever direction the
 * timing happened to fall. A channel that outlives the message cannot lose it.
 *
 * Never closed. It is one object for the lifetime of the tab, and the tab
 * closing is what disposes of it.
 */
let sender;

function sendChannel() {
  if (sender === undefined) sender = open();
  return sender;
}

/**
 * Announce which user this browser now belongs to.
 *
 * `userId` is null on sign-out. Deliberately only the id: the channel is
 * readable by any script on this origin, and there is nothing to gain from
 * putting a name or a role on it when the receiving tab is going to ask the
 * server who it is anyway.
 *
 * @param {string|null} userId
 */
export function announceSession(userId) {
  const channel = sendChannel();
  if (!channel) return;

  try {
    channel.postMessage({ type: 'session', userId: userId ? String(userId) : null });
  } catch {
    // A failed announcement costs the other tabs a few seconds until they are
    // focused. Not worth surfacing.
  }
}

/**
 * Listen for another tab announcing a session change.
 *
 * A SEPARATE channel object from the sender, deliberately. A BroadcastChannel
 * does not deliver to itself, so sharing one would mean a tab never hearing its
 * own announcements — which is correct in a real browser (the announcing tab
 * already knows) and makes the behaviour untestable, because a test drives both
 * ends from one realm.
 *
 * @param {(userId: string|null) => void} handler
 * @returns {() => void} unsubscribe
 */
export function onSessionAnnounced(handler) {
  const channel = open();
  if (!channel) return () => {};

  const listener = (event) => {
    if (event?.data?.type === 'session') handler(event.data.userId ?? null);
  };

  channel.addEventListener('message', listener);

  return () => {
    channel.removeEventListener('message', listener);
    channel.close();
  };
}
