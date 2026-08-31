"use client";

/**
 * The task LAUNCHER (Glass § 02): the three kinds as three frosted cards in a 1fr grid — `1
 * Review` with the gold index on a slightly brighter pane, then `Test feature` and `Design
 * loop`. Hover lifts the card 3px and warms the border; a click opens the create sheet with
 * that type pre-selected.
 */

import { KINDS } from "./model";
import { useTaskLauncher } from "./task-launcher";

export function StartTask() {
  const { open } = useTaskLauncher();

  return (
    <section aria-label="Start a task" className="grid min-w-0 grid-cols-1 gap-4 min-[900px]:grid-cols-3">
      {KINDS.map((meta, index) => (
        <button
          key={meta.kind}
          type="button"
          onClick={() => open(meta.kind)}
          data-start-kind={meta.kind}
          className={`pane-card flex min-w-0 flex-col gap-2.5 rounded-[16px]! p-5 text-left focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] ${
            index === 0 ? "bg-pane-raised!" : ""
          }`}
        >
          <span className="flex items-baseline gap-2.5">
            <span className={`mono text-[10px] ${index === 0 ? "text-accent" : "text-ink-faint"}`}>
              {index + 1}
            </span>
            <span className="text-[17px] font-semibold tracking-[-0.025em] text-fg">{meta.title}</span>
          </span>
          <span className="text-[12.5px] leading-[1.55] text-ink-3 text-pretty">{meta.blurb}</span>
          <span className="mono mt-auto pt-1 text-[9.5px] tracking-[0.06em] text-accent">
            START →
          </span>
        </button>
      ))}
    </section>
  );
}
