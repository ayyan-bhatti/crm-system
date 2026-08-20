import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary';

/**
 * The error boundary.
 *
 * React unmounts the ENTIRE tree on an uncaught render error, so the thing
 * being tested is that a broken component leaves the user with a message and a
 * way out rather than a blank page.
 */

/** A component that throws on demand. */
function Boom({ shouldThrow = true }) {
  if (shouldThrow) throw new Error('deliberate test explosion');
  return <p>Recovered content</p>;
}

const renderBoundary = (ui, props = {}) =>
  render(
    <MemoryRouter>
      <ErrorBoundary {...props}>{ui}</ErrorBoundary>
    </MemoryRouter>
  );

describe('ErrorBoundary', () => {
  /*
   * React logs caught render errors to console.error regardless of the
   * boundary, and jsdom prints the whole component stack. Silenced so a passing
   * test run is readable — but only for these tests, and restored afterwards,
   * so a real unexpected error elsewhere still shows up.
   */
  let consoleError;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders its children when nothing goes wrong', () => {
    renderBoundary(<p>Everything is fine</p>);

    expect(screen.getByText('Everything is fine')).toBeInTheDocument();
  });

  it('shows a message instead of a blank page when a child throws', () => {
    renderBoundary(<Boom />);

    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  /**
   * The reassurance matters: a crash while looking at a form should not leave
   * someone wondering whether it half-saved.
   */
  it('tells the user their data was not changed', () => {
    renderBoundary(<Boom />);

    expect(screen.getByText(/has not been changed/i)).toBeInTheDocument();
  });

  it('offers a way out rather than a dead end', () => {
    renderBoundary(<Boom />);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to dashboard/i })).toBeInTheDocument();
  });

  /**
   * Logged rather than swallowed. A boundary that shows a friendly message and
   * reports nothing turns a crash into a mystery nobody can reproduce.
   */
  it('logs the error for whoever has to diagnose it', () => {
    renderBoundary(<Boom />);

    expect(consoleError).toHaveBeenCalled();
    const logged = consoleError.mock.calls.flat().join(' ');
    expect(logged).toContain('deliberate test explosion');
  });

  it('recovers when "Try again" is pressed and the problem has passed', async () => {
    const user = userEvent.setup();

    /*
     * The failure is controlled from OUTSIDE the component rather than by a
     * "throw once" flag inside it. React re-invokes a failing render in
     * development, so a self-clearing flag flips on that retry and the
     * component recovers before the boundary's message can even be asserted —
     * the test then fails for a reason that has nothing to do with the
     * boundary.
     */
    let shouldThrow = true;
    function MaybeBroken() {
      if (shouldThrow) throw new Error('transient');
      return <p>Recovered content</p>;
    }

    renderBoundary(<MaybeBroken />);
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();

    // The underlying problem goes away, then the user retries.
    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });

  /**
   * `compact` is for a boundary around one panel. Replacing the whole screen
   * because a single dashboard card broke is the same over-reaction the
   * boundary exists to prevent, at a smaller scale.
   */
  describe('compact mode', () => {
    it('renders an inline message rather than taking over the page', () => {
      renderBoundary(<Boom />, { compact: true, title: 'This chart could not load' });

      expect(screen.getByText('This chart could not load')).toBeInTheDocument();
      // No full-page furniture.
      expect(screen.queryByRole('link', { name: /back to dashboard/i })).not.toBeInTheDocument();
    });

    it('still offers a retry', () => {
      renderBoundary(<Boom />, { compact: true });

      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });
  });
});
