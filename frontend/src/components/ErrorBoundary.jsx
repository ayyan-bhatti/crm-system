import { Component } from 'react';
import { Link } from 'react-router-dom';
import { btnPrimary, btnSecondary } from '../ui';

/**
 * Catches render errors so one broken component cannot blank the whole app.
 *
 * WHY THIS IS NOT OPTIONAL
 *
 * React's behaviour on an uncaught render error is to unmount the ENTIRE tree.
 * Not the component that threw — everything. So a single `undefined.name` in a
 * table cell replaces the working application with a blank white page, with no
 * message, no navigation, and no way back except a manual reload. The user
 * cannot tell that from the site being down.
 *
 * WHY IT IS A CLASS
 *
 * `componentDidCatch` and `getDerivedStateFromError` have no hook equivalent —
 * this is the one place React still requires a class component, and it is worth
 * saying so rather than leaving it looking like legacy code nobody updated.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH
 *
 * Error boundaries only see errors thrown while RENDERING. They do not catch
 * errors in event handlers, in promises, or in async code — those need
 * try/catch where they happen, which is what the API layer already does. A
 * boundary is the last line, not the only one.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    /*
     * Logged, not swallowed.
     *
     * A boundary that shows a friendly message and reports nothing turns a
     * crash into a mystery: the user sees "something went wrong", the console
     * is empty, and nobody can reproduce it. In a deployment with error
     * tracking this is where the report would be sent.
     */
    // eslint-disable-next-line no-console
    console.error('[error-boundary] A render error was caught:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    const { children, title = 'Something went wrong', compact = false } = this.props;

    if (!error) return children;

    /*
     * `compact` is for a boundary around one panel rather than the whole page.
     * A dashboard chart that fails should leave the rest of the dashboard
     * usable — replacing the entire screen because one card broke is the same
     * over-reaction the boundary exists to prevent, just at a smaller scale.
     */
    if (compact) {
      return (
        <div className="rounded-lg border border-critical/25 bg-critical-wash px-4 py-5 text-center">
          <p className="text-sm font-medium text-critical-ink">{title}</p>
          <button
            type="button"
            className={`${btnSecondary} mt-3`}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }

    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          <h1 className="text-xl font-semibold text-ink">{title}</h1>
          <p className="mt-2 text-sm text-ink-2">
            This screen ran into an unexpected problem. Your data has not been changed.
          </p>

          {/*
            The message is shown in development only. In production it would be
            noise at best and a leak of internal detail at worst — but hiding it
            locally would make debugging needlessly hard.
          */}
          {import.meta.env.DEV && (
            <pre className="mt-4 overflow-x-auto rounded-lg bg-neutral-wash p-3 text-left text-xs text-ink-2">
              {error.message}
            </pre>
          )}

          <div className="mt-6 flex justify-center gap-3">
            {/*
              "Try again" re-renders the subtree. It genuinely helps when the
              error came from a transient state; when it does not, the user
              still has a way out rather than a dead end.
            */}
            <button
              type="button"
              className={btnPrimary}
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <Link to="/" className={btnSecondary} onClick={() => this.setState({ error: null })}>
              Back to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }
}
