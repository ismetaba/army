import Link from "next/link";
import { notFound } from "next/navigation";
import { artifactHref, readRun, resolveArtifact, workspaceExists } from "@/lib/store";
import type { RunManifest } from "@/lib/store";
import { getTriggeredRun, type ActiveRun } from "@/lib/runner";
import { expectedRunMs } from "@/lib/run-pace";
import {
  EmptyNote,
  TaskHeader,
  TaskTabs,
  TaskTopBar,
  clock,
  ledgerStatus,
  shortWhen,
  type ArtifactItem,
  type MetaItem,
} from "@/components/task-header";
import { CancelRunButton, Elapsed, FinishedBar, LiveLog } from "@/components/live-log";
import { StatusMark, type LedgerStatus } from "@/components/ledger/marks";
import { VerdictBanner, countSeverities, findingSummary } from "@/components/verdict";

/**
 * `/ws/<ws>/live?pid=<pid>` — the running view (handoff § 04d), and the only place `CANCEL RUN`
 * exists.
 *
 * **Why this is still its own route rather than a redirect into the task page.** A run has no run
 * id until it ends: the CLI announces `run saved: <ws>/<runId>` as its last act, so between "start
 * a task" and "the verdict lands" there is a PROCESS and no manifest. `/ws/<ws>/run/<id>` is
 * addressed by run id and cannot name that process; this route is addressed by pid, which is the
 * handle the panel actually holds, and it is what makes Cancel unambiguous. The two views share
 * every piece of furniture (`TaskHeader`, `TaskTabs`, `LiveLog`), so they are the same screen —
 * they are simply reachable by the two different things a run can be identified by. The task
 * page's `LOG` tab streams the identical view for a run whose manifest already exists.
 *
 * `?run=<runId>` is the same view pointed at a run's `log.txt` by id — for a run started in a
 * terminal. There is no process behind it, so it has no Cancel button.
 */
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LivePage({ params, searchParams }: PageProps<"/ws/[ws]/live">) {
  const { ws } = await params;
  if (!workspaceExists(ws)) notFound();

  const query = await searchParams;
  const pidParam = first(query.pid);
  const runParam = first(query.run);

  if (pidParam !== undefined) {
    const pid = /^[0-9]{1,10}$/.test(pidParam) ? Number(pidParam) : NaN;
    const tracked = Number.isNaN(pid) ? null : getTriggeredRun(pid);

    // A pid the panel does not know: a stale link, or the dev server was restarted while the run
    // was going. Not a 404 — the workspace is real and the answer is "start a new one", which a
    // not-found page would not say.
    if (tracked === null || tracked.ws !== ws) return <Unknown ws={ws} pid={pidParam} />;

    const manifest = tracked.runId === null ? null : readRun(ws, tracked.runId);
    return <Watch ws={ws} tracked={tracked} manifest={manifest} />;
  }

  if (runParam !== undefined) {
    const manifest = readRun(ws, runParam);
    if (manifest === null) notFound();
    return <Watch ws={ws} tracked={null} manifest={manifest} />;
  }

  return <Unknown ws={ws} pid={null} />;
}

// ---------------------------------------------------------------------------
// the view
// ---------------------------------------------------------------------------

function Watch({
  ws,
  tracked,
  manifest,
}: {
  ws: string;
  /** The process, when this page is following one. `null` for a `?run=` tail. */
  tracked: ActiveRun | null;
  /** The manifest, once there is one. `null` while the run has not saved itself yet. */
  manifest: RunManifest | null;
}) {
  const running =
    tracked !== null ? tracked.state === "running" : manifest?.status === "running";
  const runId = tracked?.runId ?? manifest?.runId ?? null;
  const kind = tracked?.kind ?? manifest?.kind ?? null;
  const startedAt = tracked?.startedAt ?? manifest?.createdAt ?? new Date().toISOString();
  const runHref =
    runId === null ? null : `/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(runId)}`;

  const status: LedgerStatus = running
    ? "running"
    : manifest !== null
      ? ledgerStatus(manifest)
      : tracked === null
        ? "done"
        : tracked.cancelRequested
          ? "cancelled"
          : tracked.exitCode === 0
            ? "done"
            : "error";

  const meta: MetaItem[] = [];
  if (kind !== null) meta.push({ label: "type", value: kind });
  if (manifest !== null) {
    meta.push({ label: "agent", value: manifest.agent });
    meta.push({ label: "provider", value: `${manifest.provider} / ${manifest.model}` });
    if (manifest.input.base) meta.push({ label: "base", value: manifest.input.base });
  }
  if (tracked !== null) meta.push({ label: "pid", value: String(tracked.pid) });
  meta.push({ label: "created", value: shortWhen(startedAt) });
  // A finished run without a manifest `durationMs` (a failed launch, a cancelled run) falls back
  // to the tracked process's own start/end stamps — never to `<Elapsed running={false}>`, which
  // renders wall-clock AGE and would read "duration 60m00s" an hour after a 2s crash.
  const trackedMs =
    tracked?.endedAt != null
      ? Math.max(0, new Date(tracked.endedAt).getTime() - new Date(tracked.startedAt).getTime())
      : null;
  meta.push({
    label: running ? "elapsed" : "duration",
    value: running ? (
      <Elapsed startedAt={startedAt} running />
    ) : (
      clock(manifest?.durationMs ?? trackedMs)
    ),
  });

  const command =
    tracked?.display ?? (manifest !== null ? `npx tsx src/cli.ts ${manifest.input.args}` : "—");

  return (
    <div className="flex min-w-0 flex-col">
      <TaskTopBar ws={ws} />

      <div className="min-w-0 px-10 pt-[26px]">
        <TaskHeader
          runId={runId ?? (kind === null ? "run" : `${kind} · starting…`)}
          status={status}
          meta={meta}
          command={command}
          artifacts={manifest === null ? [] : artifactsFor(manifest, runHref)}
          artifactsNote={running ? "pending" : "none"}
          aside={
            tracked !== null && running ? <CancelRunButton pid={tracked.pid} /> : undefined
          }
        />
        <TaskTabs
          items={[
            {
              id: "result",
              label: "result",
              href: running || runHref === null ? null : `${runHref}?tab=result`,
              title: running ? "the result tab fills in the moment the verdict lands" : undefined,
            },
            { id: "log", label: "log", href: null },
          ]}
          active="log"
        />
      </div>

      <div className="flex min-w-0 flex-col gap-[18px] px-10 pt-[22px] pb-10">
        {!running && runId !== null && manifest !== null ? (
          <>
            <FinishedBar
              ws={ws}
              runId={runId}
              resultHref={runHref === null ? null : `${runHref}?tab=result`}
              durationMs={manifest.durationMs ?? null}
            >
              <StatusMark status={status} />
            </FinishedBar>
            {manifest.review ? (
              <VerdictBanner
                verdict={manifest.review.verdict}
                summary={findingSummary(countSeverities(manifest.review.findings), null)}
                compact
              />
            ) : null}
          </>
        ) : null}

        <LiveLog
          ws={ws}
          pid={tracked?.pid ?? null}
          runId={runId}
          argv={tracked?.argv ?? null}
          initiallyRunning={running === true}
          startedAt={startedAt}
          expectedMs={kind === null ? null : expectedRunMs(ws, kind)}
          durationMs={manifest?.durationMs ?? null}
        />
      </div>
    </div>
  );
}

/** Same rule as the task page: presence is proven, never assumed. */
function artifactsFor(run: RunManifest, runHref: string | null): ArtifactItem[] {
  const href = (relPath: string) =>
    resolveArtifact(run.workspace, run.runId, relPath) === null
      ? null
      : artifactHref(run.workspace, run.runId, relPath);

  if (run.review) return [{ label: "diff", href: href(run.review.diffArtifact) }];
  if (run.test) return [{ label: "report", href: href(run.test.reportArtifact) }];
  if (run.design) {
    const out: ArtifactItem[] = [];
    if (run.design.screens.length > 0 && runHref !== null) {
      out.push({ label: "shots", href: `${runHref}?tab=result#screens` });
    }
    if (run.design.video) out.push({ label: "video", href: href(run.design.video) });
    return out;
  }
  return [];
}

function Unknown({ ws, pid }: { ws: string; pid: string | null }) {
  return (
    <div className="flex min-w-0 flex-col">
      <TaskTopBar ws={ws} />
      <div className="flex min-w-0 flex-col gap-5 px-10 pt-[26px] pb-11">
        <div className="h-0.5 bg-fg" />
        <h1 className="text-[22px] font-semibold tracking-[-0.025em]">Nothing to watch</h1>
        <p className="max-w-[62ch] text-[13px] leading-[1.6] text-ink-2" data-live-unknown>
          {pid === null
            ? "This page follows one running workflow. Start one from the ledger."
            : `The panel is not tracking a process with pid ${pid} in workspace ${ws}. It has ` +
              "already been forgotten, or it was started by a different panel process — restarting " +
              "the dev server does not stop a running workflow, but it does lose the handle to it."}
        </p>
        <EmptyNote>
          <Link
            href={`/ws/${encodeURIComponent(ws)}`}
            className="text-accent underline hover:text-accent-hover"
          >
            back to the {ws} ledger
          </Link>
        </EmptyNote>
      </div>
    </div>
  );
}
