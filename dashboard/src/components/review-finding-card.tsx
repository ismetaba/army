"use client";

import { useEffect, useRef, useState } from "react";
import type { Finding, Severity } from "@shared/schemas";

/**
 * One reviewer finding, and the severity vocabulary the rest of the Review view sorts and
 * filters by.
 *
 * Client-side because of the one interactive thing on the card: the Fix block copies to the
 * clipboard. Everything else here is static markup that could have been rendered on the server,
 * and is kept in this file only so the card and its badge cannot drift apart.
 */

/**
 * SPEC § Types, in descending order — the class map below IS the vocabulary, and its declaration
 * order IS the sort order and the chip order.
 *
 * Written out in full, never composed — Tailwind ships only the class names it can literally see
 * in the source, so `bg-[var(--sev-${severity}-bg)]` would compile to nothing at all.
 *
 * `Record<Severity, string>` is also the completeness guard `store.ts` argues for with
 * `RUN_KINDS = RunManifest.shape.kind.options`: a fifth severity added to the SPEC enum makes
 * THIS object a type error (a missing key) rather than quietly losing its badge, its chip and its
 * place in the sort. Deriving `SEVERITIES` from its keys, instead of hand-copying the list a
 * second time, is what extends that guard to the ordering — and it does so without a value import
 * from `@shared/schemas`, which would pull zod into this `"use client"` bundle for four strings.
 */
const SEVERITY_CLASS: Record<Severity, string> = {
  BLOCKER: "bg-[var(--sev-blocker-bg)] text-[var(--sev-blocker-fg)]",
  MAJOR: "bg-[var(--sev-major-bg)] text-[var(--sev-major-fg)]",
  MINOR: "bg-[var(--sev-minor-bg)] text-[var(--sev-minor-fg)]",
  NIT: "bg-[var(--sev-nit-bg)] text-[var(--sev-nit-fg)]",
};

export const SEVERITIES: readonly Severity[] = Object.keys(SEVERITY_CLASS) as Severity[];

export function severityRank(severity: Severity): number {
  const i = SEVERITIES.indexOf(severity);
  return i === -1 ? SEVERITIES.length : i;
}

export function SeverityBadge({
  severity,
  className = "",
}: {
  severity: Severity;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide ${SEVERITY_CLASS[severity]} ${className}`}
    >
      {severity}
    </span>
  );
}

export function FindingCard({
  finding,
  domId,
  focused = false,
  showLocation = true,
}: {
  finding: Finding;
  /** Anchor the sidebar scrolls to. Unique across the page. */
  domId: string;
  focused?: boolean;
  /** The diff row above the card already says where this is; the unanchored list does not. */
  showLocation?: boolean;
}) {
  return (
    <article
      id={domId}
      // `scroll-mt-16` keeps the card clear of the sticky site header when it is scrolled to.
      className={`scroll-mt-16 rounded-lg border bg-surface p-3 shadow-sm transition-colors ${
        focused ? "border-[var(--review-focus)] ring-2 ring-[var(--review-focus)]" : "border-line"
      }`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <SeverityBadge severity={finding.severity} />
        <h4 className="min-w-0 grow text-sm font-semibold break-words">{finding.title}</h4>
        {showLocation ? (
          <span className="font-mono text-xs break-all text-muted">
            {finding.file}:{finding.line}
          </span>
        ) : null}
      </header>

      <p className="mt-2 text-sm break-words">
        <span className="font-semibold text-muted">Risk: </span>
        {finding.risk}
      </p>

      <div className="mt-2 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-muted">Fix</span>
          <CopyButton value={finding.fix} />
        </div>
        {/* The fix is meant to be lifted into an editor, so it is a copy block, not prose:
            monospace, wrapping (a fix can be a long sentence) and never widening the card. */}
        <pre className="overflow-x-auto rounded border border-line bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap">
          {finding.fix}
        </pre>
      </div>
    </article>
  );
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Copy-to-clipboard with a real fallback.
 *
 * `navigator.clipboard` needs a secure context; `http://localhost:4400` IS one, so the async API
 * is the normal path. It is still absent when the panel is opened over a LAN address (`next dev`
 * prints one), which is exactly the case the deprecated `execCommand` path covers. A button that
 * silently did nothing there would be worse than either.
 */
function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const flash = (next: CopyState) => {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        flash("copied");
        return;
      }
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      flash(ok ? "copied" : "failed");
    } catch {
      flash("failed");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="rounded border border-line px-2 py-0.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}
