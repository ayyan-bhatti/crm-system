import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { btnDanger, btnPrimary, btnSecondary } from '../ui';

/**
 * A styled replacement for `window.confirm`, with the same call shape on
 * purpose: `await confirm('Delete this order?')` resolves to `true`/`false`,
 * so every existing `if (!window.confirm(msg)) return;` call site becomes
 * `if (!(await confirm(msg))) return;` and nothing else about the calling
 * function has to change.
 *
 * WHY THIS EXISTS AT ALL
 *
 * `window.confirm` works, and every destructive action in this app already
 * used it. What it cannot do is match the rest of the interface — it is the
 * browser's own dialog, styled by the OS rather than by this app, and it
 * blocks the entire tab synchronously while it is open (no toast can appear
 * behind it, no other tab of a multi-tab session even repaints). Replacing
 * it is purely a consistency and polish move; the underlying rule — a
 * destructive action always asks first — is unchanged.
 *
 * ONE DIALOG AT A TIME, MODELLED AS A SINGLE PENDING REQUEST
 *
 * Same shape as `ToastProvider`: a context provider holds the current
 * request (or null), and `confirm()` returns a Promise whose resolver is
 * stashed until the dialog is answered. A second `confirm()` call while one
 * is already open replaces the pending request rather than queuing a second
 * dialog — two confirmation dialogs stacked on top of each other is a worse
 * problem than the one this solves.
 */

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [request, setRequest] = useState(null);
  const resolverRef = useRef(null);

  const confirm = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      // A pending dialog that never gets answered (the caller unmounted, or
      // a second confirm() pre-empted it) resolves false rather than hanging
      // forever — false is the safe default for "did the user agree".
      if (resolverRef.current) resolverRef.current(false);
      resolverRef.current = resolve;
      setRequest({ message, ...options });
    });
  }, []);

  const settle = useCallback((result) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setRequest(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {request && (
        <ConfirmDialog
          {...request}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * @returns {(message: string, options?: { title?: string, confirmLabel?: string, cancelLabel?: string, tone?: 'default'|'danger' }) => Promise<boolean>}
 */
export function useConfirm() {
  const context = useContext(ConfirmContext);
  if (!context) throw new Error('useConfirm must be used inside a <ConfirmProvider>');
  return context;
}

function ConfirmDialog({
  message,
  title = 'Are you sure?',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  // Focus lands on the CONFIRMING button, not the cancelling one — matching
  // `window.confirm`, where Enter agrees. A destructive dialog gets the same
  // default rather than a safer-looking focus on Cancel, because the button
  // itself already carries the warning colour and label; defaulting focus
  // away from it would just make a deliberate click take two attempts.
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKey(event) {
      if (event.key === 'Escape') onCancel();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        className="w-full max-w-sm rounded-xl border border-hairline bg-surface p-5 shadow-lift"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-ink">
          {title}
        </h2>
        <p id="confirm-dialog-message" className="mt-2 text-sm text-ink-2">
          {message}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnSecondary} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === 'danger' ? btnDanger : btnPrimary}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
