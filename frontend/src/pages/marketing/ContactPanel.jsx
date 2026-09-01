import { useState } from 'react';
import { contactsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import { ErrorBanner, Spinner } from '../../components/common';
import DraftMessageCard from '../../components/DraftMessageCard';
import {
  CONTACT_CHANNELS,
  CONTACT_SOURCE_LABELS,
  SEGMENT_LABELS,
  SEGMENT_STYLES,
  btnPrimary,
  btnSecondary,
  channelBlockedReason,
  formatDate,
  input,
  money,
} from '../../ui';

/**
 * One contact, in a side panel: their consent, their tags, and a way to
 * message them.
 *
 * WHY A PANEL RATHER THAN A ROUTE
 *
 * Working a contact list means opening one, acting, and going back to the
 * list — twenty times. A route makes each of those a navigation that loses the
 * filters and the scroll position, and the filters are how this screen is
 * navigated at all. The panel keeps the list underneath, which is the shape
 * the task actually has.
 *
 * WHAT THE CONSENT TOGGLES ARE AND ARE NOT
 *
 * They record a consent the customer gave A MEMBER OF STAFF — on the phone, in
 * person, on a paper form. They are not a way to add someone to a list. That
 * distinction cannot be enforced by software, so it is stated on the screen,
 * and every change is written to the audit trail with the name of whoever made
 * it. An opt-in flipped on by staff with no conversation behind it is exactly
 * the entry a complaint gets checked against.
 */
export default function ContactPanel({ email, onClose, onChanged, channelStatus }) {
  const toast = useToast();

  const { data: contact, loading, error, reload } = useFetch(
    () => contactsApi.get(email),
    [email]
  );

  const [saving, setSaving] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [sendChannel, setSendChannel] = useState('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  async function toggleConsent(channel, next) {
    setSaving(channel);

    try {
      await contactsApi.setConsent(email, { [`${channel}OptIn`]: next });
      // Phrased to sidestep "a" vs "an" — the channel name is a variable, and
      // "Recorded a Email opt-in" is the sentence that combination produces.
      const channelLabel = CONTACT_CHANNELS.find((c) => c.value === channel)?.label || channel;

      toast.success(
        next
          ? `Recorded ${channelLabel} opt-in for ${contact.name || email}`
          : `Opted ${contact.name || email} out of ${channelLabel}`
      );
      reload();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not update consent'));
    } finally {
      setSaving('');
    }
  }

  async function addTag(event) {
    event.preventDefault();
    const tag = tagDraft.trim();
    if (!tag) return;

    try {
      await contactsApi.setTags(email, [...new Set([...contact.tags, tag])]);
      setTagDraft('');
      reload();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not add that tag'));
    }
  }

  async function removeTag(tag) {
    try {
      await contactsApi.setTags(
        email,
        contact.tags.filter((t) => t !== tag)
      );
      reload();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err, 'Could not remove that tag'));
    }
  }

  async function handleSend() {
    setSending(true);

    try {
      const result = await contactsApi.message(email, {
        channel: sendChannel,
        subject,
        body,
      });

      /*
       * A BLOCKED SEND RESOLVES SUCCESSFULLY, so the status has to be read.
       *
       * The API answers 200 with `status: 'skipped_no_consent'` when the
       * contact has not opted in — the request was fine, the answer is no.
       * Treating any resolved promise as a delivery would show "Message sent"
       * for a message that was refused, which is the single most dangerous
       * lie this screen could tell: somebody would believe they had contacted
       * a customer and stop chasing.
       */
      if (result.status === 'sent') {
        toast.success(`Message sent to ${contact.name || email}`);
        setBody('');
        setSubject('');
      } else if (result.status === 'skipped_no_consent') {
        toast.error(`Not sent — ${contact.name || 'this contact'} has not opted in to ${sendChannel}.`);
      } else {
        toast.error(`Not sent — ${result.reason || 'the message could not be delivered'}`);
      }
    } catch (err) {
      toast.error(errorMessage(err, 'Could not send the message'));
    } finally {
      setSending(false);
    }
  }

  const blocked = contact ? channelBlockedReason(contact, sendChannel) : '';

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      {/*
        The click-away backdrop is a real <button>, not a div with an onClick.

        A div carrying a click handler is unreachable by keyboard and invisible
        to assistive technology, so the panel would be dismissable by mouse and
        by nothing else. As a button it is focusable, responds to Enter and
        Space for free, and needs no `role`/`tabIndex`/`onKeyDown` scaffolding
        to imitate what the element already does.
      */}
      <button
        type="button"
        className="absolute inset-0 h-full w-full cursor-default bg-black/20"
        onClick={onClose}
        aria-label="Close contact details"
      />

      <aside
        className="relative flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-hairline bg-surface shadow-xl"
        role="dialog"
        aria-label={`Contact: ${contact?.name || email}`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-hairline p-5">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">
              {contact?.name || email}
            </h2>
            <p className="truncate text-sm text-muted">{email}</p>
          </div>
          <button type="button" className={btnSecondary} onClick={onClose}>
            Close
          </button>
        </header>

        {loading && (
          <div className="p-5">
            <Spinner />
          </div>
        )}

        <ErrorBanner message={error} />

        {contact && (
          <div className="space-y-6 p-5">
            {/* --- who they are ------------------------------------------- */}
            <section>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">Source</dt>
                  <dd className="text-ink-2">{CONTACT_SOURCE_LABELS[contact.source]}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Phone</dt>
                  <dd className="text-ink-2">{contact.phone || '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Orders</dt>
                  <dd className="text-ink-2">{contact.orderCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Lifetime value</dt>
                  <dd className="text-ink-2">{money(contact.totalRevenue)}</dd>
                </div>
              </dl>

              {contact.segments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {contact.segments.map((segment) => (
                    <span
                      key={segment}
                      className={`rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${SEGMENT_STYLES[segment]}`}
                    >
                      {SEGMENT_LABELS[segment]}
                    </span>
                  ))}
                </div>
              )}
            </section>

            {/* --- consent ------------------------------------------------ */}
            <section>
              <h3 className="text-sm font-semibold text-ink">Marketing consent</h3>
              <p className="mt-1 text-xs text-muted">
                Only tick a box if this person has actually agreed. Every change here is
                recorded in the audit trail against your name.
              </p>

              <ul className="mt-3 space-y-2">
                {CONTACT_CHANNELS.map((channel) => {
                  const state = contact.consent[channel.value];

                  return (
                    <li
                      key={channel.value}
                      className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-plane px-3 py-2"
                    >
                      <div className="min-w-0">
                        <span className="text-sm text-ink">{channel.label}</span>
                        <p className="text-xs text-muted">
                          {state.optIn
                            ? `Opted in ${state.optInAt ? formatDate(state.optInAt) : '(date not recorded)'}`
                            : state.optOutAt
                              ? `Opted out ${formatDate(state.optOutAt)}`
                              : 'Never opted in'}
                        </p>
                      </div>

                      <button
                        type="button"
                        className={state.optIn ? btnSecondary : btnPrimary}
                        onClick={() => toggleConsent(channel.value, !state.optIn)}
                        disabled={saving === channel.value}
                      >
                        {saving === channel.value ? (
                          <Spinner />
                        ) : state.optIn ? (
                          'Opt out'
                        ) : (
                          'Opt in'
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* --- tags --------------------------------------------------- */}
            <section>
              <h3 className="text-sm font-semibold text-ink">Tags</h3>
              <p className="mt-1 text-xs text-muted">
                Your own labels — &ldquo;VIP&rdquo;, &ldquo;wholesale&rdquo;. The coloured
                segments above are calculated and cannot be set by hand.
              </p>

              <div className="mt-2 flex flex-wrap gap-1">
                {contact.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-ink-2 ring-1 ring-inset ring-neutral-400/20"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      aria-label={`Remove tag ${tag}`}
                      className="text-muted hover:text-critical"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {!contact.tags.length && <span className="text-xs text-muted">No tags yet</span>}
              </div>

              <form onSubmit={addTag} className="mt-3 flex gap-2">
                <input
                  className={input}
                  placeholder="Add a tag"
                  value={tagDraft}
                  maxLength={32}
                  onChange={(e) => setTagDraft(e.target.value)}
                  aria-label="New tag"
                />
                <button type="submit" className={btnSecondary} disabled={!tagDraft.trim()}>
                  Add
                </button>
              </form>
            </section>

            {/* --- draft + send ------------------------------------------- */}
            {contact.customerId && (
              <DraftMessageCard
                customerId={contact.customerId}
                subtitle="Generates a starting point — copy it into the box below to send it."
              />
            )}

            <section>
              <h3 className="text-sm font-semibold text-ink">Send a message</h3>

              <div className="mt-3 space-y-3">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-ink-2">Channel</span>
                  <select
                    className={input}
                    value={sendChannel}
                    onChange={(e) => setSendChannel(e.target.value)}
                    aria-label="Channel"
                  >
                    {CONTACT_CHANNELS.map((channel) => {
                      const reason = channelBlockedReason(contact, channel.value);

                      return (
                        /*
                          A channel the contact has not agreed to is DISABLED
                          rather than hidden, and the option says why. Hiding
                          it would leave someone wondering whether the shop can
                          send SMS at all; disabling it with a reason answers
                          the real question, which is "how do I reach this
                          person" — and the answer is "ask them first".
                        */
                        <option key={channel.value} value={channel.value} disabled={Boolean(reason)}>
                          {channel.label}
                          {reason ? ' — no opt-in' : ''}
                          {channelStatus && !channelStatus[channel.value]?.live && !reason
                            ? ' (log only)'
                            : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>

                {sendChannel === 'email' && (
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium text-ink-2">Subject</span>
                    <input
                      className={input}
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      maxLength={200}
                    />
                  </label>
                )}

                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-ink-2">Message</span>
                  <textarea
                    className={`${input} min-h-32`}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </label>

                {blocked && (
                  <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    {blocked} Record their consent above before messaging them on this channel.
                  </p>
                )}

                {channelStatus && !channelStatus[sendChannel]?.live && !blocked && (
                  <p className="text-xs text-muted">
                    No live {sendChannel} provider is configured, so this message will be written
                    to the server log rather than delivered.
                  </p>
                )}

                <button
                  type="button"
                  className={btnPrimary}
                  onClick={handleSend}
                  disabled={
                    sending ||
                    Boolean(blocked) ||
                    !body.trim() ||
                    (sendChannel === 'email' && !subject.trim())
                  }
                >
                  {sending ? <Spinner /> : 'Send'}
                </button>
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
