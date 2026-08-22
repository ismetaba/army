"use client";

/**
 * `ARCH` / `DEL` on a ledger row, and `RESTORE` on an archived one (handoff § 02, § Interactions).
 *
 * The only client component inside the table. It holds nothing but "which confirmation is open":
 * the rows themselves stay server-rendered from the store, and after a mutation `router.refresh()`
 * re-runs that render rather than this component patching a list it does not own — which matters
 * because a CLI run can add or finish a run while the page is open.
 *
 * Both routes are the existing ones, unchanged: `POST /api/runs/archive?ws=&run=[&action=restore]`
 * renames the directory between `runs/` and `archive/`, and `DELETE /api/runs?ws=&run=` removes it.
 * Deleting is not undoable, so it asks first — and says what it will take with it.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Action = "archive" | "delete" | "restore";

export function RowActions({
  ws,
  runId,
  area,
  compact = false,
}: {
  ws: string;
  runId: string;
  area: "runs" | "archive";
  /** The 375 layout spells the words out and gives every target 44px. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: Action) {
    setBusy(true);
    setError(null);
    const q = new URLSearchParams({ ws, run: runId });
    if (action === "restore") q.set("action", "restore");
    const url = action === "delete" ? `/api/runs?${q}` : `/api/runs/archive?${q}`;
    try {
      const response = await fetch(url, { method: action === "delete" ? "DELETE" : "POST" });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setError(body?.message ?? `the request failed (HTTP ${response.status})`);
        return;
      }
      setOpen(null);
      router.refresh();
    } catch {
      setError("the panel could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  const size = compact
    ? "mono flex min-h-11 items-center text-[8.5px] tracking-[0.04em]"
    : "mono text-[9px] tracking-[0.04em]";

  return (
    <div className={`flex gap-3 ${compact ? "" : "justify-end"}`}>
      {area === "runs" ? (
        <>
          {/* Archiving is a rename and is reversible, so it acts on the first click. */}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("archive")}
            data-row-archive={runId}
            className={`${size} text-ink-3 transition-colors duration-[180ms] hover:text-fg disabled:opacity-40`}
          >
            {compact ? "ARCHIVE" : "ARCH"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setOpen("delete")}
            data-row-delete={runId}
            className={`${size} text-ink-3 transition-colors duration-[180ms] hover:text-danger disabled:opacity-40`}
          >
            {compact ? "DELETE" : "DEL"}
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("restore")}
          data-row-restore={runId}
          className={`${size} text-ink-3 transition-colors duration-[180ms] hover:text-fg disabled:opacity-40`}
        >
          RESTORE
        </button>
      )}

      {error !== null && open === null ? (
        <span className="mono text-[9px] text-danger">{error}</span>
      ) : null}

      {open === "delete" ? (
        <ConfirmDelete
          ws={ws}
          runId={runId}
          busy={busy}
          error={error}
          onCancel={() => {
            if (!busy) {
              setOpen(null);
              setError(null);
            }
          }}
          onConfirm={() => void run("delete")}
        />
      ) : null}
    </div>
  );
}

function ConfirmDelete({
  ws,
  runId,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  ws: string;
  runId: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    sheet.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const back = opener.current;
      if (back instanceof HTMLElement) back.focus();
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/80 p-4 text-left"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label={`Delete run ${runId}`}
        data-confirm-delete={runId}
        className="shadow-slip-center flex w-[460px] max-w-full flex-col border border-rule-2 bg-surface"
      >
        <div className="border-b-2 border-fg px-6 py-4">
          <h2 className="text-[17px] font-medium tracking-[-0.02em]">Delete this run?</h2>
        </div>
        <div className="flex flex-col gap-3 px-6 py-5">
          <p className="mono text-[10.5px] tracking-[-0.04em] break-all">{runId}</p>
          <p className="text-[13px] leading-[1.55] text-ink-2">
            This permanently removes the run directory in <span className="mono text-[11px]">{ws}</span> — its
            manifest, its log and every artifact. Nothing else is touched: the repo, its history and
            every other run stay exactly as they are.
          </p>
          <p className="text-[13px] leading-[1.55] text-ink-2">
            <span className="font-medium text-fg">This cannot be undone.</span> Archive instead if
            you only want it out of the way.
          </p>
          {error !== null ? (
            <p className="border-l-2 border-danger bg-danger-tint px-3 py-2 text-[11px] text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-5 border-t border-line px-6 py-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btnlabel flex min-h-11 items-center px-1 text-ink-3 transition-colors duration-[180ms] hover:text-fg disabled:opacity-40 min-[900px]:min-h-0"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            data-confirm-delete-go
            className="btnlabel min-h-11 border border-danger px-4 py-2.5 text-danger transition-colors duration-[180ms] hover:bg-danger hover:text-bg disabled:opacity-40 min-[900px]:min-h-0"
          >
            {busy ? "deleting…" : "delete run"}
          </button>
        </div>
      </div>
    </div>
  );
}
