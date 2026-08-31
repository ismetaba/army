import Link from "next/link";
import { formatAgo } from "@/lib/format";
import { machineText } from "@/lib/untrusted";
import { RunningChip } from "./running-chip";

/*
 * The entry screen's workspace CARDS (Glass § 01) — a three-column grid of frosted panes, not a
 * list. Everything here is a SERVER component: the cards are static once rendered, and the one
 * moving part (the elapsed clock in the running chip) is the only thing that crosses to the
 * client.
 *
 * Three shapes, one component:
 *  - ACTIVE  (a workspace with a running task) — `pane-live`: raised fill, gold border, the big
 *    shadow; a blip dot + RUNNING clock and the striped bar.
 *  - QUIET   — `pane-card`: big task count, `TASKS · 2D AGO`, a 5-bar sparkline of recent run
 *    durations on the right.
 *  - NEVER RUN — the quiet card with `0` in ink-4 and `—` where the sparkline would be.
 */

/** One workspace, already reduced to what the card draws. */
export interface EntryRow {
  name: string;
  /** Absolute repo path, or `null` for a run directory the registry has forgotten. */
  repoRoot: string | null;
  /** T23: the frontend repo, when the workspace spans two repositories — a second path line. */
  frontendRepo: string | null;
  taskCount: number;
  /** `createdAt` of the newest run, or `null` when the workspace has none. */
  lastRunAt: string | null;
  /** `createdAt` of the newest RUNNING run, or `null` — decides the card's shape. */
  runningSince: string | null;
  /** Durations (ms) of the most recent finished runs, oldest first — the sparkline. */
  durationsMs: number[];
  /**
   * False when the name is not a usable directory segment. Such a workspace has no page, so its
   * card is rendered without a link rather than as one that is guaranteed to 404.
   */
  usable: boolean;
}

/** The 32px circular monogram: the first two characters of the name on a tinted disc. */
function Monogram({ name, active }: { name: string; active: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex size-8 flex-none items-center justify-center rounded-full border text-[11px] font-semibold ${
        active
          ? "border-accent-line bg-accent-tint text-accent"
          : "border-rule-2 bg-chip-fill text-ink-2"
      }`}
    >
      {name.slice(0, 2).toLowerCase()}
    </span>
  );
}

/** The 5-bar sparkline of recent run durations. Pure CSS bars; `—` when there is nothing. */
function Sparkline({ durationsMs }: { durationsMs: number[] }) {
  if (durationsMs.length === 0) return <span className="mono text-[11px] text-ink-faint">—</span>;
  const recent = durationsMs.slice(-5);
  const max = Math.max(...recent, 1);
  return (
    <span aria-hidden className="flex h-7 items-end gap-1">
      {recent.map((ms, i) => (
        <span
          key={i}
          style={{ height: `${Math.max(18, Math.round((ms / max) * 100))}%` }}
          className="w-[5px] rounded-[2px] bg-rule-dotted"
        />
      ))}
    </span>
  );
}

export function ContentsRow({ row }: { row: EntryRow; index?: number }) {
  const running = row.runningSince !== null;

  const body = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-4">
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="min-w-0 truncate text-[24px] leading-[1.15] font-bold tracking-[-0.035em] text-fg">
            {row.name}
          </span>
          <span className="min-w-0 truncate font-mono text-[10px] leading-[1.4] tracking-[-0.03em] text-muted">
            {row.repoRoot === null ? "not in workspaces.json" : machineText(row.repoRoot)}
          </span>
          {/* T23: the second repo of a two-repo workspace, on its own line under the first. */}
          {row.frontendRepo !== null ? (
            <span className="min-w-0 truncate font-mono text-[10px] leading-[1.4] tracking-[-0.03em] text-muted">
              {machineText(row.frontendRepo)}
            </span>
          ) : null}
        </span>
        <Monogram name={row.name} active={running} />
      </div>

      {running ? (
        <div className="flex min-w-0 flex-col gap-3">
          <RunningChip since={row.runningSince!} />
          {/* The 4px striped bar — motion is reserved for the live card (§ Motion: `seep`). */}
          <div aria-hidden className="seep-bar h-1 w-full rounded-full opacity-90" />
        </div>
      ) : (
        <div className="flex min-w-0 items-end justify-between gap-4">
          <span className="flex flex-col gap-0.5">
            <span
              className={`text-[24px] leading-none font-bold tracking-[-0.035em] ${
                row.taskCount === 0 ? "text-muted" : "text-fg"
              }`}
            >
              {row.taskCount}
            </span>
            <span className="colhead">
              {row.taskCount === 0
                ? "never run"
                : `tasks${row.lastRunAt !== null ? ` · ${formatAgo(row.lastRunAt)}` : ""}`}
            </span>
          </span>
          <Sparkline durationsMs={row.durationsMs} />
        </div>
      )}

      <div className="flex min-w-0 items-baseline justify-between gap-4 border-t border-line pt-3.5">
        <span className="mono truncate text-[9.5px] tracking-[-0.03em] text-ink-faint">
          {!row.usable
            ? "unusable name"
            : running
              ? `${row.taskCount} ${row.taskCount === 1 ? "task" : "tasks"}${
                  row.lastRunAt !== null ? ` · ${formatAgo(row.lastRunAt)}` : ""
                }`
              : row.frontendRepo !== null
                ? "backend + frontend"
                : ""}
        </span>
        <span
          className={`mono text-[10px] tracking-[-0.02em] transition-colors duration-[180ms] ${
            running ? "text-accent" : "text-muted group-hover:text-accent"
          }`}
        >
          open →
        </span>
      </div>
    </>
  );

  const shape = `group flex min-w-0 flex-col gap-5 p-6 ${
    running ? "pane-live rounded-[18px]!" : "pane-card"
  }`;

  if (!row.usable) {
    return (
      <div className={`${shape} opacity-60`}>
        {body}
        <span className="sr-only">
          this workspace name is not a valid directory segment — the CLI cannot use it
        </span>
      </div>
    );
  }

  return (
    <Link
      href={`/ws/${encodeURIComponent(row.name)}`}
      className={`${shape} focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]`}
    >
      {body}
    </Link>
  );
}

/** Kept for the stacked/empty layout: a soft rule opening the list. */
export function ContentsRule() {
  return <div className="anim-draw h-px bg-line" />;
}
