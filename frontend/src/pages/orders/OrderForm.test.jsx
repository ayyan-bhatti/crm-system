import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OrderForm from './OrderForm';
import { renderWithProviders, fakeUser, apiError } from '../../test/utils';
import { authApi, customersApi, ordersApi, productsApi, usersApi } from '../../api/resources';

/**
 * Creating an order.
 *
 * The most important flow in the app, and the one with the most moving parts:
 * two searchable pickers, a running total, a client-side stock check, and an
 * idempotency key. The tests drive it the way a user does — type into the
 * picker, choose from the list, set a quantity — because the interactions
 * BETWEEN those parts are where the bugs are.
 */
vi.mock('../../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  customersApi: { get: vi.fn(), options: vi.fn() },
  productsApi: { options: vi.fn() },
  ordersApi: { create: vi.fn(), get: vi.fn(), update: vi.fn() },
  // The form now asks who will work the order, so it reaches for the colleague
  // list on mount. Without this in the mock the whole component throws and
  // every test in the file fails on a missing label rather than a missing API.
  usersApi: { assignable: vi.fn() },
}));

const CUSTOMER = {
  _id: '650000000000000000000011',
  name: 'Karachi Traders',
  company: 'Karachi Traders Ltd',
  email: 'contact@kt.com',
};

const WIDGET = {
  _id: '650000000000000000000022',
  name: 'Blue Widget',
  sku: 'BW-1',
  price: 25,
  stockQty: 10,
};

/**
 * The product pickers: every combobox after the customer and the assignee.
 *
 * `getAllByRole('combobox')[1]` used to be the first product. The form then
 * gained an "Assign to" picker between the customer and the items, and every
 * one of those indexes silently pointed at the wrong control.
 *
 * Selecting them by placeholder would be nicer and does not work: SearchSelect
 * swaps its placeholder for the SELECTED LABEL once something is chosen, so a
 * line stops matching /search products/ the moment it has a product on it —
 * which is exactly when a test wants to look at the next one. Two fixed
 * controls precede the lines, so the offset is a structural fact rather than a
 * coincidence of ordering.
 */
const productBoxes = () => screen.getAllByRole('combobox').slice(2);

/** Pick an option from a SearchSelect by typing and clicking the result. */
async function pickFrom(user, combobox, searchText, optionName) {
  await user.click(combobox);
  await user.type(combobox, searchText);
  const option = await screen.findByRole('option', { name: new RegExp(optionName, 'i') });
  await user.click(option);
}

describe('OrderForm', () => {
  beforeEach(() => {
    authApi.me.mockResolvedValue(fakeUser());
    customersApi.options.mockResolvedValue([CUSTOMER]);
    productsApi.options.mockResolvedValue([WIDGET]);
    usersApi.assignable.mockResolvedValue([]);
  });

  const renderForm = (route = '/orders/new') =>
    renderWithProviders(<OrderForm />, { route, guarded: true });

  it('renders the customer and product pickers', async () => {
    renderForm();

    expect(await screen.findByLabelText(/customer/i)).toBeInTheDocument();
    expect(screen.getAllByRole('combobox').length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The whole point of the picker: it searches the SERVER, so a customer past
   * any fixed client-side limit is still reachable.
   */
  it('searches customers on the server as the user types', async () => {
    const user = userEvent.setup();
    renderForm();

    const customerBox = await screen.findByLabelText(/customer/i);
    await user.click(customerBox);
    await user.type(customerBox, 'karachi');

    await waitFor(() => expect(customersApi.options).toHaveBeenCalledWith('karachi'));
  });

  it('submits the chosen customer and line items', async () => {
    const user = userEvent.setup();
    ordersApi.create.mockResolvedValue({ _id: 'order-1' });

    renderForm();

    await pickFrom(user, await screen.findByLabelText(/customer/i), 'karachi', 'Karachi Traders');

    const [productBox] = productBoxes();
    await pickFrom(user, productBox, 'widget', 'Blue Widget');

    await user.click(screen.getByRole('button', { name: /create order/i }));

    await waitFor(() => expect(ordersApi.create).toHaveBeenCalled());

    expect(ordersApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: CUSTOMER._id,
        items: [{ product: WIDGET._id, quantity: 1 }],
      })
    );
  });

  it('totals the order from the chosen product price and quantity', async () => {
    const user = userEvent.setup();
    renderForm();

    await pickFrom(user, await screen.findByLabelText(/customer/i), 'karachi', 'Karachi Traders');

    const [productBox] = productBoxes();
    await pickFrom(user, productBox, 'widget', 'Blue Widget');

    const quantity = screen.getByRole('spinbutton');
    await user.clear(quantity);
    await user.type(quantity, '4');

    /*
     * 4 x $25. The figure appears twice on purpose — once as the line subtotal
     * and once as the order total — so this asserts on the order total
     * specifically rather than "some element says $100".
     */
    const orderTotalRow = (await screen.findByText(/order total/i)).parentElement;
    expect(within(orderTotalRow).getByText('$100.00')).toBeInTheDocument();
  });

  /**
   * Immediate feedback, mirroring the server rule. It is a convenience, not the
   * guarantee — the API re-checks atomically — but a form that lets someone
   * fill in an impossible order and only fails on submit is worse.
   */
  it('warns before submitting when a line exceeds available stock', async () => {
    const user = userEvent.setup();
    renderForm();

    await pickFrom(user, await screen.findByLabelText(/customer/i), 'karachi', 'Karachi Traders');

    const [productBox] = productBoxes();
    await pickFrom(user, productBox, 'widget', 'Blue Widget');

    const quantity = screen.getByRole('spinbutton');
    await user.clear(quantity);
    await user.type(quantity, '99');

    expect(await screen.findByText(/not enough stock/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create order/i })).toBeDisabled();
  });

  it('cannot be submitted without a customer', async () => {
    renderForm();

    await screen.findByLabelText(/customer/i);
    expect(screen.getByRole('button', { name: /create order/i })).toBeDisabled();
  });

  it('shows the server’s error when creation fails', async () => {
    const user = userEvent.setup();
    ordersApi.create.mockRejectedValue(
      apiError(400, 'Insufficient stock to complete this order for "Blue Widget"')
    );

    renderForm();

    await pickFrom(user, await screen.findByLabelText(/customer/i), 'karachi', 'Karachi Traders');
    const [productBox] = productBoxes();
    await pickFrom(user, productBox, 'widget', 'Blue Widget');

    await user.click(screen.getByRole('button', { name: /create order/i }));

    expect(await screen.findByText(/insufficient stock/i)).toBeInTheDocument();
  });

  describe('multiple lines', () => {
    it('adds another line', async () => {
      const user = userEvent.setup();
      renderForm();

      await screen.findByLabelText(/customer/i);
      await user.click(screen.getByRole('button', { name: /add item/i }));

      // Customer + two product pickers.
      // customer + assignee + two product lines
      expect(screen.getAllByRole('combobox')).toHaveLength(4);
    });

    /**
     * The bug the picker design exists to avoid: choosing a product on line two
     * must not disturb line one, whose product is no longer in the search
     * results. The selection is held per line rather than derived from the
     * options list.
     */
    it('keeps an earlier line’s selection when a later one is searched', async () => {
      const user = userEvent.setup();
      renderForm();

      await pickFrom(
        user,
        await screen.findByLabelText(/customer/i),
        'karachi',
        'Karachi Traders'
      );

      const [firstProduct] = productBoxes();
      await pickFrom(user, firstProduct, 'widget', 'Blue Widget');

      await user.click(screen.getByRole('button', { name: /add item/i }));

      // A different search that would not return the already-chosen widget.
      const gadget = { _id: '650000000000000000000033', name: 'Red Gadget', sku: 'RG-1', price: 5, stockQty: 10 };
      productsApi.options.mockResolvedValue([gadget]);

      const boxes = productBoxes();
      await pickFrom(user, boxes[1], 'gadget', 'Red Gadget');

      await user.click(screen.getByRole('button', { name: /create order/i }));

      await waitFor(() => expect(ordersApi.create).toHaveBeenCalled());

      // Both lines survived.
      expect(ordersApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [
            { product: WIDGET._id, quantity: 1 },
            { product: gadget._id, quantity: 1 },
          ],
        })
      );
    });
  });

  describe('arriving from a customer page', () => {
    it('preselects the customer and shows their name', async () => {
      customersApi.get.mockResolvedValue(CUSTOMER);

      renderWithProviders(<OrderForm />, {
        route: `/orders/new?customer=${CUSTOMER._id}`,
        guarded: true,
      });

      // Fetched by id so the picker can display a name rather than an empty box
      // that is nonetheless valid.
      await waitFor(() => expect(customersApi.get).toHaveBeenCalledWith(CUSTOMER._id));
      expect(await screen.findByDisplayValue(/karachi traders/i)).toBeInTheDocument();
    });
  });
});

/**
 * Naming who will work the order, at the moment it is placed.
 *
 * This was the reported problem: the form never asked, so placing an order and
 * getting it to a rep was two trips — create it, find it, reassign it. The
 * decision is usually already made when the order is taken.
 */
describe('assigning the order while creating it', () => {
  const SARA = { _id: 'u9', name: 'Sara Iqbal', email: 'sara@example.com', role: 'sales_rep' };

  // Its own, because the one above is scoped to the outer describe.
  const renderForm = () =>
    renderWithProviders(<OrderForm />, { route: '/orders/new', guarded: true });

  beforeEach(() => {
    vi.clearAllMocks();
    authApi.me.mockResolvedValue(fakeUser({ role: 'manager' }));
    customersApi.options.mockResolvedValue([CUSTOMER]);
    productsApi.options.mockResolvedValue([WIDGET]);
    usersApi.assignable.mockResolvedValue([SARA]);
    ordersApi.create.mockResolvedValue({ _id: 'order-1' });
  });

  const fillOrder = async (user) => {
    await pickFrom(user, await screen.findByLabelText(/customer/i), 'karachi', 'Karachi Traders');
    await pickFrom(user, productBoxes()[0], 'widget', 'Blue Widget');
  };

  it('asks who will work it', async () => {
    renderForm();

    expect(await screen.findByLabelText(/assign to/i)).toBeInTheDocument();
  });

  it('lists colleagues from the server as you type', async () => {
    const user = userEvent.setup();
    renderForm();

    const box = await screen.findByLabelText(/assign to/i);
    await user.click(box);
    await user.type(box, 'sara');

    await waitFor(() => expect(usersApi.assignable).toHaveBeenCalledWith('sara'));
  });

  it('sends the chosen rep with the order', async () => {
    const user = userEvent.setup();
    renderForm();

    await fillOrder(user);
    await pickFrom(user, screen.getByLabelText(/assign to/i), 'sara', 'Sara Iqbal');
    await user.click(screen.getByRole('button', { name: /create order/i }));

    await waitFor(() =>
      expect(ordersApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ assignedTo: 'u9' })
      )
    );
  });

  /**
   * Optional on purpose: a manager taking an order over the phone should be
   * able to record it before deciding who works it. Null rather than omitted,
   * so "deliberately unassigned" is explicit rather than inferred.
   */
  it('can be left blank, and says so', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(await screen.findByText(/leave blank if you have not decided/i)).toBeInTheDocument();

    await fillOrder(user);
    await user.click(screen.getByRole('button', { name: /create order/i }));

    await waitFor(() =>
      expect(ordersApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ assignedTo: null })
      )
    );
  });

  it('can undo a choice back to unassigned', async () => {
    const user = userEvent.setup();
    renderForm();

    await pickFrom(user, await screen.findByLabelText(/assign to/i), 'sara', 'Sara Iqbal');
    await user.click(screen.getByRole('button', { name: /leave unassigned/i }));

    await fillOrder(user);
    await user.click(screen.getByRole('button', { name: /create order/i }));

    await waitFor(() =>
      expect(ordersApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ assignedTo: null })
      )
    );
  });

  /**
   * Not on the edit form. Changing it afterwards is reassignment, which lives
   * on the detail page with its own audit entry — offering it here too would be
   * a second way to do the same thing with different consequences.
   */
  it('is absent when editing an existing order', async () => {
    ordersApi.get.mockResolvedValue({
      _id: '650000000000000000000001',
      orderNumber: 'ORD-000009',
      status: 'pending',
      customer: CUSTOMER,
      items: [{ _id: 'i1', quantity: 1, priceAtOrder: 10, product: WIDGET }],
    });

    renderWithProviders(<OrderForm />, {
      route: '/orders/650000000000000000000001/edit',
      path: '/orders/:id/edit',
      guarded: true,
    });

    expect(await screen.findByRole('heading', { name: /edit ORD-000009/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/assign to/i)).not.toBeInTheDocument();
  });
});
