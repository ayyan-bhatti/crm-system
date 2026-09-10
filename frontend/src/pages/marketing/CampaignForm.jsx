import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { campaignsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import {
  Breadcrumb,
  Button,
  Card,
  ErrorBanner,
  Field,
  PageHeader,
  Select,
  Spinner,
  Textarea,
  useFormValidation,
  validators,
} from '../../components/common';
import { CONTACT_CHANNELS, CONTACT_SOURCE_LABELS } from '../../ui';

/**
 * The campaign builder: goal, audience, channel, copy.
 *
 * THE ORDER OF THE FORM IS THE ARGUMENT IT MAKES.
 *
 * Audience first, then the channel and the preview, then the words. Writing
 * the copy before knowing who it is for is how a campaign ends up addressed to
 * nobody in particular — and, more practically, the AI is given the audience as
 * context, so it cannot draft anything sensible until that is settled.
 *
 * THE PREVIEW IS NOT A NICETY.
 *
 * It reports two numbers that differ, often by a lot: how many contacts the
 * audience matches, and how many of those have actually opted in to the chosen
 * channel. Discovering that gap AFTER pressing send makes the skipped count
 * read as a bug in the sender rather than as a list that needs consent
 * collecting. It also says, before anything is written, whether this send will
 * need an administrator — a manager finding that out at the moment they
 * expected it to go is the surprise an approval gate should never spring.
 *
 * NOTHING SENDS FROM THIS PAGE. Saving creates a DRAFT. Sending is a separate,
 * deliberate act on the campaign's own page, so that no single click can both
 * invent a campaign and put it in front of four thousand people. That is what
 * the last section of this form is: the schedule for this campaign is "when a
 * human presses send", and it is written down rather than left implied.
 *
 * ALSO THE EDIT FORM, when reached via `/crm/campaigns/:id/edit`. Editing and
 * creating ask for the same six fields, so this is one component rather than
 * two that would drift apart the first time a field changed — the only real
 * difference is which `campaignsApi` call the save button makes, and that a
 * campaign that has already sent (or is queued for approval) cannot be
 * edited at all, mirroring the backend's own rule in `updateCampaign`.
 */

/**
 * Validation rules, at module scope so the object identity is stable across
 * renders — `useFormValidation` memoises on it.
 *
 * They are checks on what the SERVER will accept, not extra opinions of the
 * form's own: the same three conditions the save button has always tested,
 * now able to say which one is failing instead of just going grey.
 */
const RULES = {
  name: validators.required('Campaign name'),

  subject: (value, values) =>
    values.channel === 'email' && !String(value || '').trim()
      ? 'An email needs a subject line.'
      : null,

  body: (value) =>
    !String(value || '').trim() ? 'Write the message, or draft it with AI.' : null,
};

export default function CampaignForm() {
  const navigate = useNavigate();
  const toast = useToast();
  const { isAdmin } = usePermissions();
  const { id } = useParams();
  const editing = Boolean(id);

  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [channel, setChannel] = useState('email');
  const [audience, setAudience] = useState({ preset: 'mine', source: '', segment: '', tag: '' });

  const [content, setContent] = useState({
    subject: '',
    body: '',
    sms: '',
    whatsapp: '',
    socialPost: '',
    mode: 'manual',
  });

  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(!editing);
  // Only meaningful in edit mode — a campaign that has already sent, or is
  // queued for approval, cannot be edited; the backend refuses the PATCH
  // outright, and the form says so up front rather than letting someone
  // fill in changes that will be rejected on save.
  const [campaignStatus, setCampaignStatus] = useState(null);

  const { visibleErrors, markTouched, validate } = useFormValidation(RULES);

  // The audience and channel option lists come from the server — same
  // reasoning as the storefront config: a hard-coded segment list disagrees
  // with the server the day one is added.
  const { data: options } = useFetch(() => campaignsApi.list(), []);
  const meta = options?.options;

  /*
   * Loading the existing campaign, only in edit mode. Deliberately its own
   * effect rather than folded into `useFetch` above: this one has to POPULATE
   * five pieces of local state once, the moment the data arrives, and a
   * plain `useFetch` result would re-run that population on every unrelated
   * re-render if written as a render-time derivation instead.
   */
  useEffect(() => {
    if (!editing) return;

    let cancelled = false;

    campaignsApi
      .get(id)
      .then(({ campaign }) => {
        if (cancelled) return;
        setName(campaign.name);
        setGoal(campaign.goal || '');
        setChannel(campaign.channel);
        setAudience(campaign.audience);
        setContent(campaign.content);
        setCampaignStatus(campaign.status);
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errorMessage(err, 'Could not load this campaign'));
          setLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [editing, id]);

  const audienceKey = JSON.stringify(audience);

  /*
   * Re-previewed whenever the audience or channel changes, debounced by the
   * effect's own dependency list rather than a timer — these are dropdowns,
   * not a text box, so a change is a deliberate act and there is no keystroke
   * storm to smooth out.
   */
  useEffect(() => {
    let cancelled = false;
    setPreviewing(true);

    campaignsApi
      .preview(audience)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err, 'Could not preview this audience'));
      })
      .finally(() => {
        if (!cancelled) setPreviewing(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey]);

  function setAudienceField(key, value) {
    setAudience((current) => ({ ...current, [key]: value }));
  }

  async function handleDraft() {
    setDrafting(true);
    setError('');

    try {
      const drafted = await campaignsApi.draft({ goal, channel, audience });
      setContent(drafted);

      toast.success(
        drafted.mode === 'ai'
          ? 'Draft written — read it before you send it.'
          : 'AI is unavailable, so a template was used. Edit it before sending.'
      );
    } catch (err) {
      setError(errorMessage(err, 'Could not draft the copy'));
    } finally {
      setDrafting(false);
    }
  }

  const reachable = preview?.reachable?.[channel] ?? 0;
  const bodyForChannel =
    channel === 'email' ? content.body : channel === 'sms' ? content.sms : content.whatsapp;

  /*
   * What the validator sees. `body` is the copy for the CHOSEN channel, with
   * the email body as the fallback for SMS and WhatsApp — exactly the rule the
   * save button has always applied, so a campaign drafted once and switched to
   * another channel is still saveable.
   */
  const values = {
    name,
    channel,
    subject: content.subject,
    body: channel === 'email' ? content.body : bodyForChannel || content.body,
  };
  const errors = visibleErrors(values);

  async function handleSave() {
    // Nothing is sent to the API until the same three conditions the button
    // used to test silently are satisfied.
    if (!validate(values)) return;

    setSaving(true);
    setError('');

    try {
      if (editing) {
        await campaignsApi.update(id, { name, goal, channel, audience, content });
        toast.success('Changes saved.');
        navigate(`/crm/campaigns/${id}`);
      } else {
        const campaign = await campaignsApi.create({ name, goal, channel, audience, content });
        toast.success('Saved as a draft. Review it, then send from the campaign page.');
        navigate(`/crm/campaigns/${campaign._id}`);
      }
    } catch (err) {
      setError(errorMessage(err, editing ? 'Could not save these changes' : 'Could not save the campaign'));
      setSaving(false);
    }
  }

  if (!loaded) return <Spinner full />;

  // The backend refuses this PATCH outright once a campaign has left draft —
  // see updateCampaign's guard. Said here too, before anyone fills anything
  // in, rather than as a save error after the fact.
  if (editing && campaignStatus && campaignStatus !== 'draft') {
    return (
      <div className="max-w-3xl">
        <Breadcrumb
          className="mb-4"
          items={[
            { label: 'Campaigns', to: '/crm/campaigns' },
            { label: 'Edit' },
          ]}
        />
        <PageHeader eyebrow="Marketing" title="Edit campaign" />
        <ErrorBanner message="This campaign has already sent, or is waiting on approval, so it can no longer be edited. A sent campaign is a record of something that happened." />
      </div>
    );
  }

  const channelLabel =
    channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : 'WhatsApp';
  const selectedChannelLive = !meta?.channelStatus || meta.channelStatus[channel]?.live;

  return (
    <div className="max-w-3xl">
      <Breadcrumb
        className="mb-4"
        items={[
          { label: 'Campaigns', to: '/crm/campaigns' },
          { label: editing ? 'Edit' : 'New campaign' },
        ]}
      />

      <PageHeader
        eyebrow="Marketing"
        title={editing ? 'Edit campaign' : 'New campaign'}
        subtitle={
          editing
            ? 'Still a draft until it is sent — changes here are safe.'
            : 'Saving creates a draft. Nothing is sent until you send it from the campaign page.'
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      <div className="space-y-5">
        {/* --- 1. audience ------------------------------------------------- */}
        <FormSection
          step={1}
          title="Audience"
          hint="Who this is for, and what it is trying to do. The goal is also what the AI is given, and what an administrator reads if the send needs approving."
        >
          <Field
            label="Campaign name"
            required
            value={name}
            error={errors.name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => markTouched('name')}
            placeholder="March win-back"
            maxLength={120}
          />

          <Field label="What is this campaign for?">
            <Textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Win back customers who have not ordered in a while"
              maxLength={500}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Send to">
              <Select
                value={audience.preset}
                onChange={(e) => setAudienceField('preset', e.target.value)}
              >
                {(meta?.audiences || []).map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Narrow by source (optional)">
              <Select
                value={audience.source}
                onChange={(e) => setAudienceField('source', e.target.value)}
              >
                <option value="">Any source</option>
                {(meta?.sources || []).map((source) => (
                  <option key={source} value={source}>
                    {CONTACT_SOURCE_LABELS[source] || source}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Narrow by tag (optional)"
              value={audience.tag}
              onChange={(e) => setAudienceField('tag', e.target.value)}
              placeholder="VIP"
              maxLength={32}
            />
          </div>
        </FormSection>

        {/* --- 2. channel, and who that actually reaches -------------------- */}
        <FormSection
          step={2}
          title="Channel"
          hint="The audience is who matches. Reach is who has opted in to this channel — and the gap between the two is the number worth knowing before you write anything."
        >
          <Field label="Send over">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              {CONTACT_CHANNELS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                  {/*
                    The per-option marker, unchanged. A deployment with no
                    configured provider for a channel still ACCEPTS the
                    campaign — every message is written to the server log
                    instead of being delivered — so the state has to be
                    readable in the list itself, at the moment of choosing.
                  */}
                  {meta?.channelStatus && !meta.channelStatus[item.value]?.live
                    ? ' (log only)'
                    : ''}
                </option>
              ))}
            </Select>
          </Field>

          {/*
            THE AVAILABILITY WARNING IS NOT DECORATION, so it is a banner and
            not the small grey hint under the field.

            "Log only" is a legitimate state — it is how this runs without paid
            SMS credentials — and it is also the single most misleading one if
            it is not said out loud: the campaign will report itself as sent
            having reached nobody at all. Somebody choosing this channel needs
            to read that before they write the copy, not after they wonder why
            no one replied.
          */}
          {!selectedChannelLive && (
            <Notice tone="warning">
              No live {channelLabel} provider is configured on this deployment. The campaign will
              be recorded and written to the server log rather than actually delivered.
            </Notice>
          )}

          {previewing && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner />
              Working out who this reaches…
            </div>
          )}

          {preview && !previewing && (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Match this audience" value={preview.total} />
                <Stat
                  label={`Opted in to ${channelLabel}`}
                  value={reachable}
                  tone={reachable === 0 ? 'warn' : 'good'}
                />
                <Stat
                  label="Will not be messaged"
                  value={preview.total - reachable}
                  tone={preview.total - reachable > 0 ? 'warn' : 'plain'}
                />
              </div>

              {preview.total > 0 && reachable === 0 && (
                <Notice tone="warning">
                  Nobody in this audience has opted in to {channelLabel}, so this campaign would
                  reach no one. Try a different channel, or collect consent first.
                </Notice>
              )}

              {/*
                The approval warning, shown BEFORE anything is written. A manager
                who only discovers this at the moment they press send reasonably
                concludes the button is broken.
              */}
              {preview.needsApproval && !isAdmin && (
                <Notice tone="info">
                  {preview.outsideScope} of these contacts are outside your own, so sending this
                  will go to an administrator for approval rather than out straight away.
                </Notice>
              )}
            </>
          )}
        </FormSection>

        {/* --- 3. the words ------------------------------------------------- */}
        <FormSection
          step={3}
          title="Content"
          hint="Read whatever the AI writes before it goes anywhere. Nobody else has checked it."
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={handleDraft}
              loading={drafting}
              loadingLabel="Drafting…"
              disabled={!goal.trim()}
            >
              Draft with AI
            </Button>
          }
        >
          {content.mode !== 'manual' && (
            <p className="rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">
              {content.mode === 'ai'
                ? 'Written by the AI from your goal. Read it before sending — it has not been checked by anyone.'
                : 'The AI was unavailable, so this is a plain template. Edit it before sending.'}
            </p>
          )}

          {channel === 'email' && (
            <Field
              label="Subject"
              required
              value={content.subject}
              error={errors.subject}
              onChange={(e) => setContent({ ...content, subject: e.target.value })}
              onBlur={() => markTouched('subject')}
              maxLength={150}
            />
          )}

          <Field
            label={channel === 'email' ? 'Email body' : `${channelLabel} text`}
            required
            error={errors.body}
            hint={
              channel === 'email'
                ? 'Write {{name}} where the recipient’s first name should go. An unsubscribe link is added to every marketing email automatically.'
                : 'Write {{name}} where the recipient’s first name should go.'
            }
          >
            <Textarea
              rows={9}
              value={channel === 'email' ? content.body : bodyForChannel}
              onBlur={() => markTouched('body')}
              onChange={(e) =>
                setContent({
                  ...content,
                  [channel === 'email' ? 'body' : channel]: e.target.value,
                })
              }
            />
          </Field>

          {/*
            The other channels' copy is kept and shown even though only one is
            being sent. The AI writes all four from one idea, and a staff member
            who asked for them will want to reuse them — throwing away three
            quarters of a generation because a dropdown says "email" would be
            quietly wasteful.
          */}
          {content.socialPost && (
            <div className="rounded-md border border-hairline bg-plane p-4">
              <p className="label-mono">Social post — copy and paste</p>
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2">{content.socialPost}</p>
              <p className="mt-2 text-xs text-muted">
                This app does not post to any social platform. This is copy for you to post from
                wherever you normally do.
              </p>
            </div>
          )}
        </FormSection>

        {/* --- 4. when it goes ---------------------------------------------- */}
        <FormSection
          step={4}
          title="Schedule"
          hint="There is no timer, and that is deliberate."
        >
          <p className="text-sm text-ink-2">
            Saving stores this as a <strong className="font-semibold text-ink">draft</strong>.
            It goes out only when somebody opens the campaign and presses send — so no single
            click can both invent a campaign and put it in front of your whole list.
            {preview?.needsApproval && !isAdmin
              ? ' This one will then wait on an administrator before it leaves.'
              : ''}
          </p>

          <div className="flex flex-wrap gap-2 border-t border-hairline pt-4">
            <Button onClick={handleSave} loading={saving} loadingLabel="Saving…">
              {editing ? 'Save changes' : 'Save as draft'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => navigate(editing ? `/crm/campaigns/${id}` : '/crm/campaigns')}
            >
              Cancel
            </Button>
          </div>
        </FormSection>
      </div>
    </div>
  );
}

/**
 * One numbered step of the form.
 *
 * The number is in the markup rather than in the heading text so it is
 * decorative to a screen reader — "1. Audience" read aloud on every heading is
 * noise, but on screen the numerals are what make four cards read as one
 * sequence rather than four unrelated panels.
 */
function FormSection({ step, title, hint, action, children }) {
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline pb-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="tabular mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-wash text-xs font-semibold text-brand-ink"
          >
            {step}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
          </div>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>

      <div className="space-y-4 pt-5">{children}</div>
    </Card>
  );
}

const NOTICE_TONES = {
  warning: 'border-warning/30 bg-warning-wash text-warning-ink',
  info: 'border-info/25 bg-info-wash text-info-ink',
};

/** An inline explanation attached to a state of the form, not to a failure. */
function Notice({ tone = 'info', children }) {
  return (
    <p className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${NOTICE_TONES[tone]}`}>
      <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 fill-current" aria-hidden="true">
        <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 9a1.1 1.1 0 110-2.2 1.1 1.1 0 010 2.2z" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

const TONES = {
  good: 'text-good-ink',
  warn: 'text-warning-ink',
  plain: 'text-ink',
};

/**
 * `role="group"` with a combined `aria-label` rather than two bare
 * paragraphs, so the label and the number are read as one unit — without it,
 * a screen reader landing on the number hears only "2" with nothing to say
 * what it counts.
 */
function Stat({ label, value, tone = 'plain' }) {
  return (
    <div
      role="group"
      aria-label={`${label}: ${value}`}
      className="rounded-md border border-hairline bg-plane px-3 py-2.5"
    >
      <p className="text-xs text-muted" aria-hidden="true">
        {label}
      </p>
      <p className={`tabular mt-0.5 text-xl font-semibold ${TONES[tone]}`} aria-hidden="true">
        {value}
      </p>
    </div>
  );
}
