import Link from "next/link";
import type { RunManifest } from "@/lib/store";
import { formatDuration, formatWhen } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

/**
 * The run list, shared by `/` (latest across workspaces) and `/ws/[ws]` (one workspace).
 *
 * The table is wide by design — seven columns of facts you scan vertically — so it lives inside
 * its own `overflow-x-auto` box. That box is what keeps a 375px window from scrolling the whole
 * page sideways: the table scrolls, the page does not. `min-w-0` on the wrapper is required for
 * that to work inside a flex/grid parent, where the default `min-width: auto` would let the
 * table push its container wider instead of overflowing it.
 */
export function RunTable({
  runs,
  showWorkspace = false,
  empty = "No runs yet.",
}: {
  runs: RunManifest[];
  showWorkspace?: boolean;
  empty?: string;
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
      <table className="w-full min-w-[46rem] border-collapse text-sm">
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
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={`${run.workspace}/${run.runId}`} className="border-b border-line last:border-0">
              <td className="px-3 py-2 whitespace-nowrap">
                <Link
                  href={`/ws/${encodeURIComponent(run.workspace)}/run/${encodeURIComponent(run.runId)}`}
                  className="font-mono text-link hover:underline"
                >
                  {run.runId}
                </Link>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
