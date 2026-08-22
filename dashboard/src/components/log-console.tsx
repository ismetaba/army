import type { Ref, UIEventHandler } from "react";

/*
 * The run console (handoff § 04d): a tinted block with a 3px ink left bar, earlier lines faint,
 * the tail in ink, and a caret while the run is still writing.
 *
 * Presentational only — no hooks, no `node:` imports — so the run page's static Log tab and the
 * streaming live view render the identical box from the identical component. The live half owns
 * the scrolling (`boxRef` / `onScroll`); this file owns what a line looks like.
 *
 * Log text is a model's output and its tool results, i.e. UNTRUSTED (SPEC § Dashboard security
 * invariants #3). It is rendered as a React text child — never HTML, never a link built from it —
 * and `whitespace-pre` keeps the `[HH:mm:ss]` column aligned instead of soft-wrapping a line into
 * something that reads like two.
 */

/** How many lines at the tail are drawn in ink; everything before them recedes to `ink-faint`. */
const FRESH_TAIL = 6;

export function LogConsole({
  lines,
  /** Absolute index of `lines[0]`, so a key identifies a LINE and not a slot in a sliding window. */
  offset = 0,
  running = false,
  /** New lines rise in only while something is actually arriving. */
  animate = false,
  boxRef,
  onScroll,
  height = "h-[300px]",
}: {
  lines: readonly string[];
  offset?: number;
  running?: boolean;
  animate?: boolean;
  boxRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  height?: string;
}) {
  const freshFrom = Math.max(0, lines.length - FRESH_TAIL);

  return (
    <div
      ref={boxRef}
      onScroll={onScroll}
      data-live-output
      className={`min-w-0 overflow-auto border-l-[3px] border-fg bg-surface-2 px-5 py-[18px] ${height}`}
    >
      <div className="flex min-w-0 flex-col gap-2">
        {lines.map((line, i) => (
          <div
            key={offset + i}
            className={`mono text-[10.5px] leading-[1.7] whitespace-pre ${
              i >= freshFrom ? "text-fg" : "text-ink-faint"
            } ${animate && i >= freshFrom ? "anim-rise" : ""}`}
          >
            {line}
          </div>
        ))}

        {running ? (
          <div className="flex items-center gap-2" aria-hidden>
            <span className="mono text-[10.5px] text-accent">▸</span>
            <span className="anim-caret block h-[13px] w-[6px] bg-accent" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
