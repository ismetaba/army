import Link from "next/link";
import { notFound } from "next/navigation";
import { artifactHref, readLogTail, readRun, resolveArtifact } from "@/lib/store";
import type { RunManifest } from "@/lib/store";
import { expectedRunMs } from "@/lib/run-pace";
import { formatBytes } from "@/lib/format";
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
import { LogConsole } from "@/components/log-console";
import { Elapsed, FinishedBar, LiveLog } from "@/components/live-log";
import { StatusMark } from "@/components/ledger/marks";
import { VerdictBanner, countSeverities, findingSummary } from "@/components/verdict";
import { ReportPanel } from "@/components/report-panel";
import { ReviewTab } from "@/components/review-tab";
import { DesignPanel } from "@/components/design-panel";

/**
 * Task detail — the shell every result type is rendered inside (handoff § 04).
 *
 * One header, two tabs. `RESULT` is the type-specific body (§ 04a review, § 04b test, § 04c
 * design loop); `LOG` is the run console, which STREAMS while the run is going (§ 04d) and is the
 * static tail once it has landed (§ 04d-2). Nothing about the header changes between the four —
 * that is the whole point of `TaskHeader`, and it is why the type-specific pieces receive a
 * manifest and render only what goes under the tabs.
 */
export const dynamic = "force-dynamic";

const LOG_TAIL_LINES = 500;

type TabId = "result" | "log";

/**
 * `?tab=result` / `?tab=log`, defaulting to whichever one has something to show.
 *
 * The three old per-type values (`review`, `report`, `design`) are still accepted and mean
 * `result`: they are in links the ledger and the design tab wrote before the tabs were collapsed
 * into two, and a bookmark that silently lands on the wrong tab is worse than an alias.
 */
function parseTab(value: string | string[] | undefined, running: boolean): TabId {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === "log") return "log";
  if (first === "result" || first === "review" || first === "report" || first === "design") {
    return running ? "log" : "result";
  }
  // While a run is going there is no result yet — the log IS the page (handoff § 04d).
  return running ? "log" : "result";
}

export default async function RunPage({ params, searchParams }: PageProps<"/ws/[ws]/run/[id]">) {
  const { ws, id } = await params;
  const run = readRun(ws, id);
  if (run === null) notFound();

  const running = run.status === "running";
  const tab = parseTab((await searchParams).tab, running);
  const base = `/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(id)}`;
  const status = ledgerStatus(run);

  return (
    <div className="flex min-w-0 flex-col">
      <TaskTopBar ws={ws} />

      <div className="min-w-0 px-10 pt-[26px]">
        <TaskHeader
          runId={run.runId}
          status={status}
          meta={metaFor(run, running)}
          command={`npx tsx src/cli.ts ${run.input.args}`}
          artifacts={artifactsFor(run, base)}
          artifactsNote={running ? "pending" : "none"}
        />
        <TaskTabs
          items={[
            {
              id: "result",
              label: "result",
              href: running ? null : `${base}?tab=result`,
              title: running ? "the result tab fills in the moment the verdict lands" : undefined,
            },
            { id: "log", label: "log", href: `${base}?tab=log` },
          ]}
          active={tab}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-[26px] px-10 pt-[26px] pb-11">
        {run.error !== undefined && run.error !== "" ? (
          <div className="flex min-w-0 flex-col gap-1.5 border-l-4 border-danger bg-danger-tint px-5 py-4">
            <span className="colhead text-danger">error</span>
            {/* Run content: text, wrapped, scrolling inside its own box if it is one long line. */}
            <pre className="mono min-w-0 overflow-x-auto text-[11px] leading-[1.7] break-words whitespace-pre-wrap text-danger-deep">
              {run.error}
            </pre>
          </div>
        ) : null}

        {tab === "result" ? <ResultBody run={run} base={base} /> : <LogBody run={run} base={base} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// header data
// ---------------------------------------------------------------------------

/** `TYPE · AGENT · PROVIDER · TARGET · BASE · CREATED · DURATION` (handoff § 04 + T23). */
function metaFor(run: RunManifest, running: boolean): MetaItem[] {
  const meta: MetaItem[] = [
    { label: "type", value: run.kind },
    { label: "agent", value: run.agent },
    { label: "provider", value: `${run.provider} / ${run.model}` },
    // T23: which repo the run acted on. Manifests written before T23 carry neither field —
    // render "—" rather than guessing. The resolved repo path rides along as the tooltip.
    {
      label: "target",
      value: (
        <span title={run.input.repoRoot ?? undefined}>{run.input.target ?? "—"}</span>
      ),
    },
  ];
  if (run.input.base) meta.push({ label: "base", value: run.input.base });
  if (run.input.targetUrl) meta.push({ label: "url", value: run.input.targetUrl });
  meta.push({ label: "created", value: shortWhen(run.createdAt) });
  meta.push({
    label: running ? "elapsed" : "duration",
    // The clock only ticks while the run does; a finished run prints the manifest's own number.
    value: running ? (
      <Elapsed startedAt={run.createdAt} running />
    ) : (
      clock(run.durationMs)
    ),
  });
  return meta;
}

/**
 * `diff` for a review, `report` for a test run, `shots` / `video` for a design loop.
 *
 * Every path in a manifest is agent-written, so presence is proven with `resolveArtifact` — the
 * same gate `/api/artifact` uses — rather than assumed. An artifact the store cannot resolve is
 * shown as missing instead of as a link that answers 404.
 */
function artifactsFor(run: RunManifest, base: string): ArtifactItem[] {
  const href = (relPath: string) =>
    resolveArtifact(run.workspace, run.runId, relPath) === null
      ? null
      : artifactHref(run.workspace, run.runId, relPath);

  if (run.review) return [{ label: "diff", href: href(run.review.diffArtifact) }];
  if (run.test) return [{ label: "report", href: href(run.test.reportArtifact) }];
  if (run.design) {
    const out: ArtifactItem[] = [];
    // `shots` is the gallery, not a file: there is no single URL for four PNGs, and the gallery is
    // where you look at them. It always points at the Result tab so it works from the Log tab too.
    if (run.design.screens.length > 0) out.push({ label: "shots", href: `${base}?tab=result#screens` });
    if (run.design.video) out.push({ label: "video", href: href(run.design.video) });
    return out;
  }
  return [];
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------

function ResultBody({ run, base }: { run: RunManifest; base: string }) {
  if (run.status === "running") {
    return (
      <EmptyNote>
        This run is still going —{" "}
        <Link href={`${base}?tab=log`} className="text-accent underline hover:text-accent-hover">
          watch the log
        </Link>
        . The result fills in the moment the verdict lands.
      </EmptyNote>
    );
  }

  if (run.kind === "review") return <ReviewTab run={run} />;
  if (run.kind === "test-feature") return <ReportPanel run={run} />;
  return <DesignPanel run={run} />;
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

function LogBody({ run, base }: { run: RunManifest; base: string }) {
  if (run.status === "running") {
    return (
      <LiveLog
        ws={run.workspace}
        // The run page knows a run id and not a pid — the CLI announces the id at the very END of
        // a run, so a running manifest cannot be matched back to a process. Cancel therefore lives
        // on `/ws/<ws>/live?pid=…`, where the pid is unambiguous, and never guesses here.
        pid={null}
        runId={run.runId}
        argv={null}
        initiallyRunning
        startedAt={run.createdAt}
        expectedMs={expectedRunMs(run.workspace, run.kind)}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-[18px]">
      {/* Handoff § 04d-2: the state a run lands in — what it decided, and the two things to do. */}
      <FinishedBar
        ws={run.workspace}
        runId={run.runId}
        resultHref={`${base}?tab=result`}
        durationMs={run.durationMs ?? null}
      >
        <StatusMark status={ledgerStatus(run)} />
      </FinishedBar>

      {run.review ? (
        <VerdictBanner
          verdict={run.review.verdict}
          summary={findingSummary(countSeverities(run.review.findings), null)}
          compact
        />
      ) : null}

      <StaticLog ws={run.workspace} id={run.runId} />
    </div>
  );
}

/** The tail of the run's `log.txt`, exactly as the store wrote it. */
function StaticLog({ ws, id }: { ws: string; id: string }) {
  const log = readLogTail(ws, id, LOG_TAIL_LINES);

  if (!log.exists) {
    return (
      <EmptyNote>
        This run has no <span className="mono">log.txt</span>.
      </EmptyNote>
    );
  }

  // A log that exists but cannot be read is NOT a run without a log: saying so would send the
  // reader looking for a missing file that is sitting right there.
  if (log.error !== null) {
    return (
      <EmptyNote>
        <span className="mono">log.txt</span> ({formatBytes(log.bytes)}) could not be read (
        {log.error}).
      </EmptyNote>
    );
  }

  if (log.totalLines === 0) {
    return (
      <EmptyNote>
        This run&rsquo;s <span className="mono">log.txt</span> is empty.
      </EmptyNote>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <p className="mono text-[9.5px] text-muted">
        {log.totalLines === null
          ? `log.txt — last ${log.shownLines} lines of ${formatBytes(log.bytes)}`
          : log.truncated
            ? `log.txt — last ${log.shownLines} of ${log.totalLines} lines`
            : `log.txt — ${log.totalLines} ${log.totalLines === 1 ? "line" : "lines"}`}
      </p>
      <LogConsole lines={log.text.split("\n")} height="h-[520px]" />
    </div>
  );
}
