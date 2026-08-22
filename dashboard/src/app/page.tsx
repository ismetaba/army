import { EntryTopBar } from "@/components/ledger/chrome";
import { AddWorkspace } from "@/components/entry/add-workspace";
import { ContentsRow, ContentsRule, type EntryRow } from "@/components/entry/contents";
import { EntryPoller } from "@/components/entry/entry-poller";
import { PROVIDER_IDS } from "@/lib/config-patch";
import { listRuns, listWorkspaceSummaries } from "@/lib/store";

/**
 * 01 · Entry — "Open a workspace" (handoff § 01).
 *
 * The first of the flow's three levels: one workspace is one repository, and nothing else in the
 * panel is reachable before one is chosen. The design's shape is a table of CONTENTS rather than a
 * grid of cards — numbered entries, a dotted leader, meta in the margin — so that is what this
 * renders, straight from the store.
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

export default function EntryPage() {
  const summaries = listWorkspaceSummaries();

  /*
   * Which workspaces have something running, derived from the manifests exactly the way
   * `GET /api/runs` derives its `running` list — `status === "running"`, no second notion of what
   * a live run is. `listRuns()` is newest-first, so the first hit per workspace is the run whose
   * clock the chip should show.
   */
  const runningSince = new Map<string, string>();
  for (const run of listRuns()) {
    if (run.status !== "running") continue;
    if (!runningSince.has(run.workspace)) runningSince.set(run.workspace, run.createdAt);
  }

  const rows: EntryRow[] = summaries.map((workspace) => ({
    name: workspace.name,
    repoRoot: workspace.repoRoot,
    taskCount: workspace.runCount,
    lastRunAt: workspace.lastRunAt,
    runningSince: runningSince.get(workspace.name) ?? null,
    usable: workspace.usable,
  }));

  const empty = rows.length === 0;

  return (
    <div className="min-h-dvh">
      {/* Across every workspace here, so a run started in one shows up while you are looking at
          another — and so the RUNNING chip stops counting when that run lands. */}
      <EntryPoller />
      <EntryTopBar />

      {/*
        200px margin column + a max-900px main column, 72/80px of vertical air (§ 01). Below
        1024px the margin column stops being a margin and stacks above the title: at 375 there is
        no room beside anything, and the page itself must never scroll sideways.
      */}
      <div className="flex flex-col gap-8 px-6 pt-12 pb-16 sm:px-10 lg:flex-row lg:gap-0 lg:px-10 lg:pt-[72px] lg:pb-20">
        <aside className="w-full flex-none lg:w-[200px] lg:pt-2.5">
          <div className="font-mono text-[10px] font-medium tracking-[0.14em] text-accent uppercase">
            Contents
          </div>
          <p className="mt-3 font-mono text-[11px] leading-[1.7] tracking-[-0.02em] text-muted">
            {countWord(rows.length)}
            <br />
            {rows.length === 1 ? "repository" : "repositories"}
          </p>
        </aside>

        <main className="min-w-0 flex-1 lg:max-w-[900px]">
          <h1 className={`title-screen text-fg ${empty ? "max-w-[480px]" : ""}`}>
            {empty ? "Nothing filed yet" : "Open a workspace"}
          </h1>
          <p
            className={`mt-3.5 text-[15px] leading-[1.65] text-pretty text-ink-2 ${
              empty ? "max-w-[460px]" : "max-w-[520px]"
            }`}
          >
            {empty
              ? "Point the panel at a repository. Runs, results and artifacts are filed inside that workspace."
              : "One workspace is one repository. Every run, result and artifact for that repo is filed inside it."}
          </p>

          <div className={empty ? "mt-10 max-w-[620px]" : "mt-11"}>
            <ContentsRule />
            {rows.map((row, index) => (
              <ContentsRow key={row.name} row={row} index={index + 1} />
            ))}
            <AddWorkspace providers={PROVIDER_IDS} bare={empty} />
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * The margin note counts in words (`three repositories`), which is what the design draws. Past ten
 * it falls back to the digits rather than growing a number-speller nobody asked for.
 */
const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
