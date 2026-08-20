import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DURATIONS, ToastProvider, useToast } from './Toast';

/**
 * Toast notifications.
 *
 * Two things are worth testing here, and the second is the one that usually
 * gets skipped: that messages appear and clear, and that they are ANNOUNCED. A
 * toast is the one piece of UI that appears without the user acting, at the
 * place they happen to be looking — if it is only visual, a screen-reader user
 * gets no confirmation their action worked at all.
 */

/** A component exposing the toast API as buttons. */
function Harness() {
  const toast = useToast();

  return (
    <>
      <button type="button" onClick={() => toast.success('Saved successfully')}>
        raise success
      </button>
      <button type="button" onClick={() => toast.error('Could not save')}>
        raise error
      </button>
      <button type="button" onClick={() => toast.info('Just so you know')}>
        raise info
      </button>
      {/* An explicit short duration, so the expiry can be observed without
          faking timers — see the note on the test that uses it. */}
      <button type="button" onClick={() => toast.success('Briefly here', { duration: 50 })}>
        raise brief
      </button>
    </>
  );
}

const renderToasts = () =>
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>
  );

describe('Toast', () => {
  it('shows a success message', async () => {
    const user = userEvent.setup();
    renderToasts();

    await user.click(screen.getByRole('button', { name: /raise success/i }));

    expect(await screen.findByText('Saved successfully')).toBeInTheDocument();
  });

  it('shows several messages at once rather than replacing them', async () => {
    const user = userEvent.setup();
    renderToasts();

    await user.click(screen.getByRole('button', { name: /raise success/i }));
    await user.click(screen.getByRole('button', { name: /raise error/i }));

    expect(await screen.findByText('Saved successfully')).toBeInTheDocument();
    expect(screen.getByText('Could not save')).toBeInTheDocument();
  });

  it('can be dismissed by hand', async () => {
    const user = userEvent.setup();
    renderToasts();

    await user.click(screen.getByRole('button', { name: /raise success/i }));
    await screen.findByText('Saved successfully');

    await user.click(screen.getByRole('button', { name: /dismiss notification/i }));

    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  /**
   * Expiry, observed rather than simulated.
   *
   * An earlier version of this used fake timers, which did not take effect
   * under userEvent's own scheduler and made the test wait out the real four
   * seconds before failing. Raising a toast with an explicit 50ms lifetime
   * tests the same mechanism in a fraction of the time and with no
   * timer-mocking subtleties to get wrong.
   */
  it('clears itself after its lifetime', async () => {
    const user = userEvent.setup();
    renderToasts();

    await user.click(screen.getByRole('button', { name: /raise brief/i }));
    expect(await screen.findByText('Briefly here')).toBeInTheDocument();

    await waitFor(() => expect(screen.queryByText('Briefly here')).not.toBeInTheDocument());
  });

  /**
   * Errors stay noticeably longer than successes. A success confirms something
   * the user already knows they did; an error is news, often with a detail
   * worth reading twice, and losing it early means redoing the action just to
   * read the message.
   *
   * Asserted against the configured policy rather than by waiting eight real
   * seconds — the durations are the decision, and this is what pins it.
   */
  it('keeps an error on screen longer than a success', () => {
    expect(DURATIONS.error).toBeGreaterThan(DURATIONS.success);
    expect(DURATIONS.error).toBeGreaterThan(DURATIONS.info);
  });

  describe('announcements', () => {
    /**
     * Two regions, because politeness is a property of the REGION, not of the
     * message. An assertive error in a polite region is announced late; a
     * polite success in an assertive one interrupts whatever is being read.
     */
    it('announces errors assertively and everything else politely', async () => {
      const user = userEvent.setup();
      const { container } = renderToasts();

      await user.click(screen.getByRole('button', { name: /raise error/i }));
      await user.click(screen.getByRole('button', { name: /raise success/i }));

      const assertive = container.querySelector('[aria-live="assertive"]');
      const polite = container.querySelector('[aria-live="polite"]');

      expect(assertive).toHaveTextContent('Could not save');
      expect(polite).toHaveTextContent('Saved successfully');
      expect(assertive).not.toHaveTextContent('Saved successfully');
    });

    it('gives the dismiss control an accessible name', async () => {
      const user = userEvent.setup();
      renderToasts();

      await user.click(screen.getByRole('button', { name: /raise info/i }));

      expect(
        await screen.findByRole('button', { name: /dismiss notification/i })
      ).toBeInTheDocument();
    });
  });

  it('ignores an empty message rather than flashing a blank box', async () => {
    function EmptyHarness() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast.success('')}>
          raise nothing
        </button>
      );
    }

    const user = userEvent.setup();
    const { container } = render(
      <ToastProvider>
        <EmptyHarness />
      </ToastProvider>
    );

    await user.click(screen.getByRole('button', { name: /raise nothing/i }));

    await waitFor(() =>
      expect(container.querySelectorAll('[aria-label="Dismiss notification"]')).toHaveLength(0)
    );
  });

  it('fails loudly when used outside its provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    function Orphan() {
      useToast();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(/must be used inside/i);

    consoleError.mockRestore();
  });
});
