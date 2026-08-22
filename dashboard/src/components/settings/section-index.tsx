"use client";

import { useEffect, useState } from "react";

/**
 * The 180px section index (handoff § 05).
 *
 * Plain in-page anchors, on purpose: an `<a href="#app">` jumps instantly, which is already the
 * `prefers-reduced-motion` behaviour — there is no smooth-scroll to suppress, and nothing here
 * animates. The only client-side part is which entry is marked current, and that is marked with a
 * 2px accent BAR as well as ink colour, so it does not read as colour alone.
 *
 * Below `lg` the index becomes a single wrapping row above the content rather than a column
 * beside it, which is what keeps 375 free of a sideways scroll.
 */
export interface SectionEntry {
  id: string;
  label: string;
}

export function SectionIndex({ entries }: { entries: readonly SectionEntry[] }) {
  const [active, setActive] = useState<string>(entries[0]?.id ?? "");
  const key = entries.map((entry) => entry.id).join(",");

  useEffect(() => {
    const targets = key
      .split(",")
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (targets.length === 0) return;

    // The section whose head has most recently passed the reading line, recomputed whenever any
    // of them crosses the viewport. Cheaper than a scroll listener and accurate enough for four
    // headings; `rootMargin` is what makes "crossed the line" fire at a quarter of the way down.
    // The observer delivers a first callback of its own accord once it has measured, so there is
    // no synchronous `setState` in this effect body — the initial mark arrives from the same code
    // path as every later one.
    const observer = new IntersectionObserver(
      () => {
        const line = window.innerHeight * 0.25;
        let current = targets[0]!.id;
        for (const element of targets) {
          if (element.getBoundingClientRect().top <= line) current = element.id;
        }
        setActive(current);
      },
      { rootMargin: "-25% 0px -70% 0px", threshold: [0, 1] },
    );
    for (const element of targets) observer.observe(element);
    return () => observer.disconnect();
  }, [key]);

  return (
    <nav
      aria-label="Settings sections"
      className="flex w-full min-w-0 flex-col gap-3 lg:w-[180px] lg:flex-none"
    >
      <span className="label text-accent!">Sections</span>
      <ul className="flex min-w-0 flex-row flex-wrap gap-x-4 gap-y-1 lg:flex-col lg:gap-x-0">
        {entries.map((entry) => {
          const current = entry.id === active;
          return (
            <li key={entry.id} className="min-w-0">
              <a
                href={`#${entry.id}`}
                aria-current={current ? "true" : undefined}
                onClick={() => setActive(entry.id)}
                // ≥44px tall on the 375 layout (handoff § Accessibility, "Targets"); the column
                // above `lg` keeps the design's tighter 2-line rhythm.
                className={`mono flex min-h-11 items-center border-l-2 py-1 pl-2.5 text-[11px] leading-[1.8] transition-colors duration-[180ms] focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px] lg:min-h-0 ${
                  current
                    ? "border-accent text-fg"
                    : "border-transparent text-ink-2 hover:text-fg"
                }`}
              >
                {entry.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
