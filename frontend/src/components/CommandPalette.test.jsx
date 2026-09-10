import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
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

/**
 * `openCommandPalette()` dispatches a raw `window` event — outside React's
 * own event system, so the `setOpen(true)` it triggers is not automatically
 * wrapped in `act()` the way a `user-event` interaction's would be. The
 * ASYNC overload of `act()`, not the sync one, is what actually matters
 * here: the sync overload only guarantees synchronous updates are flushed,
 * but React can still defer the effect/paint work behind a microtask, and a
 * bare `act(() => {...})` returns before that microtask runs. `await
 * act(async () => {...})` waits out that microtask queue too, so the caller
 * only gets control back once the dialog has genuinely committed to the
 * DOM — removing the need to poll for it at all, rather than polling for it
 * for longer.
 */
async function openPalette() {
  await act(async () => {
    openCommandPalette();
  });
}

/*
 * Even with that flush, the project-wide `asyncUtilTimeout` (5000ms, set in
 * src/test/setup.js) is still an arbitrary constant, not a real correctness
 * boundary — and this suite runs its 36 files across parallel workers, so
 * every file is sharing CPU with the rest of them (worse under CI's shared
 * runners than on an idle machine). A real component bug shows up as "never
 * found"; this class of failure is "found, eventually, just past an
 * arbitrary clock" — distinguishable by the fact the same assertion passes
 * reliably in isolation, which these four did, repeatedly, before failing
 * only as part of the full 36-file run in CI (see the "Pivot the
 * catalogue…" build).
 *
 * 10000ms rather than the global 5000ms default, and deliberately still
 * below this file's `testTimeout: 15000` (see vite.config.js's own comment
 * on why that gap exists) — the outer test timeout must fire only for an
 * assertion that was truly never going to pass, not race this one to the
 * same instant and produce a less diagnosable failure.
 */
const PALETTE_TIMEOUT = { timeout: 10000 };

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

    await openPalette();

    expect(
      await screen.findByRole('dialog', { name: /command palette/i }, PALETTE_TIMEOUT)
    ).toBeInTheDocument();
  });

  it('navigates to a customer selected from the search results', async () => {
    const user = userEvent.setup();
    customersApi.options.mockResolvedValue([{ _id: 'cust-1', name: 'Bilal Ahmed', email: 'bilal@example.com' }]);

    renderPalette('admin');
    await screen.findByText('DASHBOARD PAGE');
    await openPalette();

    const input = await screen.findByRole('combobox', { name: /search pages/i }, PALETTE_TIMEOUT);
    await user.type(input, 'Bilal');

    const option = await screen.findByRole('option', { name: /Bilal Ahmed/i });
    await user.click(option);

    expect(await screen.findByText('CUSTOMER DETAIL PAGE')).toBeInTheDocument();
  });

  it('never searches customers for a sales rep, who has no customer access', async () => {
    const user = userEvent.setup();
    renderPalette('sales_rep');
    await screen.findByText('DASHBOARD PAGE');
    await openPalette();

    const input = await screen.findByRole('combobox', { name: /search pages/i }, PALETTE_TIMEOUT);
    await user.type(input, 'anything');

    await waitFor(() => expect(productsApi.options).toHaveBeenCalled());
    expect(customersApi.options).not.toHaveBeenCalled();
  });

  it('offers "Create order" as a quick action and navigates there', async () => {
    const user = userEvent.setup();
    renderPalette('admin');
    await screen.findByText('DASHBOARD PAGE');
    await openPalette();

    const action = await screen.findByRole('option', { name: /create order/i }, PALETTE_TIMEOUT);
    await user.click(action);

    expect(await screen.findByText('NEW ORDER PAGE')).toBeInTheDocument();
  });
});
