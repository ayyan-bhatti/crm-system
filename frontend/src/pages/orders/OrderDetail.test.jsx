import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrderDetail from './OrderDetail';
import { renderWithProviders, fakeUser } from '../../test/utils';
import { authApi, ordersApi, usersApi } from '../../api/resources';

/**
 * The order detail screen: its identity, and who it belongs to.
 *
 * Two things are being pinned here.
 *
 * The ORDER NUMBER, because the whole point of adding one is that it appears
 * where a human looks. A number that exists in the database and not on the
 * screen has solved nothing — "what happened with 68f3a9…" is still the
 * sentence somebody has to say.
 *
 * The ASSIGNMENT CONTROL, because it is the half of the permission rule most
 * likely to be got wrong: everyone needs to SEE who an order belongs to (that
 * is the point of handing it over), and only a manager or admin may CHANGE it.
 * Hiding the whole panel from reps would be as wrong as showing them the
 * button.
 */

vi.mock('../../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  ordersApi: {
    get: vi.fn(),
    assign: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    requestTransfer: vi.fn(),
    updateFulfilment: vi.fn(),
    trackingStatus: vi.fn(),
  },
  usersApi: { assignable: vi.fn() },
}));

const SPECIALIST = { _id: 'u2', name: 'Bilal Ahmed', email: 'bilal@example.com', role: 'sales_rep' };

const order = (overrides = {}) => ({
  _id: '650000000000000000000001',
  orderNumber: 'ORD-000142',
  status: 'pending',
  total: 900,
  createdAt: '2026-08-01T10:00:00.000Z',
  completedAt: null,
  customer: { _id: 'c1', name: 'Karachi Traders', company: 'KT', assignedTo: { _id: 'u1', name: 'Owning Rep' } },
  createdBy: { _id: 'u1', name: 'Owning Rep', role: 'sales_rep' },
  assignedTo: null,
  items: [{ _id: 'i1', quantity: 2, priceAtOrder: 450, product: { _id: 'p1', name: 'Widget', sku: 'WID-1' } }],
  ...overrides,
});

const renderAs = (role, data = order()) => {
  authApi.me.mockResolvedValue(fakeUser({ role }));
  ordersApi.get.mockResolvedValue(data);

  return renderWithProviders(<OrderDetail />, {
    route: `/orders/${data._id}`,
    path: '/orders/:id',
    guarded: true,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  usersApi.assignable.mockResolvedValue([SPECIALIST]);
  ordersApi.assign.mockResolvedValue(order({ assignedTo: SPECIALIST }));
  ordersApi.requestTransfer.mockResolvedValue({
    success: true,
    message: 'Asked for this order to be transferred to Bilal Ahmed.',
  });
  ordersApi.updateFulfilment.mockResolvedValue(order());
  ordersApi.trackingStatus.mockResolvedValue({ trackingUrl: null, live: false });
});

describe('the order number', () => {
  it('is the heading, so it is the first thing you can quote', async () => {
    renderAs('manager');

    expect(await screen.findByRole('heading', { name: 'ORD-000142' })).toBeInTheDocument();
  });

  /**
   * Orders created before order numbers existed have none. They must stay
   * usable — a short id is unlovely but readable, where a blank heading is a
   * page that looks broken.
   */
  it('falls back to a short id for an order that predates numbering', async () => {
    renderAs('manager', order({ orderNumber: null }));

    expect(await screen.findByRole('heading', { name: '#000001' })).toBeInTheDocument();
  });
});

describe('the assignment panel', () => {
  /** Everyone sees the state — that is the point of a hand-off. */
  it.each([['admin'], ['manager'], ['sales_rep']])('shows %s who the order belongs to', async (role) => {
    renderAs(role, order({ assignedTo: SPECIALIST }));

    expect(await screen.findByText('Bilal Ahmed')).toBeInTheDocument();
  });

  /**
   * Unassigned now genuinely means nobody, and the copy has to say so.
   *
   * It used to mean "follows whoever owns the customer", and this panel showed
   * that rep's name. Reps no longer have customers, so naming one would name a
   * person who cannot actually see the order — worse than saying nothing.
   */
  it('says plainly that nobody holds an unassigned order', async () => {
    renderAs('manager');

    expect(await screen.findByText(/not yet assigned/i)).toBeInTheDocument();
    expect(screen.getByText(/no rep can see this order/i)).toBeInTheDocument();
  });

  it.each([['admin'], ['manager']])('offers %s the reassign control', async (role) => {
    renderAs(role);

    expect(await screen.findByRole('button', { name: /reassign/i })).toBeInTheDocument();
  });

  /** A rep handing their own work to a colleague is somebody else's decision. */
  it('hides the reassign control from a sales rep', async () => {
    renderAs('sales_rep');

    expect(await screen.findByText(/assigned to/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reassign/i })).not.toBeInTheDocument();
  });

  it('reassigns through the dedicated endpoint', async () => {
    const user = userEvent.setup();
    renderAs('manager');

    await user.click(await screen.findByRole('button', { name: /reassign/i }));
    await user.type(await screen.findByPlaceholderText(/search colleagues/i), 'Bilal');
    // By ROLE, not by text: the name also appears in the panel header as the
    // current assignee, so a text match finds two elements.
    await user.click(await screen.findByRole('option', { name: /Bilal Ahmed/i }));

    await waitFor(() =>
      expect(ordersApi.assign).toHaveBeenCalledWith('650000000000000000000001', 'u2')
    );
  });

  /**
   * Clearing is a real operation, not a mistake to guard against: it returns
   * the order to following its customer once a temporary hand-off is over.
   */
  it('can clear an assignment, sending null', async () => {
    const user = userEvent.setup();
    renderAs('manager', order({ assignedTo: SPECIALIST }));

    await user.click(await screen.findByRole('button', { name: /reassign/i }));
    await user.click(await screen.findByRole('button', { name: /clear assignment/i }));

    await waitFor(() =>
      expect(ordersApi.assign).toHaveBeenCalledWith('650000000000000000000001', null)
    );
  });

  /** Nothing to clear on an order that already follows its customer. */
  it('offers no clear button when the order is already unassigned', async () => {
    const user = userEvent.setup();
    renderAs('manager');

    await user.click(await screen.findByRole('button', { name: /reassign/i }));

    expect(await screen.findByPlaceholderText(/search colleagues/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear assignment/i })).not.toBeInTheDocument();
  });

  it('reports a failure instead of appearing to succeed', async () => {
    const user = userEvent.setup();
    ordersApi.assign.mockRejectedValue({
      response: { data: { message: 'That account is not active, so it cannot be assigned work' } },
    });
    renderAs('manager');

    await user.click(await screen.findByRole('button', { name: /reassign/i }));
    await user.type(await screen.findByPlaceholderText(/search colleagues/i), 'Bilal');
    // By ROLE, not by text: the name also appears in the panel header as the
    // current assignee, so a text match finds two elements.
    await user.click(await screen.findByRole('option', { name: /Bilal Ahmed/i }));

    expect(await screen.findByText(/not active/i)).toBeInTheDocument();
  });
});

/**
 * The rep's one way to move work.
 *
 * They cannot reassign — that would let them push a difficult account onto a
 * colleague, which is a staffing decision somebody else should make. But they
 * are the person who knows they are on leave next week. So the control is not
 * hidden, it is a DIFFERENT control: ask, and an admin decides.
 */
describe('a rep asking for a transfer', () => {
  const asHolder = () => renderAs('sales_rep', order({ assignedTo: SPECIALIST }));

  it('offers the rep a request rather than a reassignment', async () => {
    asHolder();

    expect(await screen.findByRole('button', { name: /request transfer/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reassign$/i })).not.toBeInTheDocument();
  });

  /** And the manager keeps the real thing, not the request. */
  it('offers a manager the reassignment rather than a request', async () => {
    renderAs('manager', order({ assignedTo: SPECIALIST }));

    expect(await screen.findByRole('button', { name: /^reassign$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request transfer/i })).not.toBeInTheDocument();
  });

  it('sends the colleague and the reason', async () => {
    const user = userEvent.setup();
    asHolder();

    await user.click(await screen.findByRole('button', { name: /request transfer/i }));
    await user.type(await screen.findByPlaceholderText(/search colleagues/i), 'Bilal');
    // By ROLE, not by text: the name also appears in the panel header as the
    // current assignee, so a text match finds two elements.
    await user.click(await screen.findByRole('option', { name: /Bilal Ahmed/i }));
    await user.type(screen.getByLabelText(/reason for the transfer/i), 'On leave next week');
    await user.click(screen.getByRole('button', { name: /send request/i }));

    await waitFor(() =>
      expect(ordersApi.requestTransfer).toHaveBeenCalledWith(
        '650000000000000000000001',
        'u2',
        'On leave next week'
      )
    );
  });

  /** Nothing to send until a colleague is named. */
  it('cannot be sent without naming somebody', async () => {
    const user = userEvent.setup();
    asHolder();

    await user.click(await screen.findByRole('button', { name: /request transfer/i }));

    expect(screen.getByRole('button', { name: /send request/i })).toBeDisabled();
  });

  /** The rep has to know it has not happened yet. */
  it('says the order stays with them until somebody agrees', async () => {
    const user = userEvent.setup();
    asHolder();

    await user.click(await screen.findByRole('button', { name: /request transfer/i }));

    expect(
      await screen.findByText(/stays with you until an administrator agrees/i)
    ).toBeInTheDocument();
  });

  it('reports a refusal instead of appearing to succeed', async () => {
    const user = userEvent.setup();
    ordersApi.requestTransfer.mockRejectedValue({
      response: { data: { message: 'That account is not active' } },
    });
    asHolder();

    await user.click(await screen.findByRole('button', { name: /request transfer/i }));
    await user.type(await screen.findByPlaceholderText(/search colleagues/i), 'Bilal');
    // By ROLE, not by text: the name also appears in the panel header as the
    // current assignee, so a text match finds two elements.
    await user.click(await screen.findByRole('option', { name: /Bilal Ahmed/i }));
    await user.click(screen.getByRole('button', { name: /send request/i }));

    expect(await screen.findByText(/not active/i)).toBeInTheDocument();
  });
});

/**
 * WHO HOLDS THIS ORDER, ON THE BAR THAT SAYS "ASSIGNED TO".
 *
 * Reported as: the heading appears with nothing under it. The cause was in the
 * API — the detail response was the one order response that never populated
 * `assignedTo` — but the screen made it invisible rather than obvious, because
 * an id is truthy, so it took the "somebody holds this" branch and rendered an
 * undefined name.
 */
describe('the assignment bar', () => {
  it('names the rep holding the order, and their role', async () => {
    renderAs('sales_rep', order({ assignedTo: SPECIALIST }));

    expect(await screen.findByText('Bilal Ahmed')).toBeInTheDocument();
    expect(screen.getByText('Assigned to')).toBeInTheDocument();
    expect(screen.getByText('Sales rep')).toBeInTheDocument();
  });

  it('names the rep for a manager too', async () => {
    renderAs('manager', order({ assignedTo: SPECIALIST }));

    expect(await screen.findByText('Bilal Ahmed')).toBeInTheDocument();
  });

  it('says plainly when nobody holds it', async () => {
    renderAs('manager', order({ assignedTo: null }));

    expect(await screen.findByText('Not yet assigned')).toBeInTheDocument();
  });

  /*
   * The regression guard. If a response ever ships a bare id again, the screen
   * must say something rather than render a heading over emptiness — a wrong
   * message is findable, a blank one is not.
   */
  it('never renders the heading over nothing, even given an unpopulated id', async () => {
    renderAs('manager', order({ assignedTo: '650000000000000000000009' }));

    await screen.findByRole('heading', { name: 'ORD-000142' });
    expect(screen.getByText('Not yet assigned')).toBeInTheDocument();
  });
});

/**
 * Recording a courier and tracking number, and the real-vs-link-only split
 * between DHL and everything else — see the note in services/courierService.js
 * for why only DHL gets a "Check live status" button at all.
 */
describe('courier tracking', () => {
  it('shows the tracking number and a link to the courier once one is recorded', async () => {
    renderAs(
      'manager',
      order({ fulfilment: 'shipped', courier: 'tcs', trackingNumber: 'CN12345' })
    );

    expect(await screen.findByText(/CN12345/)).toBeInTheDocument();
    expect(
      await screen.findByRole('link', { name: /track package/i })
    ).toHaveAttribute('href', 'https://www.tcsexpress.com/track/');
  });

  it('offers a live-status check only for DHL, not for TCS or Leopards', async () => {
    renderAs('manager', order({ fulfilment: 'shipped', courier: 'tcs', trackingNumber: 'CN1' }));

    await screen.findByText(/CN1/);
    expect(screen.queryByRole('button', { name: /check live status/i })).not.toBeInTheDocument();
  });

  it('sends the courier and tracking number when the delivery form is saved', async () => {
    const user = userEvent.setup();
    renderAs('manager', order({ fulfilment: 'processing' }));

    await user.click(await screen.findByRole('button', { name: /update delivery/i }));
    await user.selectOptions(screen.getByLabelText(/delivery status/i), 'shipped');
    await user.type(screen.getByLabelText(/estimated delivery date/i), '2026-09-10');
    await user.selectOptions(screen.getByLabelText(/^courier$/i), 'dhl');
    await user.type(screen.getByLabelText(/tracking number/i), 'JD0141');
    await user.click(screen.getByRole('button', { name: /save delivery status/i }));

    await waitFor(() => {
      expect(ordersApi.updateFulfilment).toHaveBeenCalledWith(
        order()._id,
        'shipped',
        '2026-09-10',
        'dhl',
        'JD0141'
      );
    });
  });

  it('checks live status through the API and shows what DHL says', async () => {
    const user = userEvent.setup();
    ordersApi.trackingStatus.mockResolvedValue({
      trackingUrl: 'https://www.dhl.com/pk-en/home/tracking.html?tracking-id=JD0141',
      live: true,
      status: 'delivered',
      description: 'Delivered',
    });

    renderAs(
      'manager',
      order({ fulfilment: 'shipped', courier: 'dhl', trackingNumber: 'JD0141' })
    );

    await user.click(await screen.findByRole('button', { name: /check live status/i }));

    expect(await screen.findByText(/DHL says: Delivered/i)).toBeInTheDocument();
  });
});
