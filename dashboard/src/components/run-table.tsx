import Link from "next/link";
import type { RunArea, RunManifest } from "@/lib/store";
import { formatDuration, formatWhen } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { RunActions } from "@/components/run-actions";

/**
 * The run list, shared by `/` (latest across workspaces) and `/ws/[ws]` (one workspace).
 *
 * The table is wide by design — seven columns of facts you scan vertically — so it lives inside
 * its own `overflow-x-auto` box. That box is what keeps a 375px window from scrolling the whole
 * page sideways: the table scrolls, the page does not. `min-w-0` on the wrapper is required for
 * that to work inside a flex/grid parent, where the default `min-width: auto` would let the
 * table push its container wider instead of overflowing it.
 *
 * T21 adds an optional last column of per-row actions. It is opt-in (`actions`), and home does
 * NOT opt in: the "latest runs" table spans workspaces and is a glance surface, not a place to
 * be one misclick from deleting a run you were only looking at.
 */
export function RunTable({
  runs,
  showWorkspace = false,
  empty = "No runs yet.",
  actions = null,
  linkRuns = true,
}: {
  runs: RunManifest[];
  showWorkspace?: boolean;
  empty?: string;
  /** Which directory these rows live in; `null` renders the table read-only (T21 step 3). */
  actions?: RunArea | null;
  /**
   * Archived runs are not linked: `/ws/[ws]/run/[id]` reads `runs/`, so a link to an archived
   * run answers 404. Showing the id as plain text says "it is still here, just not open" instead
   * of sending the reader to a not-found page.
   */
  linkRuns?: boolean;
}) {
  if (runs.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        {empty}
      </p>
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
      <table
        className={`w-full border-collapse text-sm ${actions === null ? "min-w-[46rem]" : "min-w-[56rem]"}`}
      >
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
            <th className="px-3 py-2 font-medium">Run</th>
            {showWorkspace ? <th className="px-3 py-2 font-medium">Workspace</th> : null}
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Agent</th>
            <th className="px-3 py-2 font-medium">Provider / model</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            {actions === null ? null : <th className="px-3 py-2 text-right font-medium">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={`${run.workspace}/${run.runId}`} className="border-b border-line last:border-0">
              <td className="px-3 py-2 whitespace-nowrap">
                {linkRuns ? (
                  <Link
                    href={`/ws/${encodeURIComponent(run.workspace)}/run/${encodeURIComponent(run.runId)}`}
                    className="font-mono text-link hover:underline"
                  >
                    {run.runId}
                  </Link>
                ) : (
                  <span className="font-mono text-muted">{run.runId}</span>
                )}
              </td>
              {showWorkspace ? (
                <td className="px-3 py-2">
                  <Link
                    href={`/ws/${encodeURIComponent(run.workspace)}`}
                    className="text-link hover:underline"
                  >
                    {run.workspace}
                  </Link>
                </td>
              ) : null}
              <td className="px-3 py-2 whitespace-nowrap">{run.kind}</td>
              <td className="px-3 py-2 whitespace-nowrap text-muted">{run.agent}</td>
              {/* The only cell allowed to wrap: model ids are long, they break at their hyphens,
                  and letting this one column reflow is what keeps the table inside a 1440px
                  window instead of pushing the duration column into the scroll box. */}
              <td className="px-3 py-2 text-muted">
                <span className="font-mono text-xs">
                  {run.provider}/{run.model}
                </span>
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={run.status} />
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-muted">{formatWhen(run.createdAt)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums text-muted">
                {formatDuration(run.durationMs)}
              </td>
              {actions === null ? null : (
                // No `whitespace-nowrap` here, unlike the other one-line cells: `RunActions`
                // renders its confirm dialog as a child of this cell, and `white-space` INHERITS
                // through `position: fixed` — the dialog's prose came out as one long line
                // spilling across the table. The buttons stay on one line by being flex items.
                <td className="px-3 py-2">
                  <RunActions ws={run.workspace} runId={run.runId} area={actions} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
