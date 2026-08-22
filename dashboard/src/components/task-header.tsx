import Link from "next/link";
import type { ReactNode } from "react";
import { CommandStrip } from "@/components/ledger/chrome";
import { StatusMark, type LedgerStatus } from "@/components/ledger/marks";
import type { RunManifest } from "@shared/schemas";

/*
 * The task-detail chrome (handoff § 04 · Task detail (shared header)).
 *
 * ONE header for every task type — only the body under the tabs changes. It is deliberately a
 * dumb, server-safe module: no `node:` imports, no hooks, no fs. Both the run page (which reads a
 * manifest) and the live page (which follows a process that has not written one yet) render the
 * same furniture from plain props, which is the only way the two views can be guaranteed to look
 * identical.
 *
 * Everything printed here is run content — a run id, an agent-chosen model name, the command line
 * — and is rendered as TEXT (SPEC § Dashboard security invariants #3). The only links are ones
 * this module builds itself: `/api/artifact?…` URLs handed down by the server, and in-page
 * anchors. A string out of a manifest never becomes an href.
 */

const TRACK_LABEL = { letterSpacing: "0.12em" } as const;

// ---------------------------------------------------------------------------
// status vocabulary
// ---------------------------------------------------------------------------

/**
 * The manifest's status, translated into the ledger's five-word vocabulary.
 *
 * A finished `design-loop` is not simply DONE: the loop stops on purpose and waits for a note
 * back (handoff § 04c), so it is filed as AWAITING FEEDBACK — the hollow amber square — which is
 * what the right-hand column of that screen then explains. Every other kind keeps its own status.
 */
export function ledgerStatus(run: Pick<RunManifest, "kind" | "status">): LedgerStatus {
  return run.kind === "design-loop" && run.status === "done" ? "awaiting" : run.status;
}

/**
 * `2m34s`, `44s` — the ledger's own duration spelling.
 *
 * Not `formatDuration` from `lib/format.ts`: that one prints `2m 34s` / `12.8s` and is what the
 * ledger table uses. The task screens print the compact form the artboards carry, and the two
 * live side by side, so the difference is deliberate rather than drift.
 */
export function clock(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const secs = Math.floor(ms / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m === 0 ? `${s}s` : `${m}m${String(s).padStart(2, "0")}s`;
}

/** `22 Aug 09:58` — the header's CREATED stamp, in local time like every other time in the panel. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// top bar
// ---------------------------------------------------------------------------

/** `← LEDGER  <workspace>` on the left, `SETTINGS` on the right, 1px rule under (handoff § 04). */
export function TaskTopBar({ ws }: { ws: string }) {
  return (
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-10 py-4">
      <div className="flex min-w-0 items-center gap-4">
        <Link
          href={`/ws/${encodeURIComponent(ws)}`}
          className="btnlabel shrink-0 text-ink-3 transition-colors duration-[180ms] hover:text-fg"
        >
          ← ledger
        </Link>
        {/* The workspace name is a registry string, printed as text. */}
        <span className="mono min-w-0 text-[11px] font-medium break-all">{ws}</span>
      </div>
      <Link
        href="/settings"
        className="btnlabel shrink-0 text-ink-3 transition-colors duration-[180ms] hover:text-fg"
      >
        settings
      </Link>
    </header>
  );
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

export interface MetaItem {
  label: string;
  value: ReactNode;
}

export interface ArtifactItem {
  label: string;
  /** `/api/artifact?…` or an in-page anchor. `null` renders the label as a missing file. */
  href: string | null;
}

/**
 * The shared header block: 2px ink rule, task id + status, the meta row, the command strip, and
 * the artifact links on the right.
 *
 * `aside` is the slot the running view puts CANCEL RUN in and the design view puts COMPARE WITH
 * in — anything interactive, which has to be a client island the page passes down.
 */
export function TaskHeader({
  runId,
  status,
  meta,
  command,
  artifacts,
  artifactsNote,
  aside,
}: {
  runId: string;
  status: LedgerStatus;
  meta: MetaItem[];
  /** The exact command line. COPY puts this string on the clipboard, byte for byte. */
  command: string;
  artifacts: ArtifactItem[];
  /** Shown instead of the links when there is nothing yet — `pending` while a run is going. */
  artifactsNote?: string;
  aside?: ReactNode;
}) {
  return (
    <>
      <div className="h-0.5 bg-fg" />
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-line py-5">
        <div className="flex min-w-0 flex-1 basis-[420px] flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="mono min-w-0 text-[15px] break-all">{runId}</h1>
            <StatusMark status={status} />
          </div>

          <dl className="flex min-w-0 flex-wrap items-baseline gap-x-[26px] gap-y-2">
            {meta.map((item) => (
              <div key={item.label} className="flex min-w-0 items-baseline gap-2">
                <dt className="colhead shrink-0">{item.label}</dt>
                <dd className="mono min-w-0 text-[10px] break-all">{item.value}</dd>
              </div>
            ))}
          </dl>

          <CommandStrip command={command} className="min-w-0 max-w-[640px]" />
        </div>

        <div className="flex shrink-0 flex-col items-end gap-3">
          {aside}
          <div className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3.5 gap-y-1">
            <span className="colhead shrink-0">artifacts</span>
            {artifacts.length === 0 ? (
              <span className="mono text-[10px] text-muted">{artifactsNote ?? "none"}</span>
            ) : (
              artifacts.map((a) =>
                a.href === null ? (
                  // The manifest names it, the store does not have it. A link would 404; saying so
                  // is the whole message.
                  <span key={a.label} className="mono text-[10px] text-muted" title="file missing">
                    <span className="line-through">{a.label}</span> missing
                  </span>
                ) : (
                  <a
                    key={a.label}
                    href={a.href}
                    className="mono border-b border-accent text-[10px] text-accent transition-colors duration-[180ms] hover:border-accent-hover hover:text-accent-hover"
                  >
                    {a.label}
                  </a>
                ),
              )
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------

export interface TabItem {
  id: string;
  label: string;
  /** `null` for a tab that is not reachable yet — RESULT while the run is still going. */
  href: string | null;
  title?: string;
}

/** `RESULT · LOG`, the active one underlined 2px accent (handoff § 04). */
export function TaskTabs({ items, active }: { items: TabItem[]; active: string }) {
  return (
    <nav className="flex min-w-0 flex-wrap items-baseline gap-x-[22px] pt-3.5" aria-label="Task views">
      {items.map((item) => {
        const isActive = item.id === active;
        const className = `btnlabel pb-1.5 ${
          isActive ? "border-b-2 border-accent text-fg" : "text-muted"
        }`;
        if (item.href === null || isActive) {
          return (
            <span
              key={item.id}
              title={item.title}
              aria-current={isActive ? "page" : undefined}
              className={`${className} ${item.href === null ? "opacity-60" : ""}`}
              style={TRACK_LABEL}
            >
              {item.label}
            </span>
          );
        }
        return (
          <Link
            key={item.id}
            href={item.href}
            className={`${className} transition-colors duration-[180ms] hover:text-fg`}
            style={TRACK_LABEL}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// shared body furniture
// ---------------------------------------------------------------------------

/** A 2px-ruled head over a body section — the design's main structural device, inline variant. */
export function RuledHead({
  title,
  aside,
  className = "",
}: {
  title: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-fg pb-2.5 ${className}`}
    >
      <h2 className="min-w-0 text-[18px] font-semibold tracking-[-0.02em] break-words">{title}</h2>
      {aside}
    </div>
  );
}

/** A quieter head: a small-caps label over a 1px hairline. Used down the right-hand columns. */
export function LabelHead({ children }: { children: ReactNode }) {
  return <div className="colhead border-b border-line pb-2">{children}</div>;
}

/** The one empty-state treatment on these screens: a sentence between hairlines, never a card. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-y border-line px-4 py-6 text-center text-[13px] text-ink-2">{children}</p>
  );
}
