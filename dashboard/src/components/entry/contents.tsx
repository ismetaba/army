import Link from "next/link";
import { Leader } from "@/components/ledger/chrome";
import { formatAgo } from "@/lib/format";
import { RunningChip } from "./running-chip";

/*
 * The entry screen's table of contents (handoff § 01) — a numbered, ruled list, not a grid of
 * cards. Everything here is a SERVER component: the rows are static once rendered, and the one
 * moving part (the elapsed clock in the running chip) is the only thing that crosses to the client.
 *
 * Two notes on why the type helpers below are spelled `font-mono tracking-[…]` rather than the
 * foundation's `.mono`: the design gives each mono run its own tracking (-0.02em for the index,
 * -0.03em for paths and meta), and `.mono` — being unlayered CSS in globals.css — outranks every
 * Tailwind tracking utility no matter the class order. `.mono` is used elsewhere, where its
 * -0.045em is the value the design asks for.
 *
 * The row is one flex line at 1440 (index · name · dotted leader · meta · arrow) and stacks into
 * two lines below 640px. That is not decoration: an absolute repo path plus a 120px meta column
 * plus the running chip cannot share 375px, and the hard rule (§ Interactions) is that the PAGE
 * never scrolls sideways. The path truncates inside its own `min-w-0` box for the same reason.
 */

/** One line of the contents list, already reduced to what the row draws. */
export interface EntryRow {
  name: string;
  /** Absolute repo path, or `null` for a run directory the registry has forgotten. */
  repoRoot: string | null;
  taskCount: number;
  /** `createdAt` of the newest run, or `null` when the workspace has none. */
  lastRunAt: string | null;
  /** `createdAt` of the newest RUNNING run, or `null` — drives the chip and the accent index. */
  runningSince: string | null;
  /**
   * False when the name is not a usable directory segment. Such a workspace has no page, so its
   * row is rendered without a link rather than as one that is guaranteed to 404.
   */
  usable: boolean;
}

/** `1 task · 5m ago` · `7 tasks · 2d ago` · `no tasks` — the right-aligned meta of a row. */
function metaOf(row: EntryRow): string {
  if (!row.usable) return "unusable name";
  if (row.taskCount === 0) return "no tasks";
  const tasks = `${row.taskCount} ${row.taskCount === 1 ? "task" : "tasks"}`;
  const ago = row.lastRunAt === null ? "" : formatAgo(row.lastRunAt);
  return ago === "" ? tasks : `${tasks} · ${ago}`;
}

export function ContentsRow({ row, index }: { row: EntryRow; index: number }) {
  const running = row.runningSince !== null;

  const body = (
    <>
      {/* index + name keep company on one line at every width; the leader and meta are what move. */}
      <div className="flex min-w-0 items-baseline gap-5">
        <span
          aria-hidden
          className={`w-[26px] flex-none font-mono text-[11px] tracking-[-0.02em] ${
            running ? "text-accent" : "text-muted"
          }`}
        >
          {String(index).padStart(2, "0")}
        </span>

        {/*
          Explicit leading on both lines. The artboard sets each run with the `font:` shorthand,
          which resets line-height to `normal`; inheriting the body's 1.6 instead adds ~18px to
          every row and the list stops reading as a ruled ledger.
        */}
        <span className="flex min-w-0 flex-col gap-2">
          <span className="min-w-0 truncate text-[24px] leading-[1.2] font-medium tracking-[-0.02em] text-fg">
            {row.name}
          </span>
          <span className="min-w-0 truncate font-mono text-[10.5px] leading-[1.3] tracking-[-0.03em] text-muted">
            {row.repoRoot ?? "not in workspaces.json"}
          </span>
        </span>
      </div>

      {/* `contents` so the foundation's `.leader` stays a direct flex item of the row. */}
      <span className="hidden sm:contents">
        <Leader />
      </span>

      {/*
        The chip travels with the meta, not with the name: that is where the artboard puts it, and
        it is what lets the dotted leader run from the name all the way to the row's status.
        (The handoff's prose says "next to its name"; the artboard's markup is the tie-breaker.)
        Indented on the stacked layout so it lines up under the name rather than under the index.
      */}
      <div className="ml-[46px] flex max-w-full flex-none flex-wrap items-center gap-x-[22px] gap-y-2 sm:ml-0 sm:flex-nowrap">
        {row.runningSince !== null && <RunningChip since={row.runningSince} />}
        {/* meta and arrow stay welded together, so when the chip pushes them onto a second line
            at 375 the arrow goes with its row rather than stranding on a line of its own. */}
        <span className="flex items-center gap-[22px]">
          <span className="font-mono text-[10.5px] leading-[1.3] tracking-[-0.03em] whitespace-nowrap text-ink-2 sm:w-[120px] sm:text-right">
            {metaOf(row)}
          </span>
          {/* Idle arrows sit back in `rule-dotted`; accent is reserved for the live workspace and
              for the row being pointed at (handoff § Colour: "the one live mark"). */}
          <span
            aria-hidden
            className={`text-[16px] leading-none transition-transform duration-200 ${
              row.usable ? "group-hover:translate-x-1" : ""
            } ${running ? "text-accent" : "text-rule-dotted group-hover:text-accent"}`}
          >
            →
          </span>
        </span>
      </div>
    </>
  );

  const shape =
    "group flex flex-col gap-3 border-b border-line pt-[22px] pb-5 " +
    "transition-colors duration-[180ms] sm:flex-row sm:items-baseline sm:gap-5";

  if (!row.usable) {
    return (
      <div className={`${shape} opacity-70`}>
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
      className={`${shape} hover:bg-paper-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}
    >
      {body}
    </Link>
  );
}

/**
 * The 2px ink rule that opens the list, drawn in from the left on load (handoff § Motion: `draw`).
 * `.anim-draw` already stands down under `prefers-reduced-motion`.
 */
export function ContentsRule() {
  return <div className="anim-draw h-0.5 bg-fg" />;
}
