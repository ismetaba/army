import Link from "next/link";
import { StatusMark } from "@/components/ledger/marks";
import { RowActions } from "./row-actions";
import { RunningClock } from "./running-clock";
import {
  failureReason,
  formatDur,
  KINDS,
  ledgerStatus,
  wsHref,
  type LedgerRow,
  type RunKind,
} from "./model";

/**
 * "Settled runs" (Glass § 02): a `pane-sunken` shell, radius 20, `overflow:hidden`. The header
 * carries the title, the `active` / `archived` segmented control (selected = gold fill with
 * dark text inside a dark track), the kind count chips (`all N` filled, the rest outlined) and
 * the auto-refresh note. Rows are a `1.9fr 1fr 1.1fr 1.6fr 0.7fr 0.85fr` grid separated by 1px
 * soft rules.
 *
 * The grid lives inside its own `overflow-x-auto` box with a min-width under it: at a narrow
 * desktop the TABLE scrolls sideways and the page does not (handoff § Interactions). Below
 * 900px this table is not rendered at all — `MobileLedger` takes over with stacked blocks.
 *
 * A server component. Only the two things that cannot be static are client islands: the running
 * row's clock, and the per-row Archive/Delete.
 */

const GRID = "grid grid-cols-[1.9fr_1fr_1.1fr_1.6fr_0.7fr_0.85fr] gap-[18px] items-center";
const COLUMNS = ["TASK", "TYPE", "STATUS", "PROVIDER / MODEL", "DUR", "ACTIONS"];

export function LedgerTable({
  ws,
  rows,
  archived,
  kind,
  counts,
  total,
}: {
  ws: string;
  rows: readonly LedgerRow[];
  archived: boolean;
  kind: RunKind | null;
  /** Counts for the CURRENT area, so the numbers agree with what the table is showing. */
  counts: { all: number } & Record<RunKind, number>;
  /** How many rows match the filter before the page limit — for the "showing newest N" line. */
  total: number;
}) {
  return (
    <section className="pane-sunken flex min-w-0 flex-col overflow-hidden">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-3 border-b border-line px-[22px] py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
          <h2 className="text-[17px] font-semibold tracking-[-0.025em]">Settled runs</h2>
          {/* active / archived — a segmented control inside a dark track */}
          <span className="flex items-center gap-0.5 rounded-[11px] bg-surface-2 p-0.5">
            <Toggle href={wsHref(ws, { kind })} active={!archived} label="active" />
            <Toggle href={wsHref(ws, { kind, archived: true })} active={archived} label="archived" />
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <Count href={wsHref(ws, { archived })} active={kind === null} label="all" n={counts.all} />
            {KINDS.map((k) => (
              <Count
                key={k.kind}
                href={wsHref(ws, { kind: k.kind, archived })}
                active={kind === k.kind}
                label={k.kind}
                n={counts[k.kind]}
              />
            ))}
          </span>
        </div>
        <span className="mono hidden text-[9px] tracking-[-0.02em] text-ink-faint lg:block">
          auto-refresh 5s
        </span>
      </header>

      {rows.length === 0 ? (
        <Empty archived={archived} kind={kind} />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <div className="min-w-[880px]">
            <div className={`${GRID} border-b border-line px-[22px] py-[9px]`}>
              {COLUMNS.map((column) => (
                <span
                  key={column}
                  className={`colhead ${column === "ACTIONS" || column === "DUR" ? "text-right" : ""}`}
                >
                  {column}
                </span>
              ))}
            </div>

            {rows.map((row) => (
              <Row key={row.runId} ws={ws} row={row} archived={archived} />
            ))}
          </div>
        </div>
      )}

      {total > rows.length ? (
        <p className="mono px-[22px] py-3.5 text-[9.5px] tracking-[-0.03em] text-muted">
          showing the newest {rows.length} of {total} —{" "}
          <Link
            href={wsHref(ws, { kind, archived, all: true })}
            className="text-accent transition-colors duration-[180ms] hover:text-accent-hover"
          >
            show all
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function Row({ ws, row, archived }: { ws: string; row: LedgerRow; archived: boolean }) {
  const running = row.status === "running";
  const status = ledgerStatus(row);
  const reason = failureReason(row);
  const cancelled = row.status === "cancelled";
  const watch =
    row.pid !== null
      ? `/ws/${encodeURIComponent(ws)}/live?pid=${row.pid}`
      : `/ws/${encodeURIComponent(ws)}/live?run=${encodeURIComponent(row.runId)}`;

  return (
    <div
      data-ledger-row={row.runId}
      data-running={running ? "" : undefined}
      // The 3px gold inset bar is a shadow rather than a border so it does not take a pixel out
      // of the grid and shift the running row's columns out of line with every other row.
      style={running ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
      className={`${GRID} border-b border-line px-[22px] py-3.5 transition-colors duration-[180ms] last:border-b-0 ${
        running ? "bg-accent-tint/40" : "hover:bg-paper-hover"
      } ${cancelled ? "opacity-60" : ""}`}
    >
      {/*
        Archived runs are not linked: `/ws/[ws]/run/[id]` reads `runs/` only, so a link to an
        archived run answers 404. Showing the id as plain text says "it is still here, just not
        open" — RESTORE in the actions column is what brings it back. A failed launch has no run
        directory AT ALL (its "id" is a pid), so its cell is plain text for the same reason.
      */}
      {archived || row.launchFailed ? (
        <span title={row.runId} className="mono truncate text-[10.5px] tracking-[-0.05em] text-ink-2">
          {row.runId}
        </span>
      ) : (
        <Link
          href={`/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(row.runId)}`}
          title={row.runId}
          className="mono truncate text-[10.5px] tracking-[-0.05em] transition-colors duration-[180ms] hover:text-accent"
        >
          {row.runId}
        </Link>
      )}

      <span className="mono truncate text-[10px] tracking-[-0.03em] text-ink-3">{row.kind}</span>

      {/* Handoff § Empty & error states: "run failure | row status `ERROR` + one-line reason". */}
      <span className="flex min-w-0 flex-col items-start gap-1">
        <StatusMark status={status} />
        {reason === null ? null : (
          <span
            className="mono max-w-full truncate text-[9px] tracking-[-0.03em] text-danger-ink"
            title={reason}
          >
            {reason}
          </span>
        )}
      </span>

      <span
        className="mono truncate text-[9.5px] tracking-[-0.04em] text-ink-3"
        title={`${row.provider} / ${row.model}`}
      >
        {row.provider} / {row.model}
      </span>

      <span className="mono text-right text-[10px] tracking-[-0.03em] text-ink-2">
        {running ? <RunningClock startedAt={row.createdAt} /> : formatDur(row.durationMs)}
      </span>

      {running || row.launchFailed ? (
        // A failed launch's only artifact is its transcript, and Archive/Delete would 404 —
        // so its actions cell is the link to the log where the failure reason lives.
        <Link
          href={watch}
          data-row-watch={row.runId}
          className="mono text-right text-[9.5px] tracking-[0.04em] text-accent transition-colors duration-[180ms] hover:text-accent-hover"
        >
          {running ? "WATCH" : "LOG"}
        </Link>
      ) : (
        <RowActions ws={ws} runId={row.runId} area={archived ? "archive" : "runs"} />
      )}
    </div>
  );
}

/** One side of the `active` / `archived` segmented control. Selected = gold fill, dark text. */
function Toggle({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`mono rounded-[9px] px-2.5 py-1 text-[9.5px] tracking-[0.04em] uppercase transition-colors duration-[180ms] ${
        active ? "bg-accent font-medium text-accent-ink" : "text-muted hover:text-fg"
      }`}
    >
      {label}
    </Link>
  );
}

/** A kind count chip: `all 8` filled when active, the rest outlined. */
function Count({
  href,
  active,
  label,
  n,
}: {
  href: string;
  active: boolean;
  label: string;
  n: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`mono rounded-[10px] border px-2 py-0.5 text-[9.5px] tracking-[-0.02em] transition-colors duration-[180ms] ${
        active
          ? "border-transparent bg-chip-fill text-fg"
          : "border-rule-2 text-muted hover:border-rule-dotted hover:text-fg"
      }`}
    >
      {label} {n}
    </Link>
  );
}

/** 02 — the empty shell. Same treatment for the archived bucket, different sentence. */
function Empty({ archived, kind }: { archived: boolean; kind: RunKind | null }) {
  return (
    <div data-ledger-empty className="flex flex-col items-center gap-2.5 px-4 py-[52px] text-center">
      <p className="text-[15px] font-medium tracking-[-0.02em] text-ink-3">
        {archived ? "No archived runs" : "No runs yet — start a task above"}
      </p>
      <p className="mono text-[10px] tracking-[-0.03em] text-ink-faint">
        {archived
          ? kind === null
            ? "ARCH on a settled row moves it here"
            : `no archived ${kind} runs — ARCH on a settled row moves it here`
          : kind === null
            ? "the first run is filed here the moment it starts"
            : `no ${kind} runs yet — start one above`}
      </p>
    </div>
  );
}
