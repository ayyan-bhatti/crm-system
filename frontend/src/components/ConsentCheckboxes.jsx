import { CONTACT_CHANNELS } from '../ui';

/**
 * The three marketing opt-in boxes, wherever consent is collected.
 *
 * THREE BOXES, NEVER ONE, and this component exists mainly to make that
 * structural. Someone may want email and not WhatsApp — those are different
 * intrusions and people rate them differently — and a single "yes to
 * marketing" checkbox means the only way to stop the WhatsApp messages is to
 * stop the emails too. Sharing one component across the three places consent
 * is collected (storefront registration, checkout, the internal customer form)
 * is what stops one of them quietly growing a combined box.
 *
 * EVERY BOX IS UNCHECKED UNLESS THE CALLER'S STATE SAYS OTHERWISE, and there
 * is no `defaultChecked` prop to pass. A pre-ticked consent box is not
 * consent, and the reliable way to guarantee this component never renders one
 * is to give it nothing to render one from.
 *
 * The hints come from the server on the storefront (`/api/shop/config`) and
 * from the defaults here inside the CRM. Wording matters legally as well as
 * commercially — a box saying "marketing" with no indication of what arrives
 * is the kind of consent that does not survive being questioned.
 */

/**
 * The default labels say MARKETING, and the word is load-bearing.
 *
 * Two of the three forms this component appears on already have a field called
 * "Email" — the customer form and the storefront registration — so a checkbox
 * also labelled "Email" is genuinely ambiguous, and not only to a test looking
 * one up. A screen reader user tabbing through hears "Email" twice and has
 * nothing to tell them apart, and a sighted user glancing at a form can
 * reasonably read a bare "Email" checkbox next to an email field as "is this
 * address correct".
 *
 * It is also the more honest label. "Email" describes a channel; "Marketing
 * emails" describes what the person is agreeing to receive, which is the thing
 * consent is actually about.
 */
const DEFAULT_LABELS = {
  email: 'Marketing emails',
  sms: 'Marketing text messages',
  whatsapp: 'Marketing WhatsApp messages',
};

const DEFAULT_HINTS = {
  email: 'Occasional emails about new products and offers. Unsubscribe any time.',
  sms: 'Text messages about orders they might want to repeat.',
  whatsapp: 'WhatsApp messages about new products.',
};

export default function ConsentCheckboxes({
  value = {},
  onChange,
  channels = null,
  legend = 'Marketing preferences',
  hint = '',
  disabled = false,
}) {
  const list =
    channels?.length
      ? channels
      : CONTACT_CHANNELS.map((c) => ({
          ...c,
          label: DEFAULT_LABELS[c.value] || c.label,
          hint: DEFAULT_HINTS[c.value],
        }));

  return (
    <fieldset className="rounded-lg border border-hairline bg-plane p-4">
      <legend className="px-1 text-sm font-medium text-ink-2">{legend}</legend>

      {hint && <p className="mb-3 text-xs text-muted">{hint}</p>}

      <div className="space-y-3">
        {list.map((channel) => {
          const key = `${channel.value}OptIn`;

          return (
            <label key={channel.value} className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5"
                /*
                 * `Boolean(...)` rather than the raw value, so an undefined
                 * key does not flip the input from controlled to uncontrolled
                 * the first time it is ticked — React warns about that and
                 * then silently stops tracking the box.
                 */
                checked={Boolean(value[key])}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
              />
              <span>
                <span className="block text-sm text-ink">{channel.label}</span>
                {channel.hint && (
                  <span className="block text-xs text-muted">{channel.hint}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
