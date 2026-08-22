"use client";

import { useEffect, useRef } from "react";

/**
 * The panel's one confirmation dialog (T21): used by the run table's Delete/Archive buttons and
 * by the settings page's "forget this workspace".
 *
 * Not `window.confirm`. Two reasons, and neither is decoration: T21 requires the dialog to state
 * *exactly* what will happen ("removes the entry from workspaces.json ONLY", "run <runId>"), and
 * a native confirm cannot show a busy state or the server's error — a failed delete would close
 * the dialog and look like a success. This one stays open, shows what the route answered, and is
 * the thing the acceptance screenshots can actually show.
 *
 * Keyboard behaviour is the part people notice when it is missing: ESC cancels, focus moves to
 * the confirm button on open, and Tab is trapped between the two buttons so a keyboard user
 * cannot end up typing into the page behind the overlay.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy = false,
  error = null,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      // Two focusable elements, so the trap is just "bounce between them".
      const first = confirmRef.current;
      const last = cancelRef.current;
      if (first === null || last === null) return;
      event.preventDefault();
      (document.activeElement === first ? last : first).focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4"
      // A click on the backdrop cancels; a click inside the panel must not bubble out to it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        // `whitespace-normal` is not decoration: this dialog is rendered from inside whatever
        // component opened it — a table cell, a form row — and `white-space` inherits straight
        // through `position: fixed`. One `whitespace-nowrap` ancestor turns the whole explanation
        // into a single line running off the side of the panel.
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-line bg-surface p-4 whitespace-normal shadow-lg"
      >
        <h2 id="confirm-title" className="text-sm font-semibold text-fg">
          {title}
        </h2>
        <div className="flex flex-col gap-2 text-sm text-muted">{children}</div>

        {error !== null ? (
          <p className="rounded border border-line bg-error-bg px-3 py-2 text-xs text-error-fg">
            {error}
          </p>
        ) : null}

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-line bg-surface-2 px-3 py-1.5 text-sm text-fg transition-colors hover:border-link disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
              danger
                ? "border-error-fg bg-error-bg text-error-fg hover:brightness-95"
                : "border-link bg-surface-2 text-fg hover:border-link"
            }`}
          >
            {busy ? "working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
