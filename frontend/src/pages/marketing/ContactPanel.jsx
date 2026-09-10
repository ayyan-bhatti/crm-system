import { useState } from 'react';
import { contactsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import { useToast } from '../../components/Toast';
import {
  Button,
  Drawer,
  ErrorBanner,
  Field,
  Select,
  Spinner,
  Textarea,
} from '../../components/common';
import DraftMessageCard from '../../components/DraftMessageCard';
import {
  CONTACT_CHANNELS,
  CONTACT_SOURCE_LABELS,
  SEGMENT_LABELS,
  SEGMENT_STYLES,
  channelBlockedReason,
  formatDate,
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
 * BUILT ON THE SHARED `Drawer`, NOT A HAND-ROLLED SLIDE-OVER.
 *
 * The bespoke version was a fixed div, a backdrop button and an `<aside>` —
 * and it had none of the four things an overlay has to get right. Escape did
 * not close it, Tab walked straight out of it into the list underneath, the
 * page behind it kept scrolling, and focus never came back to the row that
 * opened it. `Drawer` does all four in one place (see `useOverlay`), so this
 * screen no longer owns three of them badly.
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
  const logOnly = Boolean(channelStatus && !channelStatus[sendChannel]?.live);

  return (
    <Drawer open onClose={onClose} title={contact?.name || email} className="max-w-xl">
      {loading && (
        <div className="p-5">
          <Spinner full />
        </div>
      )}

      {error && (
        <div className="p-5">
          <ErrorBanner message={error} />
        </div>
      )}

      {contact && (
        <div className="divide-y divide-hairline">
          {/* --- who they are --------------------------------------------- */}
          <section className="p-5">
            <p className="truncate text-sm text-muted">{email}</p>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <div>
                <dt className="label-mono">Source</dt>
                <dd className="mt-1 text-sm text-ink-2">
                  {CONTACT_SOURCE_LABELS[contact.source]}
                </dd>
              </div>
              <div>
                <dt className="label-mono">Phone</dt>
                <dd className="mt-1 text-sm text-ink-2">{contact.phone || '—'}</dd>
              </div>
              <div>
                <dt className="label-mono">Orders</dt>
                <dd className="tabular mt-1 text-sm text-ink-2">{contact.orderCount}</dd>
              </div>
              <div>
                <dt className="label-mono">Lifetime</dt>
                <dd className="tabular mt-1 text-sm font-medium text-ink">
                  {money(contact.totalRevenue)}
                </dd>
              </div>
            </dl>

            {contact.segments.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {contact.segments.map((segment) => (
                  <span
                    key={segment}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${SEGMENT_STYLES[segment]}`}
                  >
                    {SEGMENT_LABELS[segment]}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* --- consent -------------------------------------------------- */}
          <section className="p-5">
            <h3 className="text-sm font-semibold text-ink">Marketing consent</h3>
            <p className="mt-1 text-xs text-muted">
              Only tick a box if this person has actually agreed. Every change here is
              recorded in the audit trail against your name.
            </p>

            <ul className="mt-4 space-y-2">
              {CONTACT_CHANNELS.map((channel) => {
                const state = contact.consent[channel.value];

                return (
                  <li
                    key={channel.value}
                    className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-plane px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            state.optIn ? 'bg-good' : 'bg-rule'
                          }`}
                        />
                        <span className="text-sm font-medium text-ink">{channel.label}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            state.optIn
                              ? 'bg-good-wash text-good-ink'
                              : 'bg-neutral-wash text-neutral-ink'
                          }`}
                        >
                          {state.optIn ? 'Opted in' : 'No opt-in'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        {state.optIn
                          ? `Opted in ${state.optInAt ? formatDate(state.optInAt) : '(date not recorded)'}`
                          : state.optOutAt
                            ? `Opted out ${formatDate(state.optOutAt)}`
                            : 'Never opted in'}
                      </p>
                    </div>

                    {/*
                      Secondary, not primary, on BOTH sides of the toggle. An
                      orange "Opt in" button beside every channel makes the
                      panel look like it is urging staff to tick them — which
                      is precisely the thing the paragraph above warns against.
                      The one accent on this panel belongs to Send.
                    */}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => toggleConsent(channel.value, !state.optIn)}
                      loading={saving === channel.value}
                      loadingLabel="Saving…"
                    >
                      {state.optIn ? 'Opt out' : 'Opt in'}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* --- tags ----------------------------------------------------- */}
          <section className="p-5">
            <h3 className="text-sm font-semibold text-ink">Tags</h3>
            <p className="mt-1 text-xs text-muted">
              Your own labels — &ldquo;VIP&rdquo;, &ldquo;wholesale&rdquo;. The coloured
              segments above are calculated and cannot be set by hand.
            </p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              {contact.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 rounded-full bg-sunken py-1 pl-2.5 pr-1.5 text-xs text-ink-2 ring-1 ring-inset ring-rule/40"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    aria-label={`Remove tag ${tag}`}
                    className="rounded-full p-0.5 text-muted transition-colors hover:bg-critical-wash hover:text-critical-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <svg viewBox="0 0 20 20" className="h-3 w-3 fill-current" aria-hidden="true">
                      <path d="M5.3 4A1 1 0 004 5.3L8.6 10 4 14.7A1 1 0 105.3 16L10 11.4l4.7 4.6a1 1 0 001.3-1.3L11.4 10 16 5.3A1 1 0 0014.7 4L10 8.6z" />
                    </svg>
                  </button>
                </span>
              ))}
              {!contact.tags.length && <span className="text-xs text-muted">No tags yet</span>}
            </div>

            <form onSubmit={addTag} className="mt-3 flex items-end gap-2">
              <div className="flex-1">
                <Field
                  label="Add a tag"
                  placeholder="VIP"
                  value={tagDraft}
                  maxLength={32}
                  onChange={(e) => setTagDraft(e.target.value)}
                />
              </div>
              <Button type="submit" variant="secondary" disabled={!tagDraft.trim()}>
                Add
              </Button>
            </form>
          </section>

          {/* --- draft + send --------------------------------------------- */}
          {contact.customerId && (
            <section className="p-5">
              <DraftMessageCard
                customerId={contact.customerId}
                subtitle="Generates a starting point — copy it into the box below to send it."
              />
            </section>
          )}

          <section className="p-5">
            <h3 className="text-sm font-semibold text-ink">Send a message</h3>

            <div className="mt-4 space-y-4">
              <Field
                label="Channel"
                hint={
                  logOnly && !blocked
                    ? `No live ${sendChannel} provider is configured, so this message will be written to the server log rather than delivered.`
                    : undefined
                }
              >
                <Select
                  value={sendChannel}
                  onChange={(e) => setSendChannel(e.target.value)}
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
                </Select>
              </Field>

              {sendChannel === 'email' && (
                <Field
                  label="Subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={200}
                />
              )}

              <Field label="Message">
                <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
              </Field>

              {blocked && (
                <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-wash px-3 py-2.5 text-sm text-warning-ink">
                  <svg
                    viewBox="0 0 20 20"
                    className="mt-0.5 h-4 w-4 shrink-0 fill-current"
                    aria-hidden="true"
                  >
                    <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
                  </svg>
                  <span>
                    {blocked} Record their consent above before messaging them on this channel.
                  </span>
                </p>
              )}

              {/* The panel's ONE accent. */}
              <Button
                onClick={handleSend}
                loading={sending}
                loadingLabel="Sending…"
                disabled={
                  Boolean(blocked) ||
                  !body.trim() ||
                  (sendChannel === 'email' && !subject.trim())
                }
              >
                Send
              </Button>
            </div>
          </section>
        </div>
      )}
    </Drawer>
  );
}
