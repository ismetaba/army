import { notFound } from "next/navigation";
import {
  listArchivedRuns,
  listRuns,
  listWorkspaceSummaries,
  listWorkspaces,
  readLogTail,
  workspaceExists,
} from "@/lib/store";
import { listActiveRuns, listTriggeredRuns } from "@/lib/runner";
import { LedgerTable } from "@/components/ledger-view/ledger-table";
import { LiveAnnounce, RunningPane } from "@/components/ledger-view/live-margin";
import { LiveRunProvider } from "@/components/ledger-view/live-run";
import { MobileLedger } from "@/components/ledger-view/mobile-ledger";
import { StartTask } from "@/components/ledger-view/start-task";
import { TaskLauncherProvider } from "@/components/ledger-view/task-launcher";
import { TopBar } from "@/components/ledger-view/top-bar";
import {
  failedLaunchRow,
  KINDS,
  toLedgerRow,
  type LedgerRow,
  type RunKind,
} from "@/components/ledger-view/model";
import { probeBackend, workspaceFacts } from "@/components/ledger-view/workspace-config";

/**
 * `/ws/<name>` — the workspace ledger (handoff § 02).
 *
 * `force-dynamic` because the store is a directory the CLI writes to behind the panel's back: a
 * cached page would show yesterday's runs after a fresh `aw review`, and the fix a reader would
 * reach for — reload — would not help.
 *
 * A SERVER component, and the table under it is one too. The client islands are only the things
 * that genuinely cannot be static: the live connection (one per screen — see `LiveRunProvider`),
 * the slip, the per-row actions and two clocks. Everything that describes what is IN the store is
 * rendered here from the store, and the poll's job is to decide when to re-run this render — one
 * source of truth for what a run is.
 *
 * The two layouts are both rendered and one is hidden. They are different documents (§ 02c stacks
 * the seven-column table into blocks and moves the margin to a card at the top), and they share
 * their data through props and context rather than fetching it twice.
 */
export const dynamic = "force-dynamic";

/**
 * How many rows the table renders before it stops. A workspace accumulates runs forever and this
 * page is uncached, so an unbounded table would be a multi-megabyte render on every reload.
 * `?limit=all` is the escape hatch.
 */
const PAGE_LIMIT = 100;

/** The design's LOG block shows four lines; a couple of spares survive the first stream frame. */
const SEED_LINES = 6;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `?kind=` — anything not in the enum is "no filter" rather than an error page. */
function parseKind(value: string | string[] | undefined): RunKind | null {
  const wanted = first(value);
  return KINDS.find((k) => k.kind === wanted)?.kind ?? null;
}

export default async function WorkspacePage({ params, searchParams }: PageProps<"/ws/[ws]">) {
  const { ws } = await params;
  const query = await searchParams;
  const kind = parseKind(query.kind);
  const showAll = first(query.limit) === "all";
  const archived = first(query.archived) === "1";

  // `workspaceExists` covers both halves of "real": in workspaces.json, or has a runs directory.
  // A name that is neither — including one that is not a legal directory segment — is a 404, not
  // an empty ledger pretending the workspace is fine.
  if (!workspaceExists(ws)) notFound();

  const entry = listWorkspaces().find((w) => w.name === ws);
  const summaries = listWorkspaceSummaries();

  /*
   * The pid of any process THIS panel started, keyed by the run it is writing. It is what makes
   * WATCH open the live transcript (`?pid=`) rather than the finished run's `log.txt` (`?run=`) —
   * a run started from a terminal legitimately has no pid here and falls back to the second.
   */
  const pids = new Map<string, number>();
  for (const active of listActiveRuns(ws)) {
    if (active.runId !== null) pids.set(active.runId, active.pid);
  }

  /*
   * Runs this panel started that never got as far as a manifest. They are only in the runner's
   * own map (and in `pending/<pid>.log`), so they have to be merged in here or they are invisible
   * — see `failedLaunchRow`. Filed by start time like everything else.
   */
  const failedLaunches = listTriggeredRuns(ws)
    .filter((r) => r.state === "exited" && r.runId === null && r.exitCode !== 0)
    .map(failedLaunchRow);

  const activeRows = [
    ...listRuns(ws).map((m) => toLedgerRow(m, pids.get(m.runId) ?? null)),
    ...failedLaunches,
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const archivedRows = listArchivedRuns(ws).map((m) => toLedgerRow(m));
  const area = archived ? archivedRows : activeRows;

  const matching = kind === null ? area : area.filter((r) => r.kind === kind);
  const rows = showAll ? matching : matching.slice(0, PAGE_LIMIT);
  const counts = {
    all: area.length,
    review: area.filter((r) => r.kind === "review").length,
    "test-feature": area.filter((r) => r.kind === "test-feature").length,
    "design-loop": area.filter((r) => r.kind === "design-loop").length,
  };

  /*
   * The live pane is about the WORKSPACE, not about the filter: switching to `ARCHIVED` or to
   * one kind must not change what "running now" means. Both read the active list.
   */
  const lastFiled: LedgerRow | null = activeRows.find((r) => r.status !== "running") ?? null;
  const runningRow: LedgerRow | null = activeRows.find((r) => r.status === "running") ?? null;

  // The tail the LOG block shows before anything streams. Read here rather than fetched, so the
  // block is populated in the first paint instead of a beat later.
  const newest = activeRows[0] ?? null;
  const seedLines =
    newest === null
      ? []
      : readLogTail(ws, newest.runId, SEED_LINES)
          .text.split("\n")
          .filter((line) => line.trim() !== "");

  const facts = workspaceFacts(ws);
  const backend = await probeBackend(facts);

  // T23: a two-repo workspace names both halves in the top bar. Config first (it is the truth
  // the workflows act on), registry second, single path as before for everyone else.
  const backendRepo = facts.backendRepo ?? entry?.backendRepo ?? null;
  const frontendRepo = facts.frontendRepo ?? entry?.frontendRepo ?? null;
  const repoLabel =
    backendRepo !== null && frontendRepo !== null && backendRepo !== frontendRepo
      ? `${backendRepo} · ${frontendRepo}`
      : (entry?.repoRoot ?? null);

  return (
    <TaskLauncherProvider
      ws={ws}
      defaults={{ provider: facts.provider, model: facts.model }}
      backend={backend}
      targets={{ hasBackend: facts.hasBackend, hasFrontend: facts.hasFrontend }}
    >
      <LiveRunProvider ws={ws} seedLines={seedLines}>
        <div className="flex min-h-screen min-w-0 flex-col">
          <TopBar
            ws={ws}
            repoRoot={repoLabel}
            workspaces={summaries
              .filter((w) => w.usable)
              .map((w) => ({ name: w.name, runCount: w.runCount }))}
            backend={backend}
          />

          {/* The workspace's one polite live region, outside both layouts so it is mounted exactly
              once and survives the switch from "running" to the filed verdict. */}
          <LiveAnnounce lastFiled={lastFiled} />

          {/* Glass § 02: a STACK of panes — the live pane on top, then the launcher cards, then
              the settled-runs shell. One column; the live pane is the one elevated surface. */}
          <main className="mx-auto hidden w-full max-w-[1240px] min-w-0 flex-col gap-5 px-8 pt-7 pb-10 min-[900px]:flex">
            <RunningPane ws={ws} runningRow={runningRow} />
            <StartTask />
            <LedgerTable
              ws={ws}
              rows={rows}
              archived={archived}
              kind={kind}
              counts={counts}
              total={matching.length}
            />
          </main>

          <div className="flex min-w-0 flex-1 flex-col min-[900px]:hidden">
            <MobileLedger ws={ws} rows={rows} archived={archived} kind={kind} counts={counts} />
          </div>
        </div>
      </LiveRunProvider>
    </TaskLauncherProvider>
  );
}
