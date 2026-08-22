"use client";

/**
 * "Start a task" — the three kinds as three numbered entries divided by 1px rules (handoff § 02).
 *
 * Deliberately NOT cards. The ledger's whole device is that rules do the work boxes normally do,
 * and three bordered tiles here would make the page read as a dashboard of widgets rather than as
 * a page in a book.
 */

import { SectionHead } from "@/components/ledger/chrome";
import { KINDS } from "./model";
import { useTaskLauncher } from "./task-launcher";

export function StartTask() {
  const { open } = useTaskLauncher();

  return (
    <section className="flex min-w-0 flex-col gap-3.5">
      <SectionHead
        title="Start a task"
        aside={<span className="mono text-[9.5px] tracking-[0.06em] text-muted">THREE KINDS</span>}
      />

      <div className="grid grid-cols-1 gap-y-6 min-[900px]:grid-cols-3 min-[900px]:gap-y-0">
        {KINDS.map((meta, index) => (
          <div
            key={meta.kind}
            className={`flex flex-col gap-[9px] py-1 ${
              index === 0
                ? "min-[900px]:pr-6"
                : index === 1
                  ? "min-[900px]:border-l min-[900px]:border-line min-[900px]:px-6"
                  : "min-[900px]:border-l min-[900px]:border-line min-[900px]:pl-6"
            }`}
          >
            <div className="flex items-baseline gap-2.5">
              <span className={`mono text-[10px] ${index === 0 ? "text-accent" : "text-muted"}`}>
                {meta.index}
              </span>
              <h3 className="text-[17px] font-medium tracking-[-0.02em]">{meta.title}</h3>
            </div>
            <p className="text-[13px] leading-[1.55] text-ink-2 text-pretty">{meta.blurb}</p>
            <button
              type="button"
              onClick={() => open(meta.kind)}
              data-start-kind={meta.kind}
              className={`mono mt-0.5 min-h-11 self-start text-[9.5px] tracking-[0.06em] transition-colors duration-[180ms] min-[900px]:min-h-0 ${
                index === 0 ? "text-accent hover:text-accent-hover" : "text-ink-3 hover:text-fg"
              }`}
            >
              START →
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
