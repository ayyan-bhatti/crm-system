import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ConfirmProvider, useConfirm } from './ConfirmDialog';

/**
 * The styled replacement for `window.confirm`. The one thing worth pinning
 * down beyond "it renders": the returned Promise actually resolves to what
 * the user clicked, since every call site depends on `await confirm(...)`
 * behaving exactly like the synchronous `window.confirm` it replaced.
 */

function Harness() {
  const confirm = useConfirm();
  const [result, setResult] = useState('');

  async function ask() {
    const ok = await confirm('Delete this thing?', { confirmLabel: 'Delete', tone: 'danger' });
    setResult(ok ? 'confirmed' : 'cancelled');
  }

  return (
    <div>
      <button onClick={ask}>Ask</button>
      <p>Result: {result || 'none'}</p>
    </div>
  );
}

function renderHarness() {
  return render(
    <ConfirmProvider>
      <Harness />
    </ConfirmProvider>
  );
}

describe('ConfirmDialog', () => {
  it('resolves true when the confirming button is clicked', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Delete this thing?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Result: confirmed')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('resolves false when Cancel is clicked', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('Result: cancelled')).toBeInTheDocument();
  });

  it('resolves false on Escape', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await user.keyboard('{Escape}');

    expect(await screen.findByText('Result: cancelled')).toBeInTheDocument();
  });

  it('resolves false when the backdrop is clicked', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    // The backdrop is the outermost element the dialog itself is rendered
    // inside — clicking the dialog's own content must NOT trigger this (see
    // the next test), so this targets the dialog's parent.
    const dialog = screen.getByRole('alertdialog');
    await user.click(dialog.parentElement);

    expect(await screen.findByText('Result: cancelled')).toBeInTheDocument();
  });

  it('does not cancel when clicking inside the dialog itself', async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await user.click(screen.getByText('Delete this thing?'));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Result: none')).toBeInTheDocument();
  });

  it('throws if useConfirm is used outside the provider', () => {
    function Bare() {
      useConfirm();
      return null;
    }

    // Suppress React's expected error-boundary console noise for this one.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/useConfirm must be used inside/);
    spy.mockRestore();
  });
});
