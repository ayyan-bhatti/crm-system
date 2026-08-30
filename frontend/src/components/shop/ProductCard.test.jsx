import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProductCard from './ProductCard';

/**
 * The catalogue tile.
 *
 * The badge rule is the part worth pinning: AT MOST ONE badge, chosen by
 * urgency. Stacking "New" and "Low stock" is how a grid becomes unreadable, and
 * once every card has a badge none of them means anything.
 */

function product(overrides = {}) {
  return {
    _id: 'p1',
    name: 'Field Jacket',
    price: 100,
    category: 'Outerwear',
    imageUrl: 'https://example.test/a.jpg',
    images: [],
    inStock: true,
    lowStock: false,
    variants: [],
    createdAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderCard(props = {}) {
  return render(
    <MemoryRouter>
      <ProductCard product={product()} {...props} />
    </MemoryRouter>
  );
}

describe('ProductCard', () => {
  it('shows a swatch per colour, collapsing sizes of the same colour', () => {
    renderCard({
      product: product({
        variants: [
          { _id: 'v1', color: { name: 'Midnight', hex: '#111827' }, size: 'S', inStock: true },
          { _id: 'v2', color: { name: 'Midnight', hex: '#111827' }, size: 'L', inStock: true },
          { _id: 'v3', color: { name: 'Sand', hex: '#d6c7a1' }, size: 'M', inStock: true },
        ],
      }),
    });

    // Two colours, three variants. Showing the same circle twice would imply a
    // choice that does not exist.
    expect(screen.getByText('Midnight')).toBeInTheDocument();
    expect(screen.getByText('Sand')).toBeInTheDocument();
  });

  it('marks a sold-out colour in words, not by opacity alone', () => {
    renderCard({
      product: product({
        variants: [
          { _id: 'v1', color: { name: 'Forest', hex: '#2f4f3a' }, inStock: false },
        ],
      }),
    });

    expect(screen.getByText(/Forest \(out of stock\)/)).toBeInTheDocument();
  });

  it('shows "from" pricing only when colours genuinely differ in price', () => {
    renderCard({
      product: product({
        variants: [
          { _id: 'v1', color: { name: 'A', hex: '#000000' }, price: 100, inStock: true },
          { _id: 'v2', color: { name: 'B', hex: '#ffffff' }, price: 125, inStock: true },
        ],
      }),
    });

    expect(screen.getByText('from $100.00')).toBeInTheDocument();
  });

  it('shows a plain price when every colour costs the same', () => {
    renderCard({
      product: product({
        variants: [
          { _id: 'v1', color: { name: 'A', hex: '#000000' }, price: 100, inStock: true },
          { _id: 'v2', color: { name: 'B', hex: '#ffffff' }, price: 100, inStock: true },
        ],
      }),
    });

    // "from $100" on a product with exactly one price is a hedge that makes the
    // shop look like it is hiding something.
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText(/from/)).not.toBeInTheDocument();
  });

  it('shows at most one badge, preferring low stock over new', () => {
    renderCard({
      product: product({ lowStock: true, createdAt: new Date().toISOString() }),
    });

    expect(screen.getByText('Low stock')).toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  it('badges a recent product as new', () => {
    renderCard({ product: product({ createdAt: new Date().toISOString() }) });
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('replaces the badge with a sold-out overlay when nothing is in stock', () => {
    renderCard({ product: product({ inStock: false, lowStock: true }) });

    expect(screen.getByText('Sold out')).toBeInTheDocument();
    expect(screen.queryByText('Low stock')).not.toBeInTheDocument();
  });

  it('offers quick view for an in-stock product and calls back with it', async () => {
    const user = userEvent.setup();
    const onQuickView = vi.fn();
    renderCard({ onQuickView });

    await user.click(screen.getByText('Quick view'));

    expect(onQuickView).toHaveBeenCalledWith(expect.objectContaining({ _id: 'p1' }));
  });

  it('offers no quick view on a sold-out product', () => {
    renderCard({ product: product({ inStock: false }), onQuickView: vi.fn() });
    expect(screen.queryByText('Quick view')).not.toBeInTheDocument();
  });
});
