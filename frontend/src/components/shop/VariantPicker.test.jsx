import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import VariantPicker from './VariantPicker';

/**
 * Choosing a colour and a size.
 *
 * The claims worth pinning down are the two that a naive implementation gets
 * wrong in ways nobody notices until a customer complains: sizes must be
 * filtered by the CHOSEN colour (a shop can stock Midnight in S and L but Sand
 * only in M), and a sold-out option must be visible-but-disabled rather than
 * hidden, because "not in your size right now" and "we don't make that size"
 * are different facts.
 */

const VARIANTS = [
  { _id: 'v1', color: { name: 'Midnight', hex: '#111827' }, size: 'S', inStock: true },
  { _id: 'v2', color: { name: 'Midnight', hex: '#111827' }, size: 'L', inStock: true },
  { _id: 'v3', color: { name: 'Sand', hex: '#d6c7a1' }, size: 'M', inStock: true },
  { _id: 'v4', color: { name: 'Forest', hex: '#2f4f3a' }, size: 'M', inStock: false },
];

function setup(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <VariantPicker variants={VARIANTS} value={null} onChange={onChange} {...props} />
  );
  return { onChange, ...utils };
}

describe('VariantPicker', () => {
  it('lists each colour once, however many sizes it comes in', () => {
    setup();

    // Midnight has two sizes and must still be one swatch — otherwise the
    // shopper is offered the same choice twice.
    expect(screen.getAllByRole('button', { name: /^Midnight$/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Sand$/ })).toBeInTheDocument();
  });

  it('disables a colour that is entirely sold out, rather than hiding it', () => {
    setup();

    const forest = screen.getByRole('button', { name: /Forest \(out of stock\)/ });
    expect(forest).toBeDisabled();
  });

  it('selects a variant as soon as a colour is chosen', async () => {
    const user = userEvent.setup();
    const { onChange } = setup();

    await user.click(screen.getByRole('button', { name: /^Sand$/ }));

    /*
     * Selecting eagerly matters most for the commonest case of all: a product
     * with colours and NO sizes, where choosing the colour IS choosing the
     * variant and there is no second control to click.
     */
    expect(onChange).toHaveBeenCalledWith('v3');
  });

  it('offers only the sizes stocked in the chosen colour', async () => {
    const user = userEvent.setup();
    const { rerender } = setup();

    await user.click(screen.getByRole('button', { name: /^Midnight$/ }));
    rerender(<VariantPicker variants={VARIANTS} value="v1" onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'S' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'L' })).toBeInTheDocument();
    // M exists on the product, but not in Midnight — offering it would let the
    // shopper pick a combination that was never stocked.
    expect(screen.queryByRole('button', { name: 'M' })).not.toBeInTheDocument();
  });

  it('names the chosen colour in words, not by colour alone', async () => {
    const user = userEvent.setup();
    const { rerender } = setup();

    await user.click(screen.getByRole('button', { name: /^Sand$/ }));
    rerender(<VariantPicker variants={VARIANTS} value="v3" onChange={vi.fn()} />);

    /*
     * Asserted on the fieldset's accessible name rather than with a plain text
     * query, because "Sand" legitimately appears twice — once in the legend as
     * the current selection, once as the swatch button's screen-reader label.
     * Both are wanted; a bare `getByText` would simply fail on the duplication
     * and tell us nothing about either.
     *
     * A circle of colour has no accessible name of its own, and roughly one in
     * twelve men could not tell two of these apart, so the word is what
     * actually communicates the choice.
     */
    expect(screen.getByRole('group', { name: /colour.*sand/i })).toBeInTheDocument();
  });
});
