import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import CommandPalette, { openCommandPalette } from './CommandPalette';
import { renderWithProviders, fakeUser } from '../test/utils';
import { authApi, customersApi, productsApi } from '../api/resources';

/**
 * The Cmd/Ctrl+K palette. Every route it jumps to already exists — this is a
 * navigation layer, so what's worth pinning is that the shortcut opens it,
 * search results are scoped by permission (a rep gets no customer search,
 * exactly as the customer picker components already enforce), and selecting
 * a result actually navigates.
 */
vi.mock('../api/resources', () => ({
  authApi: { login: vi.fn(), register: vi.fn(), logout: vi.fn(), me: vi.fn() },
  customersApi: { options: vi.fn() },
  productsApi: { options: vi.fn() },
}));

function renderPalette(role = 'admin') {
  authApi.me.mockResolvedValue(fakeUser({ role }));
  return renderWithProviders(
    <Routes>
      <Route
        path="/crm"
        element={
          <>
            <CommandPalette />
            <p>DASHBOARD PAGE</p>
          </>
        }
      />
      <Route path="/crm/customers/:id" element={<p>CUSTOMER DETAIL PAGE</p>} />
      <Route path="/crm/orders/new" element={<p>NEW ORDER PAGE</p>} />
    </Routes>,
    { route: '/crm', guarded: true }
  );
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customersApi.options.mockResolvedValue([]);
    productsApi.options.mockResolvedValue([]);
  });

  it('is closed until Cmd/Ctrl+K is pressed, and Escape closes it again', async () => {
    const user = userEvent.setup();
    renderPalette();
    await screen.findByText('DASHBOARD PAGE');

    expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument();

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByRole('dialog', { name: /command palette/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /command palette/i })).not.toBeInTheDocument()
    );
  });

  it('can also be opened programmatically, e.g. by the sidebar trigger', async () => {
    renderPalette();
    await screen.findByText('DASHBOARD PAGE');

    openCommandPalette();

    expect(await screen.findByRole('dialog', { name: /command palette/i })).toBeInTheDocument();
  });

  it('navigates to a customer selected from the search results', async () => {
    const user = userEvent.setup();
    customersApi.options.mockResolvedValue([{ _id: 'cust-1', name: 'Bilal Ahmed', email: 'bilal@example.com' }]);

    renderPalette('admin');
    await screen.findByText('DASHBOARD PAGE');
    openCommandPalette();

    const input = await screen.findByRole('combobox', { name: /search pages/i });
    await user.type(input, 'Bilal');

    const option = await screen.findByRole('option', { name: /Bilal Ahmed/i });
    await user.click(option);

    expect(await screen.findByText('CUSTOMER DETAIL PAGE')).toBeInTheDocument();
  });

  it('never searches customers for a sales rep, who has no customer access', async () => {
    const user = userEvent.setup();
    renderPalette('sales_rep');
    await screen.findByText('DASHBOARD PAGE');
    openCommandPalette();

    const input = await screen.findByRole('combobox', { name: /search pages/i });
    await user.type(input, 'anything');

    await waitFor(() => expect(productsApi.options).toHaveBeenCalled());
    expect(customersApi.options).not.toHaveBeenCalled();
  });

  it('offers "Create order" as a quick action and navigates there', async () => {
    const user = userEvent.setup();
    renderPalette('admin');
    await screen.findByText('DASHBOARD PAGE');
    openCommandPalette();

    const action = await screen.findByRole('option', { name: /create order/i });
    await user.click(action);

    expect(await screen.findByText('NEW ORDER PAGE')).toBeInTheDocument();
  });
});
