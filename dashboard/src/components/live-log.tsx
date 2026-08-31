"use client";

/**
 * The running view (handoff § 04d) and the moment it finishes (§ 04d-2).
 *
 * The transport is unchanged from T22 and deliberately so — this task restyled the view, not the
 * stream. `EventSource`, not polling: the server holds one file offset per connection and pushes
 * what it appends; the client only ever concatenates. The three things that are easy to get wrong
 * here, and how each is still handled:
 *
 * 1. **`EventSource` reconnects by itself.** When the server closes a finished stream the browser
 *    would immediately reopen it — a run that ended half an hour ago would re-send its whole log
 *    forever. So the `end` event closes the connection from this side, explicitly, and the ref is
 *    nulled so nothing reopens it.
 * 2. **Auto-scroll must not fight the reader.** Scrolling up pauses it and says so; scrolling back
 *    to the bottom resumes it. The check is against a threshold, not equality, because a
 *    fractional `scrollHeight` never equals the sum exactly.
 * 3. **The log is unbounded and the DOM is not.** A long design-loop run writes megabytes. Only
 *    the last `MAX_CHARS` are kept in the buffer and only the last `MAX_LINES` of those are
 *    rendered; the file on disk keeps everything.
 *
 * What is NOT ported from the design reference is its timer-driven simulation. Every number on
 * this screen comes from the backend: the elapsed clock counts from the run's real `startedAt`,
 * the findings counter and the severity line are parsed out of the log lines the workflow
 * actually printed (`[MAJOR] api/server.mjs:22 — …`), and the progress rule is measured against
 * how long previous runs of this kind took — `null` when there is no history to measure against,
 * in which case the rule stays a plain track rather than inventing motion.
 *
 * The log text is untrusted (SPEC § Dashboard security invariants #3): a model's output and its
 * tool results, rendered as React text children — never HTML, never a link built from it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Severity } from "@shared/schemas";
import { LogConsole } from "@/components/log-console";
import { OutlineButton, QuietButton } from "@/components/ledger/chrome";
import { SEVERITIES, SEVERITY_INK } from "@/components/verdict";
import { clock } from "@/components/task-header";

/** Characters kept in the buffer. ~400 kB of text is far more than anyone scrolls back through. */
const MAX_CHARS = 400_000;
/** Lines kept in the DOM. The buffer keeps more; the file on disk keeps everything. */
const MAX_LINES = 600;

/** The workflow's own finding line: `[HH:mm:ss] [MAJOR] api/server.mjs:22 — title`. */
const FINDING_LINE = /\[(BLOCKER|MAJOR|MINOR|NIT)\]\s+\S+:\d+\s+—/;

export interface LiveLogProps {
  ws: string;
  /** The process to follow. `null` for a run being tailed by run id (no process, so no cancel). */
  pid: number | null;
  /** Known up front for a `?run=` stream; discovered from the `status` events for a `?pid=` one. */
  runId: string | null;
  /** The argv the child was given — the injection audit trail, kept under a disclosure. */
  argv: string[] | null;
  /** `false` when the server already knows the run is over (the page was opened on an old pid). */
  initiallyRunning: boolean;
  /** ISO 8601. The elapsed clock counts from here — never from when this component mounted. */
  startedAt: string;
  /** Median duration of previous runs of this kind, or `null` when there are none. */
  expectedMs: number | null;
  /** Frozen duration once the run is over, so the clock stops on the real number. */
  durationMs?: number | null;
}

type Phase = "connecting" | "streaming" | "ended" | "lost";

export function LiveLog({
  ws,
  pid,
  runId: initialRunId,
  argv,
  initiallyRunning,
  startedAt,
  expectedMs,
  durationMs = null,
}: LiveLogProps) {
  const router = useRouter();
  const [text, setText] = useState("");
  /*
   * Seeded from what the SERVER already knows, so a run that finished an hour ago does not render
   * for half a second as "running" while the first frame is in flight. `open` can only move it
   * forwards, never back to running.
   */
  const [phase, setPhase] = useState<Phase>(initiallyRunning ? "connecting" : "ended");
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [lastPing, setLastPing] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);

  const box = useRef<HTMLDivElement>(null);
  const source = useRef<EventSource | null>(null);
  /**
   * The accumulated log, in a ref as well as in state.
   *
   * A stream that is re-opened must start from an empty buffer, not append a second copy of the
   * file to the first. Keeping the text here rather than only in `setText(prev => …)` makes the
   * reset local to the effect that owns the connection — and made a duplicated log impossible
   * rather than merely unlikely. (It happened: see the deps below.)
   */
  const buffer = useRef("");

  /**
   * What this component is following. Deliberately a STRING, and deliberately the only thing the
   * stream effect depends on besides `ws`.
   *
   * The first version depended on `initialRunId`, which is `null` until the run announces itself.
   * When the run finished, `router.refresh()` re-rendered the server component, the prop changed
   * from `null` to the run id, the effect re-ran, and a second `EventSource` replayed the whole
   * log into a state that still held the first copy — the finished run page showed everything
   * twice. Caught in a screenshot, not by an assertion.
   */
  const streamKey = pid !== null ? `pid=${pid}` : initialRunId !== null ? `run=${initialRunId}` : null;

  // ── the stream ──────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (streamKey === null) return;
    buffer.current = "";

    const es = new EventSource(`/api/logs?ws=${encodeURIComponent(ws)}&${streamKey}`);
    source.current = es;

    const append = (chunk: string) => {
      const next = buffer.current + chunk;
      buffer.current = next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next;
      setText(buffer.current);
    };

    es.addEventListener("open", () => {
      // Every connection is primed with the file's tail from the server — including the
      // connections `EventSource` reopens BY ITSELF after a dropped one (laptop sleep, dev-server
      // restart). Starting each connection from an empty buffer is what keeps that self-heal from
      // appending a second copy of the log onto the first.
      buffer.current = "";
      setText("");
      setPhase((p) => (p === "connecting" ? "streaming" : p));
    });
    es.addEventListener("log", (event) => {
      const data = parse(event);
      if (typeof data?.text === "string") append(data.text);
    });
    es.addEventListener("status", (event) => {
      const data = parse(event);
      if (typeof data?.runId === "string") setRunId(data.runId);
      if (typeof data?.cancelRequested === "boolean") setCancelRequested(data.cancelRequested);
    });
    es.addEventListener("ping", (event) => {
      const data = parse(event);
      setLastPing(typeof data?.t === "string" ? data.t : new Date().toISOString());
    });
    es.addEventListener("end", (event) => {
      const data = parse(event);
      if (typeof data?.runId === "string") setRunId(data.runId);
      setPhase("ended");
      // Close from THIS side: a server-closed EventSource reconnects on its own, and a finished
      // run would replay its entire log every few seconds forever.
      es.close();
      source.current = null;
      // The header, the verdict banner and the ledger are server-rendered from the store; re-run
      // that render now that a manifest exists. This is what fills the Result tab in without a
      // refresh (handoff § Interactions, "Watching").
      router.refresh();
    });
    es.onerror = () => {
      // `readyState === CLOSED` means the browser gave up; otherwise it is reconnecting by itself.
      if (es.readyState === EventSource.CLOSED) setPhase((p) => (p === "ended" ? p : "lost"));
    };

    return () => {
      es.close();
      source.current = null;
    };
  }, [router, streamKey, ws]);

  // ── auto-scroll, paused by a manual scroll ──────────────────────────────────────────────────
  useEffect(() => {
    if (!follow) return;
    const node = box.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [text, follow]);

  const onScroll = useCallback(() => {
    const node = box.current;
    if (node === null) return;
    setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
  }, []);

  const running = phase !== "ended" && phase !== "lost";

  // ── what the summary row reports, all of it read out of the stream ──────────────────────────
  const allLines = useMemo(() => (text === "" ? [] : text.replace(/\n$/, "").split("\n")), [text]);
  const lines = useMemo(() => allLines.slice(-MAX_LINES), [allLines]);
  const offset = allLines.length - lines.length;

  const counts = useMemo(() => {
    const out: Record<Severity, number> = { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
    for (const line of allLines) {
      const m = FINDING_LINE.exec(line);
      if (m !== null) out[m[1] as Severity] += 1;
    }
    return out;
  }, [allLines]);
  const findings = SEVERITIES.reduce((n, s) => n + counts[s], 0);

  return (
    <div className="flex min-w-0 flex-col gap-3.5" data-live-log data-live-phase={phase}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-baseline gap-2">
            <Elapsed
              startedAt={startedAt}
              running={running}
              durationMs={durationMs}
              className="text-[22px] font-semibold tracking-[-0.03em]"
            />
            <span className="mono text-[9.5px] text-muted">{running ? "elapsed" : "duration"}</span>
          </span>

          <span className="h-4 w-px bg-line" aria-hidden />

          <span className="flex items-baseline gap-2">
            {/* `.anim-flip` replays whenever the value changes — the key is the value itself. */}
            <span key={findings} className="anim-flip mono text-[13px] font-medium">
              {findings}
            </span>
            <span className="mono text-[9.5px] text-muted">findings so far</span>
          </span>

          {findings > 0 ? (
            <>
              <span className="h-4 w-px bg-line" aria-hidden />
              <span className="flex flex-wrap items-baseline gap-x-2.5">
                {SEVERITIES.filter((s) => counts[s] > 0).map((s) => (
                  <span key={s} className={`mono text-[9.5px] ${SEVERITY_INK[s]}`}>
                    {counts[s]} {s}
                  </span>
                ))}
              </span>
            </>
          ) : null}
        </div>

        {follow ? (
          <span className="flex shrink-0 items-center gap-2.5" data-live-following>
            <span
              className={`h-1.5 w-1.5 ${running ? "mark-running" : "bg-muted"}`}
              aria-hidden
            />
            <span className="btnlabel text-muted">auto-scroll</span>
          </span>
        ) : (
          <button
            type="button"
            data-live-resume
            onClick={() => {
              const node = box.current;
              if (node !== null) node.scrollTop = node.scrollHeight;
              setFollow(true);
            }}
            className="btnlabel shrink-0 text-ink-3 transition-colors duration-[180ms] hover:text-fg"
          >
            paused — jump to end
          </button>
        )}
      </div>

      <ProgressRule startedAt={startedAt} expectedMs={expectedMs} done={!running} />

      {/* `aria-live="polite"` on the box, not on each line: a screen reader announces what arrived
          rather than re-reading the console, and the browser throttles it for us. */}
      <div aria-live="polite" aria-atomic="false" className="min-w-0">
        <LogConsole
          lines={lines}
          offset={offset}
          running={running && !cancelRequested}
          animate={running}
          boxRef={box}
          onScroll={onScroll}
        />
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="mono min-w-0 text-[9.5px] text-muted">
          {phase === "connecting"
            ? "connecting to the run…"
            : phase === "lost"
              ? "the stream was lost — reload to reconnect"
              : running
                ? cancelRequested
                  ? "cancelling — waiting for the process to stop"
                  : "the result tab fills in the moment the verdict lands — nothing to refresh"
                : lines.length === 0
                  ? "this run wrote no log"
                  : "stream closed"}
        </p>
        <div className="flex shrink-0 items-center gap-4">
          {lastPing !== null ? (
            <span className="mono text-[9px] text-muted" data-live-heartbeat={lastPing}>
              heartbeat {lastPing.slice(11, 19)}
            </span>
          ) : null}
          {runId === null && !running ? (
            <span className="mono text-[9.5px] text-muted" data-live-no-run>
              this process ended without saving a run
            </span>
          ) : null}
          {runId !== null && pid !== null ? (
            <Link
              href={`/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(runId)}`}
              data-live-run-link
              // The label is `.btnlabel`, which UPPERCASES — so the run id goes in the title, not
              // in the text: a mono id is not a thing to shout, and casing it is a lie about the
              // string.
              title={runId}
              className="btnlabel text-accent transition-colors duration-[180ms] hover:text-accent-hover"
            >
              open run →
            </Link>
          ) : null}
        </div>
      </div>

      {argv !== null && argv.length > 0 ? (
        <details className="mono min-w-0 text-[9.5px] text-muted">
          <summary className="btnlabel cursor-pointer text-ink-3 hover:text-fg">
            argv · {argv.length} arguments as the process received them
          </summary>
          <ol className="mt-2.5 flex min-w-0 flex-col gap-1.5" data-live-argv>
            {argv.map((value, index) => (
              <li key={index} className="flex min-w-0 gap-2.5">
                <span className="shrink-0 text-muted">[{index}]</span>
                {/* JSON.stringify so a value containing a newline, a quote or a `;` is visible as
                    ONE argument with those bytes in it. */}
                <code className="min-w-0 break-all whitespace-pre-wrap text-ink-2">
                  {JSON.stringify(value)}
                </code>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

/** SSE `data:` is always JSON here. A frame we cannot parse is dropped, never rendered raw. */
function parse(event: Event): Record<string, unknown> | null {
  const data = (event as MessageEvent<string>).data;
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// the clock
// ---------------------------------------------------------------------------

/**
 * The elapsed clock, counted from the run's real `startedAt` (handoff § State: "elapsed time is
 * computed client-side from `startedAt`").
 *
 * It renders `—` on the server and on the first client paint, then the real value: the number
 * depends on `Date.now()`, and rendering it during SSR would produce markup that cannot match
 * what the browser computes a moment later. `aria-live` is deliberately absent — a value that
 * changes every second is noise, and the run's status is announced when it lands.
 */
export function Elapsed({
  startedAt,
  running,
  durationMs = null,
  className = "",
}: {
  startedAt: string;
  running: boolean;
  durationMs?: number | null;
  className?: string;
}) {
  const now = useNow(running, 1000);

  if (durationMs !== null && !running) {
    return <span className={className}>{clock(durationMs)}</span>;
  }

  const started = new Date(startedAt).getTime();
  const value = now === null || Number.isNaN(started) ? null : Math.max(0, now - started);
  return <span className={className}>{value === null ? "—" : clock(value)}</span>;
}

/**
 * `Date.now()`, ticking — as an external store rather than as state written from an effect.
 *
 * The wall clock IS an external system, which is exactly what `useSyncExternalStore` is for, and
 * it is the only shape that gets the SSR half right for free: `getServerSnapshot` returns `null`,
 * so the server (and the hydrating client) render `—` and the real value arrives on the first
 * commit after hydration. A `useState` + `useEffect` version either renders a server-side
 * timestamp that cannot match the browser's, or writes state synchronously from an effect.
 */
function useNow(active: boolean, intervalMs: number): number | null {
  const snapshot = useRef(0);

  const subscribe = useCallback(
    (onChange: () => void) => {
      snapshot.current = Date.now();
      onChange();
      if (!active) return () => {};
      const id = setInterval(() => {
        snapshot.current = Date.now();
        onChange();
      }, intervalMs);
      return () => clearInterval(id);
    },
    [active, intervalMs],
  );

  return useSyncExternalStore(
    subscribe,
    () => (snapshot.current === 0 ? null : snapshot.current),
    () => null,
  );
}

/**
 * The 3px progress rule with the ink nib riding its right edge (handoff § 04d).
 *
 * There is no progress signal in an agent run — it finishes when the model stops — so the rule is
 * measured against the only real yardstick the store has: how long previous runs of this kind
 * took. It is capped below the end so it never claims to be finished before the run is, and with
 * no history to measure against (`expectedMs === null`) it stays an empty track rather than
 * animating a number nobody computed.
 */
function ProgressRule({
  startedAt,
  expectedMs,
  done,
}: {
  startedAt: string;
  expectedMs: number | null;
  done: boolean;
}) {
  const now = useNow(!done, 900);

  const started = new Date(startedAt).getTime();
  const elapsed = now === null || Number.isNaN(started) ? 0 : Math.max(0, now - started);
  const fraction = done
    ? 1
    : expectedMs === null || expectedMs <= 0
      ? 0
      : Math.min(0.95, elapsed / expectedMs);
  const percent = `${(fraction * 100).toFixed(1)}%`;

  return (
    <div
      className="relative h-[6px] w-full min-w-0 overflow-hidden rounded-full bg-surface-2"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction * 100)}
      aria-label={
        expectedMs === null
          ? "progress — no previous run of this kind to estimate against"
          : `progress, estimated against previous runs of this kind (${clock(expectedMs)})`
      }
    >
      <div
        className="seep-bar absolute top-0 left-0 h-full rounded-full transition-[width] duration-[900ms] ease-linear motion-reduce:transition-none"
        style={{ width: percent }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// header actions
// ---------------------------------------------------------------------------

/**
 * `CANCEL RUN` — the outline button that fills danger on hover (handoff § 04d).
 *
 * Only ever rendered where the pid is unambiguous, i.e. the live view of a process this panel
 * started. The run page has a run id and no pid (the CLI announces the id at the very END of the
 * run, so a running manifest cannot be matched back to a process), and guessing which of the
 * workspace's processes to kill is not a thing a destructive button may do.
 */
export function CancelRunButton({ pid }: { pid: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pid }),
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setError(body?.message ?? `cancel failed (HTTP ${response.status})`);
        setBusy(false);
      }
    } catch {
      setError("the panel could not reach /api/cancel");
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1.5" data-live-cancel>
      <OutlineButton danger disabled={busy} onClick={() => void cancel()}>
        {busy ? "cancelling…" : "cancel run"}
      </OutlineButton>
      {error !== null ? (
        <span className="mono max-w-[260px] text-[9px] break-words text-danger">{error}</span>
      ) : null}
    </div>
  );
}

/**
 * The bar that appears the moment a run lands (handoff § 04d-2): status, duration, and the two
 * things there are to do about it.
 *
 * ARCHIVE files the run away and leaves for the ledger, because the run page it was archived from
 * reads `runs/` and would 404 the instant the move succeeded.
 */
export function FinishedBar({
  ws,
  runId,
  resultHref,
  durationMs,
  children,
}: {
  ws: string;
  runId: string;
  /** `null` when the run saved no result block — then there is nothing to open. */
  resultHref: string | null;
  durationMs: number | null;
  /** The status mark and word, rendered by the server so the vocabulary stays in one place. */
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const archive = async () => {
    setBusy(true);
    setError(null);
    try {
      const q = new URLSearchParams({ ws, run: runId });
      const response = await fetch(`/api/runs/archive?${q}`, { method: "POST" });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setError(body?.message ?? `archive failed (HTTP ${response.status})`);
        setBusy(false);
        return;
      }
      router.push(`/ws/${encodeURIComponent(ws)}`);
    } catch {
      setError("the panel could not reach /api/runs/archive");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-5 gap-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        {children}
        <span className="mono text-[9.5px] text-muted">{clock(durationMs)}</span>
      </div>
      <div className="flex shrink-0 items-center gap-5">
        {error !== null ? (
          <span className="mono max-w-[280px] text-[9px] break-words text-danger">{error}</span>
        ) : null}
        <span data-finished-archive>
          <QuietButton disabled={busy} onClick={() => void archive()}>
            {busy ? "archiving…" : "archive"}
          </QuietButton>
        </span>
        {resultHref !== null ? (
          // A link, styled as the accent button — never a <button> inside an <a>.
          <Link
            href={resultHref}
            data-finished-open
            className="btnlabel tap rounded-[13px] bg-accent px-5 py-[11px] text-accent-ink transition-all duration-[180ms] hover:-translate-y-px hover:bg-accent-hover hover:shadow-[0_14px_28px_-14px_#e8b04b]"
          >
            open result
          </Link>
        ) : null}
      </div>
    </div>
  );
}
