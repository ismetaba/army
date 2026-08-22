import Link from "next/link";
import { awHome, listRuns, listWorkspaceSummaries } from "@/lib/store";
import { formatAgo } from "@/lib/format";
import { RunTable } from "@/components/run-table";
import { RunPoller } from "@/components/run-poller";

/**
 * Home: what exists (workspaces) and what just happened (latest runs).
 *
 * `force-dynamic` because the store is a directory a CLI writes to behind the panel's back.
 * A cached page would show yesterday's runs after a fresh `aw review`, and the fix a user would
 * reach for — reload — would not help.
 */
export const dynamic = "force-dynamic";

const LATEST = 20;

export default async function HomePage() {
  const workspaces = listWorkspaceSummaries();
  const latest = listRuns().slice(0, LATEST);
  const totalRuns = workspaces.reduce((n, w) => n + w.runCount, 0);

  return (
    <div className="flex flex-col gap-8">
      {/* Across every workspace here, so a run started in one shows up while you are looking at
          another — and so home's table refreshes when it finishes (T22 step 3). */}
      <RunPoller />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight">Workspaces</h1>
          <p className="text-xs text-muted">
            store <span className="font-mono break-all">{awHome()}</span>
          </p>
        </div>

        {workspaces.length === 0 ? (
          <EmptyStore />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {workspaces.map((w) => {
              const body = (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-fg">{w.name}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {w.usable ? `${w.runCount} ${w.runCount === 1 ? "run" : "runs"}` : "unusable"}
                    </span>
                  </div>
                  <p className="font-mono text-xs break-all text-muted">
                    {w.repoRoot ?? "not in workspaces.json"}
                  </p>
                  <p className="mt-auto text-xs text-muted">
                    {w.usable
                      ? w.lastRunAt
                        ? `last run ${formatAgo(w.lastRunAt)}`
                        : "no runs yet"
                      : "name is not a valid directory segment — the CLI cannot use this workspace"}
                  </p>
                </>
              );
              return (
                <li key={w.name} className="min-w-0">
                  {/* A workspace whose name cannot be a directory has no page. It is still shown
                      — it IS in workspaces.json — but as plain text, because a link to it would
                      only ever 404 and send the reader hunting for a deleted workspace. */}
                  {w.usable ? (
                    <Link
                      href={`/ws/${encodeURIComponent(w.name)}`}
                      className="flex h-full flex-col gap-2 rounded-lg border border-line bg-surface p-4 transition-colors hover:border-link"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="flex h-full flex-col gap-2 rounded-lg border border-dashed border-line bg-surface p-4 opacity-70">
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Latest runs</h2>
          <p className="text-xs text-muted">
            {latest.length === totalRuns
              ? `${totalRuns} total`
              : `newest ${latest.length} of ${totalRuns}`}
          </p>
        </div>
        <RunTable
          runs={latest}
          showWorkspace
          empty="No runs recorded yet — run `npx tsx src/cli.ts review` in a workspace."
        />
      </section>
    </div>
  );
}

function EmptyStore() {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
      <p>
        Nothing in <span className="font-mono break-all">{awHome()}</span> yet.
      </p>
      <p className="mt-2">
        Register one with <span className="font-mono">npx tsx src/cli.ts init</span>, or point{" "}
        <span className="font-mono">AW_HOME</span> at an existing store.
      </p>
    </div>
  );
}
