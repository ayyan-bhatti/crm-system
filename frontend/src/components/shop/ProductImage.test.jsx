import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ProductImage from './ProductImage';
import { placeholderImage, livePhotoFor } from '../../ui';

/**
 * The fallback chain, which had a bug at each end of it.
 *
 * A product photo comes from one of three places with three different
 * reliability stories, and the order matters: the URL somebody set, then a
 * keyword-matched live photo, then a generated tile that cannot fail. Both of
 * the first two can fail SILENTLY — a dead host hangs rather than erroring —
 * which is why this is a component and not an `<img>`.
 */

const PRODUCT = { _id: 'p1', name: 'Gaming Laptop', category: 'Electronics' };

describe('ProductImage', () => {
  it('shows the URL that was set, when there is one', () => {
    render(<ProductImage product={PRODUCT} src="https://example.com/real.jpg" alt="" />);
    expect(screen.getByRole('presentation')).toHaveAttribute(
      'src',
      'https://example.com/real.jpg'
    );
  });

  /**
   * THE BUG. `[src || '', live, tile].filter(Boolean)` plus a separate `start`
   * index disagreed with each other: with no src the filter collapsed the array
   * to two entries, `start` was 1, and index 1 was now the TILE. So a product
   * with no image URL — the exact case the live photo exists for — skipped
   * straight to initials.
   */
  it('falls to a live photo, not the tile, when no URL is set', () => {
    render(<ProductImage product={PRODUCT} src="" alt="" />);
    const src = screen.getByRole('presentation').getAttribute('src');

    expect(src).toBe(livePhotoFor(PRODUCT));
    expect(src).not.toBe(placeholderImage(PRODUCT));
  });

  /**
   * A dead link is not "this product has no photo". Answering it with initials
   * gives a catalogue of lettered squares, which is what a shop must not look
   * like — so a broken URL gets a real photograph, not the floor.
   */
  it('tries a live photo when the set URL fails', () => {
    render(<ProductImage product={PRODUCT} src="https://example.invalid/nope.jpg" alt="" />);

    // `fireEvent` rather than a raw dispatch: the handler sets state, and the
    // element is re-keyed on the new source, so the node has to be looked up
    // again afterwards rather than held across the update.
    fireEvent.error(screen.getByRole('presentation'));

    expect(screen.getByRole('presentation')).toHaveAttribute('src', livePhotoFor(PRODUCT));
  });

  /** And a failing live photo lands on the floor, which cannot itself fail. */
  it('ends on the generated tile when the live photo fails too', () => {
    render(<ProductImage product={PRODUCT} src="https://example.invalid/nope.jpg" alt="" />);

    fireEvent.error(screen.getByRole('presentation'));
    fireEvent.error(screen.getByRole('presentation'));

    expect(screen.getByRole('presentation')).toHaveAttribute('src', placeholderImage(PRODUCT));
  });

  /**
   * ONE keyword, because the host 500s on comma-separated ones — `/laptop`
   * returns a photo, `/gaming,laptop` returns an error. Sending two was why
   * every product fell through to the tile. The LAST word is the head noun:
   * a "Gaming Laptop" is a laptop.
   */
  it('asks the photo host for a single, head-noun keyword', () => {
    const url = livePhotoFor(PRODUCT);
    expect(url).toContain('/laptop?');
    expect(url).not.toContain(',');
    expect(url).not.toContain('%2C');
  });

  it('drops bracketed pack sizes rather than searching for them', () => {
    const url = livePhotoFor({ _id: 'p2', name: 'A4 Paper (5 reams)', category: 'Supplies' });
    expect(url).toContain('/paper?');
  });

  /** One product keeps one photograph, or the grid reshuffles on every load. */
  it('is stable for a given product', () => {
    expect(livePhotoFor(PRODUCT)).toBe(livePhotoFor(PRODUCT));
    expect(livePhotoFor(PRODUCT)).not.toBe(livePhotoFor({ ...PRODUCT, _id: 'other' }));
  });
});
