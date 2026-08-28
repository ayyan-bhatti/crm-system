import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './common';

/**
 * `Field`'s `required` behaviour.
 *
 * Two visible/DOM signals have to show up together — the asterisk and
 * `aria-required` — and neither should appear at all when the field is
 * optional. See the component's own comment for why an asterisk alone is
 * not enough (colour/symbol-only cues fail a screen reader and a
 * colourblind user alike).
 */
describe('Field required', () => {
  it('marks a required field with a visible asterisk, an accessible "(Required)", and aria-required', () => {
    render(<Field label="Email" required value="" onChange={() => {}} />);

    const input = screen.getByLabelText(/email/i);
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).toBeRequired();

    // The asterisk is decorative (aria-hidden) — the accessible name comes
    // from the sr-only "(Required)" text instead.
    expect(screen.getByText('*', { selector: 'span[aria-hidden="true"]' })).toBeInTheDocument();
    expect(screen.getByText('(Required)')).toBeInTheDocument();
  });

  it('adds no asterisk, no "(Required)" text, and no aria-required when not required', () => {
    render(<Field label="Phone" value="" onChange={() => {}} />);

    const input = screen.getByLabelText(/phone/i);
    expect(input).not.toHaveAttribute('aria-required');
    expect(input).not.toBeRequired();
    expect(screen.queryByText('(Required)')).not.toBeInTheDocument();
    expect(screen.queryByText('*')).not.toBeInTheDocument();
  });

  it('passes aria-required through to a caller-supplied control (e.g. a select)', () => {
    render(
      <Field label="Country" required>
        <select value="" onChange={() => {}}>
          <option value="">Choose…</option>
        </select>
      </Field>
    );

    expect(screen.getByLabelText(/country/i)).toHaveAttribute('aria-required', 'true');
  });
});
