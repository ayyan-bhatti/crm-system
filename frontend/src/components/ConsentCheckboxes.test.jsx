import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConsentCheckboxes from './ConsentCheckboxes';

/**
 * The consent boxes.
 *
 * WHAT IS WORTH TESTING IN A COMPONENT THIS SMALL is not that a checkbox
 * checks. It is the three properties that make it a CONSENT control rather
 * than three booleans:
 *
 *   1. nothing is ever pre-ticked
 *   2. the channels stay independent of one another
 *   3. an untouched channel is not reported at all
 *
 * Each of those has a plausible implementation that gets it wrong, and each
 * wrong version would send somebody a message they did not agree to — or
 * withdraw one they did.
 */

describe('ConsentCheckboxes', () => {
  it('renders one box per channel, all unticked, with nothing pre-selected', () => {
    render(<ConsentCheckboxes value={{}} onChange={() => {}} />);

    const boxes = screen.getAllByRole('checkbox');

    expect(boxes).toHaveLength(3);
    boxes.forEach((box) => expect(box).not.toBeChecked());
  });

  /**
   * A PRE-TICKED CONSENT BOX IS NOT CONSENT, and the component takes no prop
   * that could produce one. This pins the absence: passing an empty value must
   * give three empty boxes, whatever else is passed.
   */
  it('has no way to render a box already ticked from a default', () => {
    render(<ConsentCheckboxes value={{}} onChange={() => {}} legend="Anything" />);

    screen.getAllByRole('checkbox').forEach((box) => expect(box).not.toBeChecked());
  });

  it('reports only the channel that was actually ticked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<ConsentCheckboxes value={{}} onChange={onChange} />);

    await user.click(screen.getByRole('checkbox', { name: /marketing emails/i }));

    expect(onChange).toHaveBeenCalledWith({ emailOptIn: true });

    /*
     * NOT `{ emailOptIn: true, smsOptIn: false, whatsappOptIn: false }`.
     *
     * An untouched channel must be ABSENT rather than false, because the two
     * mean different things downstream: `applyConsent` leaves an absent
     * channel alone and treats `false` as a withdrawal. A form that offers
     * email and SMS must not silently revoke a WhatsApp consent it never
     * showed — and the difference between "they did not tick it" and "they
     * asked to be taken off" is the whole point.
     */
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ smsOptIn: expect.anything() })
    );
  });

  it('does not let one channel tick another', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<ConsentCheckboxes value={{ emailOptIn: true }} onChange={onChange} />);

    expect(screen.getByRole('checkbox', { name: /marketing emails/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /text messages/i })).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /text messages/i }));

    // The existing email consent survives; only SMS is added.
    expect(onChange).toHaveBeenCalledWith({ emailOptIn: true, smsOptIn: true });
  });

  /**
   * The labels say "Marketing emails", not "Email".
   *
   * Two of the three forms this appears on already have a field called
   * "Email", and a checkbox with the same accessible name is genuinely
   * ambiguous — a screen reader user hears "Email" twice with nothing to tell
   * them apart. It is also the more honest label: "Email" names a channel,
   * "Marketing emails" names what is being agreed to.
   */
  it('labels each box with what is being agreed to, not just the channel', () => {
    render(<ConsentCheckboxes value={{}} onChange={() => {}} />);

    expect(screen.getByRole('checkbox', { name: /marketing emails/i })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /^email$/i })).not.toBeInTheDocument();
  });

  it('uses the channel list the server supplied when there is one', () => {
    render(
      <ConsentCheckboxes
        value={{}}
        onChange={() => {}}
        channels={[{ value: 'email', label: 'Newsletter', hint: 'Once a month.' }]}
      />
    );

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: /newsletter/i })).toBeInTheDocument();
    expect(screen.getByText('Once a month.')).toBeInTheDocument();
  });

  it('can be disabled while a form is submitting', () => {
    render(<ConsentCheckboxes value={{}} onChange={() => {}} disabled />);

    screen.getAllByRole('checkbox').forEach((box) => expect(box).toBeDisabled());
  });
});
