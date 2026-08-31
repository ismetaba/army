import { EntryTopBar } from "@/components/ledger/chrome";
import { AddWorkspace } from "@/components/entry/add-workspace";
import { ContentsRow, type EntryRow } from "@/components/entry/contents";
import { EntryPoller } from "@/components/entry/entry-poller";
import { PROVIDER_IDS } from "@/lib/config-patch";
import { listRuns, listWorkspaceSummaries } from "@/lib/store";

/**
 * 01 · Entry — select a workspace (Glass § 01).
 *
 * The first of the flow's three levels: nothing else in the panel is reachable before a
 * workspace is chosen. A header row (`SELECT WORKSPACE`, the title, `⌘N add` on the right), a
 * three-column grid of frosted workspace cards, then the full-width dashed "Add workspace" pane.
 *
 * `force-dynamic` because the store is a directory the CLI writes to behind the panel's back: a
 * cached page would show yesterday's counts after a fresh `aw review`, and reloading — the fix a
 * reader would reach for — would not help.
 *
 * All filesystem access happens HERE. `@/lib/store` is node-only by construction (it imports
 * `node:fs`), and the only thing that crosses to the client is `EntryRow[]`, plain JSON. The slip
 * is the page's one client component and it talks to the store the way every other client
 * component in the panel does — through the API routes.
 */
export const dynamic = "force-dynamic";

/** Sparkline depth — the design draws five bars. */
const SPARK_RUNS = 5;

export default function EntryPage() {
  const summaries = listWorkspaceSummaries();

  /*
   * One pass over every manifest: which workspaces have something running (`status ===
   * "running"`, the same rule `GET /api/runs` uses — no second notion of a live run), and the
   * recent finished durations that feed each card's sparkline. `listRuns()` is newest-first, so
   * the first running hit per workspace is the run whose clock the chip should show.
   */
  const runningSince = new Map<string, string>();
  const durations = new Map<string, number[]>();
  for (const run of listRuns()) {
    if (run.status === "running") {
      if (!runningSince.has(run.workspace)) runningSince.set(run.workspace, run.createdAt);
      continue;
    }
    if (typeof run.durationMs !== "number") continue;
    const list = durations.get(run.workspace) ?? [];
    if (list.length < SPARK_RUNS) {
      list.push(run.durationMs);
      durations.set(run.workspace, list);
    }
  }

  const rows: EntryRow[] = summaries.map((workspace) => ({
    name: workspace.name,
    repoRoot: workspace.repoRoot,
    // T23: a second line only when the workspace genuinely spans two repos.
    frontendRepo:
      workspace.backendRepo !== null &&
      workspace.frontendRepo !== null &&
      workspace.frontendRepo !== workspace.backendRepo
        ? workspace.frontendRepo
        : null,
    taskCount: workspace.runCount,
    lastRunAt: workspace.lastRunAt,
    runningSince: runningSince.get(workspace.name) ?? null,
    // Collected newest-first above; the sparkline reads oldest → newest.
    durationsMs: (durations.get(workspace.name) ?? []).slice().reverse(),
    usable: workspace.usable,
  }));

  const empty = rows.length === 0;

  return (
    <div className="min-h-dvh">
      {/* Across every workspace here, so a run started in one shows up while you are looking at
          another — and so the RUNNING chip stops counting when that run lands. */}
      <EntryPoller />
      <EntryTopBar />

      <main className="mx-auto flex w-full max-w-[1240px] min-w-0 flex-col gap-[30px] px-6 pt-12 pb-16 sm:px-10 lg:pt-14">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <div className="label text-accent!">Select workspace</div>
            <h1 className="title-screen mt-2.5 text-fg">
              {empty ? "Nothing open yet" : "Open a workspace"}
            </h1>
            <p className="mt-3 max-w-[520px] text-[13.5px] leading-[1.65] text-pretty text-ink-3">
              {empty
                ? "Point the panel at a repository. Runs, results and artifacts are filed inside that workspace."
                : "Every run, result and artifact is filed inside its workspace — a repository, or a backend + frontend pair."}
            </p>
          </div>
          <span className="mono hidden text-[10px] tracking-[-0.02em] text-ink-faint sm:block">
            <kbd className="chip px-1.5 py-0.5 text-[9px] text-ink-2">⌘N</kbd> add workspace
          </span>
        </div>

        {empty ? null : (
          <div className="grid min-w-0 grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <ContentsRow key={row.name} row={row} />
            ))}
          </div>
        )}

        {/* The full-width dashed add pane; the slip behind it is the same client component. */}
        <AddWorkspace providers={PROVIDER_IDS} bare={empty} />
      </main>
    </div>
  );
}
