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

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";

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

/**
 * Deleting is not undoable, so it asks first — through the panel's ONE confirmation surface.
 *
 * This used to be a third hand-rolled modal. It only differed from `ConfirmDialog` in its dress
 * and in what it forgot: `aria-modal="true"` with no Tab containment, on a screen where every row
 * behind the overlay carries its own DEL button, so three Tabs landed on a DIFFERENT run's delete
 * control and Enter there opened a confirmation for the wrong run.
 */
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
  return (
    <ConfirmDialog
      title="Delete this run?"
      name={runId}
      confirmLabel="delete run"
      busyLabel="deleting…"
      // The destructive button must not be the one sitting under Return when the sheet opens.
      initialFocus="cancel"
      danger
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p className="mono text-[10.5px] tracking-[-0.04em] break-all text-fg">{runId}</p>
      <p>
        This permanently removes the run directory in <span className="mono text-[11px]">{ws}</span>{" "}
        — its manifest, its log and every artifact. Nothing else is touched: the repo, its history
        and every other run stay exactly as they are.
      </p>
      <p>
        <span className="font-medium text-fg">This cannot be undone.</span> Archive instead if you
        only want it out of the way.
      </p>
    </ConfirmDialog>
  );
}
