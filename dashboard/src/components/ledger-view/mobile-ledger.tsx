"use client";

/**
 * The 375 layout (handoff § 02c): the same content, stacked.
 *
 * A separate tree rather than a responsive rearrangement of the desktop one, because it is a
 * different document: a seven-column table does not become three stacked lines by changing its
 * grid, and the in-progress entry moves from a margin to a card at the top. Both trees are
 * rendered and one is hidden — they read the SAME live connection and the same server-rendered
 * rows through context and props, so nothing is fetched or computed twice.
 *
 * Every target here is at least 44px tall (handoff § Accessibility).
 */

import Link from "next/link";
import { StatusSquare, statusInk } from "@/components/ledger/marks";
import { useLiveRun } from "./live-run";
import { ProgressRule } from "./live-margin";
import { RowActions } from "./row-actions";
import { RunningClock } from "./running-clock";
import { useTaskLauncher } from "./task-launcher";
import {
  formatClock,
  formatDur,
  formatElapsed,
  kindMeta,
  ledgerStatus,
  wsHref,
  type LedgerRow,
  type LedgerStatus,
  type RunKind,
} from "./model";

/** `AWAITING FEEDBACK` does not fit a 375 row; the mark still carries the meaning beside it. */
const SHORT: Record<LedgerStatus, string> = {
  running: "RUNNING",
  done: "DONE",
  error: "ERROR",
  cancelled: "CANCELLED",
  awaiting: "AWAIT",
};

export function MobileLedger({
  ws,
  rows,
  archived,
  kind,
  counts,
}: {
  ws: string;
  rows: readonly LedgerRow[];
  archived: boolean;
  kind: RunKind | null;
  counts: { all: number } & Record<RunKind, number>;
}) {
  const { open } = useTaskLauncher();

  return (
    <div className="flex min-h-[calc(100vh-96px)] min-w-0 flex-col">
      <InProgressCard />

      {/* One line, scrolling inside its own box — the PAGE never scrolls sideways. */}
      <nav
        aria-label="Filter the ledger"
        className="flex items-center gap-3 overflow-x-auto border-b border-line px-4 py-1.5"
      >
        <Chip href={wsHref(ws, { kind })} active={!archived} label="active" />
        <Chip href={wsHref(ws, { kind, archived: true })} active={archived} label="archived" />
        <span aria-hidden className="h-3 w-px flex-none bg-line" />
        <Chip href={wsHref(ws, { archived })} active={kind === null} label={`all ${counts.all}`} />
        <Chip href={wsHref(ws, { kind: "review", archived })} active={kind === "review"} label={`review ${counts.review}`} />
        <Chip
          href={wsHref(ws, { kind: "test-feature", archived })}
          active={kind === "test-feature"}
          label={`test ${counts["test-feature"]}`}
        />
        <Chip
          href={wsHref(ws, { kind: "design-loop", archived })}
          active={kind === "design-loop"}
          label={`design ${counts["design-loop"]}`}
        />
      </nav>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2.5 px-4 py-14 text-center">
          <p className="text-[17px] font-medium tracking-[-0.02em]">
            {archived ? "No archived runs" : "No entries yet"}
          </p>
          <p className="mono text-[10px] tracking-[-0.03em] text-muted">
            {archived ? "ARCHIVE on a run moves it here" : "start a task below — the first run is filed here"}
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => (
            <RunBlock key={row.runId} ws={ws} row={row} archived={archived} />
          ))}
        </div>
      )}

      <div className="sticky bottom-0 mt-auto flex items-center justify-between gap-3 border-t border-line bg-bg px-4 py-2">
        <button
          type="button"
          onClick={() => open("review")}
          data-mobile-new-task
          className="mono flex min-h-11 flex-1 items-center text-left text-[9.5px] tracking-[-0.03em] text-muted"
        >
          new task…
        </button>
        <button
          type="button"
          onClick={() => open("review")}
          data-mobile-start
          className="mono flex min-h-11 flex-none items-center bg-fg px-3.5 text-[9px] font-medium tracking-[0.08em] text-bg transition-colors duration-[180ms] hover:bg-ink-2"
        >
          START
        </button>
      </div>
    </div>
  );
}

function InProgressCard() {
  const { run, elapsed, progress } = useLiveRun();
  if (run === null) return null;

  return (
    <section
      data-mobile-live
      className="flex flex-col gap-2.5 border-b border-line bg-surface-2 px-4 py-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="mono text-[9px] font-medium tracking-[0.14em] text-accent">IN PROGRESS</h2>
        <span className="mono text-[9px] tracking-[-0.03em] text-muted">{run.kind}</span>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <p aria-live="polite" className="text-[26px] font-semibold tracking-[-0.03em] tabular-nums">
          {elapsed === null ? "—" : formatElapsed(elapsed)}
        </p>
        <span className="flex items-baseline gap-[7px]">
          <span key={progress.tools} className="anim-flip text-[18px] font-semibold tracking-[-0.02em]">
            {progress.tools}
          </span>
          <span className="mono text-[9px] tracking-[-0.03em] text-ink-3">tool calls</span>
        </span>
      </div>
      <ProgressRule fraction={progress.fraction} />
      <p className="mono truncate text-[9px] tracking-[-0.04em] text-ink-3">
        {progress.step === "" ? "waiting for the first line…" : progress.step}
      </p>
    </section>
  );
}

function RunBlock({ ws, row, archived }: { ws: string; row: LedgerRow; archived: boolean }) {
  const running = row.status === "running";
  const status = ledgerStatus(row);
  const watch =
    row.pid !== null
      ? `/ws/${encodeURIComponent(ws)}/live?pid=${row.pid}`
      : `/ws/${encodeURIComponent(ws)}/live?run=${encodeURIComponent(row.runId)}`;

  return (
    <div
      data-mobile-row={row.runId}
      style={running ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
      className={`flex flex-col gap-[7px] border-b border-line px-4 py-1.5 ${running ? "bg-surface-2" : ""}`}
    >
      <div className="flex items-center justify-between gap-2.5">
        <Link
          href={`/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(row.runId)}`}
          className="mono flex min-h-11 min-w-0 flex-1 items-center truncate text-[9.5px] tracking-[-0.04em]"
        >
          {row.runId}
        </Link>
        <span className={`flex flex-none items-center gap-1.5 ${statusInk(status)}`}>
          <StatusSquare status={status} />
          <span className="statusword text-[9px]">{SHORT[status]}</span>
        </span>
      </div>

      <p className="mono truncate text-[9px] tracking-[-0.04em] text-ink-2">
        {formatClock(row.createdAt)} ·{" "}
        {running ? <RunningClock startedAt={row.createdAt} /> : formatDur(row.durationMs)} ·{" "}
        {row.provider} / {row.model}
      </p>

      {running ? (
        <Link
          href={watch}
          className="mono flex min-h-11 items-center text-[8.5px] tracking-[0.04em] text-accent"
        >
          WATCH · {kindMeta(row.kind).title.toUpperCase()}
        </Link>
      ) : (
        <RowActions ws={ws} runId={row.runId} area={archived ? "archive" : "runs"} compact />
      )}
    </div>
  );
}

function Chip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`mono flex min-h-11 flex-none items-center text-[9px] tracking-[-0.02em] whitespace-nowrap ${
        active ? "border-b-2 border-accent text-fg" : "text-muted"
      }`}
    >
      {label}
    </Link>
  );
}
