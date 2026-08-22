"use client";

/**
 * The workspace top bar (handoff § 02): switcher · repo path · backend health · SETTINGS ·
 * ← WORKSPACES, on 16/40px padding with a 1px rule under it.
 *
 * The switcher is the reason this is a client component. Handoff § Interactions: it "jumps
 * between workspaces without going back to entry", so it is a real menu over the registry rather
 * than a link back to `/`. It is a `<details>` — the disclosure state, the click-outside and the
 * keyboard behaviour come from the browser, which is both less code and better behaved than a
 * hand-rolled popover.
 */

import Link from "next/link";
import { useEffect, useRef } from "react";
import type { BackendHealth } from "./create-task-slip";

export interface WorkspaceChoice {
  name: string;
  runCount: number;
}

export function TopBar({
  ws,
  repoRoot,
  workspaces,
  backend,
}: {
  ws: string;
  repoRoot: string | null;
  workspaces: readonly WorkspaceChoice[];
  backend: BackendHealth;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-[18px] gap-y-3 border-b border-line px-4 py-4 min-[900px]:px-10">
      <div className="flex min-w-0 flex-wrap items-center gap-x-[18px] gap-y-2">
        <Switcher ws={ws} workspaces={workspaces} />
        <span className="mono hidden truncate text-[10px] tracking-[-0.03em] text-muted min-[900px]:inline">
          {repoRoot ?? "not registered in workspaces.json"}
        </span>
        <BackendMark backend={backend} />
      </div>

      <div className="flex items-center gap-[22px]">
        <Link
          href={`/settings?ws=${encodeURIComponent(ws)}`}
          className="mono flex min-h-11 items-center text-[9.5px] tracking-[0.06em] text-ink-3 transition-colors duration-[180ms] hover:text-fg min-[900px]:min-h-0"
        >
          SETTINGS
        </Link>
        <Link
          href="/"
          className="mono hidden min-h-11 items-center text-[9.5px] tracking-[0.06em] text-ink-3 transition-colors duration-[180ms] hover:text-fg min-[900px]:flex min-[900px]:min-h-0"
        >
          ← WORKSPACES
        </Link>
      </div>
    </header>
  );
}

/**
 * Backend health: a square AND the word, never a coloured dot on its own (handoff §
 * Accessibility). Three states, because "no backend configured" is not the same claim as "the
 * backend is down" and a workspace that never declared one must not be shown as broken.
 */
function BackendMark({ backend }: { backend: BackendHealth }) {
  const tone =
    backend.up === true ? "bg-ok" : backend.up === false ? "bg-danger" : "border border-dashed border-muted";
  return (
    <span
      data-backend={backend.up === null ? "none" : backend.up ? "up" : "down"}
      className="flex items-center gap-[7px] border-line pl-0 min-[900px]:border-l min-[900px]:pl-[18px]"
    >
      <span aria-hidden className={`size-1.5 flex-none ${tone}`} />
      <span
        className={`mono text-[9.5px] tracking-[-0.02em] ${backend.up === false ? "text-danger" : "text-ink-2"}`}
      >
        {backend.label}
      </span>
    </span>
  );
}

function Switcher({ ws, workspaces }: { ws: string; workspaces: readonly WorkspaceChoice[] }) {
  const box = useRef<HTMLDetailsElement>(null);

  // `<details>` has no click-outside of its own, and a menu that stays open behind the next thing
  // you click is worse than no menu.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const node = box.current;
      if (node !== null && node.open && !node.contains(event.target as Node)) node.open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && box.current?.open === true) box.current.open = false;
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <details ref={box} data-switcher className="relative">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-[9px] border border-fg px-2.5 py-1.5 [&::-webkit-details-marker]:hidden min-[900px]:min-h-0">
        <span className="mono max-w-[220px] truncate text-[11px] font-medium tracking-[-0.02em]">{ws}</span>
        <span aria-hidden className="text-[8px] text-ink-3">
          ▼
        </span>
      </summary>
      <nav
        aria-label="Switch workspace"
        className="absolute top-full left-0 z-40 mt-1 flex min-w-[240px] flex-col border border-rule-2 bg-surface"
      >
        {workspaces.map((w) => (
          <Link
            key={w.name}
            href={`/ws/${encodeURIComponent(w.name)}`}
            aria-current={w.name === ws ? "page" : undefined}
            className={`flex min-h-11 items-center justify-between gap-4 border-b border-line px-3 py-2.5 transition-colors duration-[180ms] last:border-b-0 hover:bg-paper-hover ${
              w.name === ws ? "bg-surface-2" : ""
            }`}
          >
            <span className="mono truncate text-[11px] tracking-[-0.02em]">{w.name}</span>
            <span className="mono flex-none text-[9px] text-muted">
              {w.runCount} {w.runCount === 1 ? "task" : "tasks"}
            </span>
          </Link>
        ))}
        <Link
          href="/"
          className="mono flex min-h-11 items-center border-t border-line px-3 py-2.5 text-[9.5px] tracking-[0.06em] text-accent transition-colors duration-[180ms] hover:bg-paper-hover"
        >
          ← ALL WORKSPACES
        </Link>
      </nav>
    </details>
  );
}
