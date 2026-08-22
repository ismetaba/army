import Link from "next/link";
import { SectionHead } from "@/components/ledger/chrome";
import { StatusMark } from "@/components/ledger/marks";
import { RowActions } from "./row-actions";
import { RunningClock } from "./running-clock";
import {
  formatClock,
  formatDur,
  KINDS,
  ledgerStatus,
  wsHref,
  type LedgerRow,
  type RunKind,
} from "./model";

/**
 * The ledger itself (handoff § 02): a ruled table, not a list of cards.
 *
 * The grid is the design's, to the fraction: `64px 1.7fr 0.9fr 1.15fr 1.5fr 0.6fr 0.8fr` with a
 * 14px gap and 14px row padding. It is declared once, in `GRID`, because a header whose columns
 * disagree with its rows by one value is the failure mode of every hand-built table.
 *
 * The whole grid lives inside its own `overflow-x-auto` box with a min-width under it: at a narrow
 * desktop the TABLE scrolls sideways and the page does not (handoff § Interactions, "the page
 * itself never scrolls horizontally at any width"). Below 900px this table is not rendered at all
 * — `MobileLedger` takes over with stacked blocks.
 *
 * A server component. Only the two things that cannot be static are client islands: the running
 * row's clock, and the per-row Archive/Delete.
 */

const GRID = "grid grid-cols-[64px_1.7fr_0.9fr_1.15fr_1.5fr_0.6fr_0.8fr] gap-[14px] items-center";
const COLUMNS = ["TIME", "TASK", "TYPE", "STATUS", "PROVIDER / MODEL", "DUR", "ACTIONS"];

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
    <section className="flex min-w-0 flex-col">
      <SectionHead
        title={
          <span className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
            <span>Ledger</span>
            <span className="flex items-baseline gap-3">
              <Toggle href={wsHref(ws, { kind })} active={!archived} label="ACTIVE" />
              <Toggle href={wsHref(ws, { kind, archived: true })} active={archived} label="ARCHIVED" />
            </span>
          </span>
        }
        aside={
          <span className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
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
        }
      />

      {rows.length === 0 ? (
        <Empty archived={archived} kind={kind} />
      ) : (
        <div className="min-w-0 overflow-x-auto">
          <div className="min-w-[880px]">
            <div className={`${GRID} border-b border-line py-[9px]`}>
              {COLUMNS.map((column) => (
                <span key={column} className={`colhead ${column === "ACTIONS" ? "text-right" : ""}`}>
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
        <p className="mono pt-3.5 text-[9.5px] tracking-[-0.03em] text-muted">
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
  const watch =
    row.pid !== null
      ? `/ws/${encodeURIComponent(ws)}/live?pid=${row.pid}`
      : `/ws/${encodeURIComponent(ws)}/live?run=${encodeURIComponent(row.runId)}`;

  return (
    <div
      data-ledger-row={row.runId}
      data-running={running ? "" : undefined}
      // The 3px accent inset bar is a shadow rather than a border so it does not take a pixel out
      // of the grid and shift the running row's columns out of line with every other row.
      style={running ? { boxShadow: "inset 3px 0 0 var(--accent)" } : undefined}
      className={`${GRID} border-b border-line py-3.5 transition-colors duration-[180ms] ${
        running ? "bg-surface-2 pl-3" : "hover:bg-paper-hover"
      }`}
    >
      <span className="mono text-[9.5px] tracking-[-0.03em] text-muted">{formatClock(row.createdAt)}</span>

      <Link
        href={`/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(row.runId)}`}
        title={row.runId}
        className="mono truncate text-[10.5px] tracking-[-0.04em] transition-colors duration-[180ms] hover:text-accent"
      >
        {row.runId}
      </Link>

      <span className="mono truncate text-[10px] tracking-[-0.03em] text-ink-2">{row.kind}</span>

      <StatusMark status={status} />

      <span
        className="mono truncate text-[9.5px] tracking-[-0.04em] text-ink-2"
        title={`${row.provider} / ${row.model}`}
      >
        {row.provider} / {row.model}
      </span>

      <span className="mono text-[10px] tracking-[-0.03em]">
        {running ? <RunningClock startedAt={row.createdAt} /> : formatDur(row.durationMs)}
      </span>

      {running ? (
        <Link
          href={watch}
          data-row-watch={row.runId}
          className="mono text-right text-[9.5px] tracking-[0.04em] text-accent transition-colors duration-[180ms] hover:text-accent-hover"
        >
          WATCH
        </Link>
      ) : (
        <RowActions ws={ws} runId={row.runId} area={archived ? "archive" : "runs"} />
      )}
    </div>
  );
}

function Toggle({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`mono text-[9.5px] tracking-[0.06em] transition-colors duration-[180ms] ${
        active ? "border-b-2 border-accent pb-0.5 font-medium text-fg" : "text-muted hover:text-fg"
      }`}
    >
      {label}
    </Link>
  );
}

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
      className={`mono text-[9.5px] tracking-[-0.02em] transition-colors duration-[180ms] ${
        active ? "text-fg" : "text-muted hover:text-fg"
      }`}
    >
      {label} {n}
    </Link>
  );
}

/** 02b — the empty ledger. Same treatment for the archived bucket, different sentence. */
function Empty({ archived, kind }: { archived: boolean; kind: RunKind | null }) {
  return (
    <div data-ledger-empty className="flex flex-col items-center gap-2.5 px-4 pt-[52px] pb-2 text-center">
      <p className="text-[17px] font-medium tracking-[-0.02em]">
        {archived ? "No archived runs" : "No entries yet"}
      </p>
      <p className="mono text-[10px] tracking-[-0.03em] text-muted">
        {archived
          ? kind === null
            ? "ARCH on a finished row moves it here"
            : `no archived ${kind} runs — ARCH on a finished row moves it here`
          : kind === null
            ? "start a task above — the first run is filed here"
            : `no ${kind} runs yet — start one above`}
      </p>
    </div>
  );
}
