import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { campaignsApi } from '../../api/resources';
import { errorMessage } from '../../api/client';
import useFetch from '../../hooks/useFetch';
import usePermissions from '../../hooks/usePermissions';
import { useToast } from '../../components/Toast';
import { Card, ErrorBanner, PageHeader, Spinner } from '../../components/common';
import {
  CONTACT_CHANNELS,
  CONTACT_SOURCE_LABELS,
  btnPrimary,
  btnSecondary,
  input,
} from '../../ui';

/**
 * The campaign builder: goal, audience, copy.
 *
 * THE ORDER OF THE FORM IS THE ARGUMENT IT MAKES.
 *
 * Audience first, then the preview, then the words. Writing the copy before
 * knowing who it is for is how a campaign ends up addressed to nobody in
 * particular — and, more practically, the AI is given the audience as context,
 * so it cannot draft anything sensible until that is settled.
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
 * invent a campaign and put it in front of four thousand people.
 *
 * ALSO THE EDIT FORM, when reached via `/crm/campaigns/:id/edit`. Editing and
 * creating ask for the same six fields, so this is one component rather than
 * two that would drift apart the first time a field changed — the only real
 * difference is which `campaignsApi` call the save button makes, and that a
 * campaign that has already sent (or is queued for approval) cannot be
 * edited at all, mirroring the backend's own rule in `updateCampaign`.
 */
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

  async function handleSave() {
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

  const reachable = preview?.reachable?.[channel] ?? 0;
  const bodyForChannel =
    channel === 'email' ? content.body : channel === 'sms' ? content.sms : content.whatsapp;

  const canSave =
    name.trim() &&
    (channel === 'email'
      ? content.subject.trim() && content.body.trim()
      : Boolean(bodyForChannel?.trim() || content.body.trim()));

  if (!loaded) return <Spinner full />;

  // The backend refuses this PATCH outright once a campaign has left draft —
  // see updateCampaign's guard. Said here too, before anyone fills anything
  // in, rather than as a save error after the fact.
  if (editing && campaignStatus && campaignStatus !== 'draft') {
    return (
      <div className="max-w-3xl space-y-5">
        <PageHeader title="Edit campaign" />
        <ErrorBanner message="This campaign has already sent, or is waiting on approval, so it can no longer be edited. A sent campaign is a record of something that happened." />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title={editing ? 'Edit campaign' : 'New campaign'}
        subtitle={
          editing
            ? 'Still a draft until it is sent — changes here are safe.'
            : 'Saving creates a draft. Nothing is sent until you send it from the campaign page.'
        }
      />

      <ErrorBanner message={error} onDismiss={() => setError('')} />

      {/* --- 1. what and to whom -------------------------------------------- */}
      <Card className="space-y-4 p-5">
        <h2 className="text-sm font-semibold text-ink">1. Audience</h2>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-2">Campaign name</span>
          <input
            className={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="March win-back"
            maxLength={120}
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-2">
            What is this campaign for?
          </span>
          <textarea
            className={`${input} min-h-20`}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Win back customers who have not ordered in a while"
            maxLength={500}
          />
          <span className="mt-1 block text-xs text-muted">
            This is what the AI is given, and what an administrator reads if the send needs
            approving.
          </span>
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Send to</span>
            <select
              className={input}
              value={audience.preset}
              onChange={(e) => setAudienceField('preset', e.target.value)}
            >
              {(meta?.audiences || []).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Channel</span>
            <select
              className={input}
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
            >
              {CONTACT_CHANNELS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                  {meta?.channelStatus && !meta.channelStatus[item.value]?.live
                    ? ' (log only)'
                    : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">
              Narrow by source (optional)
            </span>
            <select
              className={input}
              value={audience.source}
              onChange={(e) => setAudienceField('source', e.target.value)}
            >
              <option value="">Any source</option>
              {(meta?.sources || []).map((source) => (
                <option key={source} value={source}>
                  {CONTACT_SOURCE_LABELS[source] || source}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">
              Narrow by tag (optional)
            </span>
            <input
              className={input}
              value={audience.tag}
              onChange={(e) => setAudienceField('tag', e.target.value)}
              placeholder="VIP"
              maxLength={32}
            />
          </label>
        </div>
      </Card>

      {/* --- 2. who that actually reaches ----------------------------------- */}
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink">2. Who this reaches</h2>

        {previewing && (
          <div className="mt-3">
            <Spinner />
          </div>
        )}

        {preview && !previewing && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Match this audience" value={preview.total} />
              <Stat
                label={`Opted in to ${channel}`}
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
              <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Nobody in this audience has opted in to {channel}, so this campaign would reach
                no one. Try a different channel, or collect consent first.
              </p>
            )}

            {/*
              The approval warning, shown BEFORE anything is written. A manager
              who only discovers this at the moment they press send reasonably
              concludes the button is broken.
            */}
            {preview.needsApproval && !isAdmin && (
              <p className="mt-3 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
                {preview.outsideScope} of these contacts are outside your own, so sending this
                will go to an administrator for approval rather than out straight away.
              </p>
            )}
          </>
        )}
      </Card>

      {/* --- 3. the words ---------------------------------------------------- */}
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">3. The message</h2>
          <button
            type="button"
            className={btnSecondary}
            onClick={handleDraft}
            disabled={drafting || !goal.trim()}
          >
            {drafting ? <Spinner /> : 'Draft with AI'}
          </button>
        </div>

        {content.mode !== 'manual' && (
          <p className="text-xs text-muted">
            {content.mode === 'ai'
              ? 'Written by the AI from your goal. Read it before sending — it has not been checked by anyone.'
              : 'The AI was unavailable, so this is a plain template. Edit it before sending.'}
          </p>
        )}

        {channel === 'email' && (
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-ink-2">Subject</span>
            <input
              className={input}
              value={content.subject}
              onChange={(e) => setContent({ ...content, subject: e.target.value })}
              maxLength={150}
            />
          </label>
        )}

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-ink-2">
            {channel === 'email' ? 'Email body' : `${channel === 'sms' ? 'SMS' : 'WhatsApp'} text`}
          </span>
          <textarea
            className={`${input} min-h-40`}
            value={channel === 'email' ? content.body : bodyForChannel}
            onChange={(e) =>
              setContent({
                ...content,
                [channel === 'email' ? 'body' : channel]: e.target.value,
              })
            }
          />
          <span className="mt-1 block text-xs text-muted">
            Write <code>{'{{name}}'}</code> where the recipient&rsquo;s first name should go. An
            unsubscribe link is added to every marketing email automatically.
          </span>
        </label>

        {/*
          The other channels' copy is kept and shown even though only one is
          being sent. The AI writes all four from one idea, and a staff member
          who asked for them will want to reuse them — throwing away three
          quarters of a generation because a dropdown says "email" would be
          quietly wasteful.
        */}
        {content.socialPost && (
          <div className="rounded-lg border border-hairline bg-plane p-3">
            <p className="text-xs font-medium text-ink-2">Social post — copy and paste</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{content.socialPost}</p>
            <p className="mt-2 text-xs text-muted">
              This app does not post to any social platform. This is copy for you to post from
              wherever you normally do.
            </p>
          </div>
        )}
      </Card>

      <div className="flex gap-2">
        <button type="button" className={btnPrimary} onClick={handleSave} disabled={saving || !canSave}>
          {saving ? <Spinner /> : editing ? 'Save changes' : 'Save as draft'}
        </button>
        <button
          type="button"
          className={btnSecondary}
          onClick={() => navigate(editing ? `/crm/campaigns/${id}` : '/crm/campaigns')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const TONES = {
  good: 'text-emerald-700',
  warn: 'text-amber-700',
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
      className="rounded-lg border border-hairline bg-plane px-3 py-2"
    >
      <p className="text-xs text-muted" aria-hidden="true">
        {label}
      </p>
      <p className={`text-xl font-semibold ${TONES[tone]}`} aria-hidden="true">
        {value}
      </p>
    </div>
  );
}
