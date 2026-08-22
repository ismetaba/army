"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * Per-row Archive / Delete / Restore for the workspace run table (T21 step 3).
 *
 * The only client component in the run table, and it holds nothing but "which dialog is open".
 * The table itself stays a server component: the rows are rendered from the store on the server,
 * and after a mutation `router.refresh()` re-runs that render rather than the client patching a
 * list it does not own. One source of truth for what is in the store, which matters here because
 * a CLI run can add or finish a run while the page is open.
 *
 * `pending` covers both halves of the wait: the fetch, and the server re-render that follows it.
 * Without the `useTransition` half, the buttons come back to life while the table still shows the
 * row that was just deleted, and the obvious thing to do — click it again — produces a 404.
 */
type Pending = "archive" | "delete" | "restore" | null;

export function RunActions({
  ws,
  runId,
  area,
}: {
  ws: string;
  runId: string;
  /** `runs` rows offer Archive + Delete; `archive` rows offer Restore. */
  area: "runs" | "archive";
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const close = () => {
    if (busy) return;
    setOpen(null);
    setError(null);
  };

  async function run(action: Exclude<Pending, null>) {
    setBusy(true);
    setError(null);
    const q = new URLSearchParams({ ws, run: runId });
    if (action === "restore") q.set("action", "restore");
    const url = action === "delete" ? `/api/runs?${q}` : `/api/runs/archive?${q}`;
    try {
      const res = await fetch(url, { method: action === "delete" ? "DELETE" : "POST" });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        setError(body?.message ?? `request failed (${res.status})`);
        setBusy(false);
        return;
      }
      setOpen(null);
      startTransition(() => router.refresh());
    } catch {
      setError("the panel could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex justify-end gap-1.5">
      {area === "runs" ? (
        <>
          <ActionButton label="Archive" onClick={() => setOpen("archive")} />
          <ActionButton label="Delete" danger onClick={() => setOpen("delete")} />
        </>
      ) : (
        <ActionButton label="Restore" onClick={() => setOpen("restore")} />
      )}

      {open === "archive" ? (
        <ConfirmDialog
          title={`Archive run ${runId}?`}
          confirmLabel="Archive"
          busy={busy}
          error={error}
          onCancel={close}
          onConfirm={() => void run("archive")}
        >
          <p>
            The run directory moves from <code className="font-mono">runs/</code> to{" "}
            <code className="font-mono">archive/</code> in workspace{" "}
            <span className="font-mono">{ws}</span>. Nothing is deleted.
          </p>
          <p>
            It leaves this table and appears under <span className="font-mono">?archived=1</span>,
            where it can be restored.
          </p>
        </ConfirmDialog>
      ) : null}

      {open === "restore" ? (
        <ConfirmDialog
          title={`Restore run ${runId}?`}
          confirmLabel="Restore"
          busy={busy}
          error={error}
          onCancel={close}
          onConfirm={() => void run("restore")}
        >
          <p>
            The run directory moves back from <code className="font-mono">archive/</code> to{" "}
            <code className="font-mono">runs/</code> and reappears in the workspace run table.
          </p>
        </ConfirmDialog>
      ) : null}

      {open === "delete" ? (
        <ConfirmDialog
          title={`Delete run ${runId}?`}
          confirmLabel={`Delete ${runId}`}
          danger
          busy={busy}
          error={error}
          onCancel={close}
          onConfirm={() => void run("delete")}
        >
          <p>
            This permanently deletes the run directory of{" "}
            <span className="font-mono break-all">{runId}</span> in workspace{" "}
            <span className="font-mono">{ws}</span> — its{" "}
            <code className="font-mono">manifest.json</code>,{" "}
            <code className="font-mono">log.txt</code> and every artifact.
          </p>
          <p>
            Nothing else is touched: the repo, its history and every other run stay exactly as they
            are. <strong className="text-fg">This cannot be undone.</strong> Archive instead if you
            only want it out of the way.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 text-xs transition-colors ${
        danger
          ? "border-line text-error-fg hover:border-error-fg hover:bg-error-bg"
          : "border-line text-muted hover:border-link hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
