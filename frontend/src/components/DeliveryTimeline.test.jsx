import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeliveryTimeline from './DeliveryTimeline';

/**
 * The buyer-facing delivery timeline.
 *
 * The interesting case is `cancelled`, which must NOT render as a timeline
 * sitting at stage zero — a cancelled order did not stop at the beginning of a
 * journey it is going to finish, it left the sequence, and drawing the steps
 * anyway invites the reader to expect progress along them.
 */

function order(overrides = {}) {
  return { fulfilment: 'processing', shippedAt: null, deliveredAt: null, ...overrides };
}

/*
 * Dates are asserted on month and year rather than the exact day.
 *
 * `formatDate` renders in the machine's local timezone, so a UTC midnight
 * timestamp is the previous day anywhere west of Greenwich. Pinning the day
 * would make this suite pass in one timezone and fail in another, which is a
 * property of the test rather than of the component — and the component's job
 * here is to show A date at all, not to be a timezone conversion test.
 */
/*
 * `Sept?` because Node's ICU abbreviates September as "Sept" in en-GB while
 * most other months get three letters — so a hardcoded "Sep" passes eleven
 * months of the year and fails in one.
 */
const SEPTEMBER_2026 = /Sept? 2026/;

describe('DeliveryTimeline', () => {
  it('shows every stage, marking the current one in words as well as colour', () => {
    render(<DeliveryTimeline order={order({ fulfilment: 'shipped' })} />);

    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('Shipped')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    // Never colour alone.
    expect(screen.getByText('Now')).toBeInTheDocument();
  });

  it('shows the estimated delivery date while the order is still on its way', () => {
    render(
      <DeliveryTimeline
        order={order({ fulfilment: 'shipped', estimatedDeliveryAt: '2026-09-04T00:00:00.000Z' })}
      />
    );

    expect(screen.getByText(/estimated delivery/i)).toBeInTheDocument();
    expect(screen.getByText(SEPTEMBER_2026)).toBeInTheDocument();
  });

  it('stops predicting once the parcel has actually arrived', () => {
    render(
      <DeliveryTimeline
        order={order({
          fulfilment: 'delivered',
          estimatedDeliveryAt: '2026-09-04T00:00:00.000Z',
          deliveredAt: '2026-09-02T00:00:00.000Z',
        })}
      />
    );

    // An estimate shown next to a delivery that has already happened is noise
    // at best and a contradiction at worst.
    expect(screen.queryByText(/estimated delivery/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Arrived /)).toBeInTheDocument();
  });

  it('replaces the sequence entirely for a cancelled order', () => {
    render(<DeliveryTimeline order={order({ fulfilment: 'cancelled' })} />);

    expect(screen.getByText(/cancelled, so it is not on its way/i)).toBeInTheDocument();
    // The stages must be gone, not merely unlit.
    expect(screen.queryByText('Out for delivery')).not.toBeInTheDocument();
  });

  it('mentions a refund on a cancelled order that was paid', () => {
    render(
      <DeliveryTimeline
        order={order({ fulfilment: 'cancelled', payment: { status: 'refunded' } })}
      />
    );

    expect(screen.getByText(/refunded in full/i)).toBeInTheDocument();
  });
});
