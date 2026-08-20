import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Toast notifications.
 *
 * WHAT THIS REPLACES
 *
 * Every screen previously kept its own `notice` and `error` state and rendered
 * its own banner. That worked, and it produced three problems: the same action
 * was confirmed differently on different screens, a confirmation was invisible
 * if it happened below the fold, and a message rendered by a page vanished the
 * instant that page navigated away — which is exactly what "Customer deleted"
 * does, since deleting sends you back to the list.
 *
 * A toast lives above the routes, so it survives the navigation that caused it.
 *
 * ACCESSIBILITY IS THE POINT, NOT A DETAIL
 *
 * A toast is the one piece of UI that appears without the user doing anything
 * at the place they are looking. If it is only visual, a screen-reader user
 * gets no confirmation that their action worked at all. So the region is
 * `aria-live` — `assertive` for errors, which interrupt, and `polite` for
 * successes, which wait for a pause rather than talking over whatever is being
 * read.
 */

const ToastContext = createContext(null);

/** How long each kind stays. */
export const DURATIONS = {
  // Long enough to read, short enough not to sit in the way.
  success: 4000,
  info: 4000,
  /*
   * Errors stay noticeably longer. A success is a confirmation of something the
   * user already knows they did; an error is news, often with a detail worth
   * reading twice, and losing it after four seconds means asking them to redo
   * the action just to see the message again.
   */
  error: 8000,
};

let nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  // Timers are tracked so they can be cleared on unmount — a pending timeout
  // firing into an unmounted tree is a warning at best and a leak at worst.
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));

    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (message, { type = 'success', duration } = {}) => {
      if (!message) return null;

      const id = (nextId += 1);
      setToasts((current) => [...current, { id, message, type }]);

      const timer = setTimeout(() => dismiss(id), duration ?? DURATIONS[type] ?? DURATIONS.info);
      timers.current.set(id, timer);

      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const value = useMemo(
    () => ({
      show,
      dismiss,
      // Named helpers so call sites read as intent rather than configuration.
      success: (message, options) => show(message, { ...options, type: 'success' }),
      error: (message, options) => show(message, { ...options, type: 'error' }),
      info: (message, options) => show(message, { ...options, type: 'info' }),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

const STYLES = {
  success: 'border-good/30 bg-good-wash text-good-ink',
  error: 'border-critical/30 bg-critical-wash text-critical-ink',
  info: 'border-brand/30 bg-brand-wash text-brand-ink',
};

function ToastViewport({ toasts, onDismiss }) {
  return (
    <>
      {/*
        Two regions rather than one, because the politeness setting is a
        property of the region and not of the individual message. Mixing an
        assertive error into a polite region would announce it late; the reverse
        would interrupt for a routine confirmation.
      */}
      <Region toasts={toasts.filter((t) => t.type === 'error')} politeness="assertive" onDismiss={onDismiss} />
      <Region toasts={toasts.filter((t) => t.type !== 'error')} politeness="polite" onDismiss={onDismiss} />
    </>
  );
}

function Region({ toasts, politeness, onDismiss }) {
  return (
    <div
      // `pointer-events-none` on the stack, re-enabled per toast, so the empty
      // area does not swallow clicks on the page underneath it.
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end"
      role="status"
      aria-live={politeness}
      aria-atomic="false"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 shadow-lift ${
            STYLES[toast.type] || STYLES.info
          }`}
        >
          <p className="flex-1 text-sm font-medium">{toast.message}</p>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="text-current opacity-60 transition-opacity hover:opacity-100"
            aria-label="Dismiss notification"
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4 fill-current" aria-hidden="true">
              <path d="M6 5.3L10 9.3l4-4L15.7 7l-4 4 4 4-1.7 1.7-4-4-4 4L4.3 15l4-4-4-4L6 5.3z" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a <ToastProvider>');
  return context;
}
