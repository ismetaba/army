"use client";

import { useEffect, useRef } from "react";
import { useModalKeys } from "@/components/ledger/modal-focus";

/**
 * The panel's one confirmation surface (T21): used by settings' "forget this workspace".
 *
 * Not `window.confirm`. Two reasons, and neither is decoration: T21 requires the dialog to state
 * *exactly* what will happen ("removes the entry from workspaces.json ONLY", "run <runId>"), and
 * a native confirm cannot show a busy state or the server's error — a failed delete would close
 * the dialog and look like a success. This one stays open, shows what the route answered, and is
 * the thing the acceptance screenshots can actually show.
 *
 * Ledger dress, since the rebuild: 0 radius, a paper wash rather than a black scrim, a 1px
 * `rule-2` border with the one blessed centred-slip shadow, and mono button labels — the same
 * surface the ledger's delete confirmation draws, because two confirmations that look like
 * different products is exactly what the rebuild was for. Handoff § Geometry: "Radius: 0
 * everywhere", "No shadows except two docked surfaces … and the centred create-task slip".
 *
 * Keyboard behaviour is the part people notice when it is missing, and it is the shared one now
 * (`useModalKeys`): ESC cancels, Tab is contained, and focus goes back to whatever opened the
 * dialog when it closes — which this component used to skip, dropping focus on `<body>`.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busyLabel = "working…",
  name,
  initialFocus = "confirm",
  busy = false,
  error = null,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  /** Replaces the confirm label while the action is in flight. */
  busyLabel?: string;
  /** What this dialog is about (a run id, a workspace name) — the `data-confirm-dialog` hook. */
  name?: string;
  /** Which button opens focused. The ledger's delete confirmation opens on `cancel`. */
  initialFocus?: "confirm" | "cancel";
  busy?: boolean;
  error?: string | null;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useModalKeys(sheet, onCancel);

  useEffect(() => {
    (initialFocus === "cancel" ? cancelRef : confirmRef).current?.focus();
  }, [initialFocus]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-canvas/80 p-4 text-left"
      // A click on the backdrop cancels; a click inside the panel must not bubble out to it.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={sheet}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        data-confirm-dialog={name ?? ""}
        // `whitespace-normal` is not decoration: this dialog is rendered from inside whatever
        // component opened it — a table cell, a form row — and `white-space` inherits straight
        // through `position: fixed`. One `whitespace-nowrap` ancestor turns the whole explanation
        // into a single line running off the side of the panel.
        className="shadow-slip-center flex w-[460px] max-w-full flex-col border border-rule-2 bg-surface whitespace-normal"
      >
        <div className="border-b-2 border-fg px-6 py-4">
          <h2 id="confirm-title" className="text-[17px] font-medium tracking-[-0.02em]">
            {title}
          </h2>
        </div>

        <div className="flex flex-col gap-3 px-6 py-5 text-[13px] leading-[1.55] text-ink-2">
          {children}
        </div>

        {error !== null ? (
          <p className="mx-6 mb-5 border-l-2 border-danger bg-danger-tint px-3 py-2 text-[11px] text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-5 border-t border-line px-6 py-4">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btnlabel flex min-h-11 items-center px-1 text-ink-3 transition-colors duration-[180ms] hover:text-fg disabled:opacity-40 min-[900px]:min-h-0"
          >
            cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-confirm-dialog-go
            className={`btnlabel min-h-11 border px-4 py-2.5 transition-colors duration-[180ms] disabled:opacity-40 min-[900px]:min-h-0 ${
              danger
                ? "border-danger text-danger hover:bg-danger hover:text-bg"
                : "border-rule-2 text-ink-2 hover:border-fg hover:text-fg"
            }`}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
