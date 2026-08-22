"use client";

/**
 * The live view: a run's output as it is produced, with a Cancel button (T22 step 3).
 *
 * `EventSource`, not polling. The server holds one file offset per connection and pushes what it
 * appends; the client only ever concatenates. The three things that are easy to get wrong here,
 * and how each is handled:
 *
 * 1. **`EventSource` reconnects by itself.** When the server closes a finished stream, the browser
 *    would immediately reopen it — a run that ended half an hour ago would re-send its whole log
 *    forever. So the `end` event closes the connection from this side, explicitly, and the ref is
 *    nulled so nothing reopens it.
 * 2. **Auto-scroll must not fight the reader.** Scrolling up pauses it (T22 step 3, "pause on
 *    manual scroll") and says so; scrolling back to the bottom resumes it. The check is against a
 *    threshold, not equality, because a fractional `scrollHeight` never equals the sum exactly.
 * 3. **The log is unbounded and the DOM is not.** A long design-loop run writes megabytes. Only
 *    the last `MAX_CHARS` are kept in the node; the file on disk keeps everything and the finished
 *    run page reads it from there.
 *
 * The text itself is untrusted (SPEC § Dashboard security invariants #3): it is a model's output
 * and its tool results, rendered into a `<pre>` as a React text child — never HTML, never a link
 * built from it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import type { RunStatus } from "@/lib/store";
import { isRunStatus } from "@/lib/trigger-args";

/** Characters kept in the DOM. ~2 MB of text is already far more than anyone scrolls back through. */
const MAX_CHARS = 400_000;

export interface LiveLogProps {
  ws: string;
  /** The process to follow. `null` for a finished run being replayed by run id. */
  pid: number | null;
  /** Known up front for a `?run=` stream; discovered from the `status` events for a `?pid=` one. */
  runId: string | null;
  kind: string | null;
  /** The command line, for the header. Display only. */
  display: string | null;
  /** The argv the child was given — the audit trail, shown under a disclosure. */
  argv: string[] | null;
  /** `false` when the server already knows the run is over (the page was opened on an old pid). */
  initiallyRunning: boolean;
}

type Phase = "connecting" | "streaming" | "ended" | "lost";

export function LiveLog({
  ws,
  pid,
  runId: initialRunId,
  kind,
  display,
  argv,
  initiallyRunning,
}: LiveLogProps) {
  const router = useRouter();
  const [text, setText] = useState("");
  /*
   * Seeded from what the SERVER already knows, so a run that finished an hour ago does not
   * render for half a second as "Running" with a spinning badge while the first frame is in
   * flight. `open` can only move it forwards, never back to running.
   */
  const [phase, setPhase] = useState<Phase>(initiallyRunning ? "connecting" : "ended");
  const [runId, setRunId] = useState<string | null>(initialRunId);
  const [status, setStatus] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);

  const box = useRef<HTMLPreElement>(null);
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

    es.addEventListener("open", () => setPhase((p) => (p === "connecting" ? "streaming" : p)));
    es.addEventListener("log", (event) => {
      const data = parse(event);
      if (typeof data?.text === "string") append(data.text);
    });
    es.addEventListener("status", (event) => {
      const data = parse(event);
      if (typeof data?.runId === "string") setRunId(data.runId);
      if (typeof data?.status === "string") setStatus(data.status);
      if (typeof data?.cancelRequested === "boolean") setCancelRequested(data.cancelRequested);
    });
    es.addEventListener("ping", (event) => {
      const data = parse(event);
      setLastPing(typeof data?.t === "string" ? data.t : new Date().toISOString());
    });
    es.addEventListener("end", (event) => {
      const data = parse(event);
      if (typeof data?.runId === "string") setRunId(data.runId);
      if (typeof data?.status === "string") setStatus(data.status);
      setPhase("ended");
      // Close from THIS side: a server-closed EventSource reconnects on its own, and a finished
      // run would replay its entire log every few seconds forever.
      es.close();
      source.current = null;
      // The workspace tables and the run page are server-rendered from the store; re-render them
      // now that a manifest exists.
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
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setFollow(atBottom);
  }, []);

  const toBottom = () => {
    const node = box.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
    setFollow(true);
  };

  // ── cancel ──────────────────────────────────────────────────────────────────────────────────
  const cancel = useCallback(async () => {
    if (pid === null) return;
    setCancelError(null);
    setCancelRequested(true);
    try {
      const response = await fetch("/api/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pid }),
      });
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setCancelError(body?.message ?? `cancel failed (HTTP ${response.status})`);
        setCancelRequested(false);
      }
    } catch {
      setCancelError("the panel could not reach /api/cancel");
      setCancelRequested(false);
    }
  }, [pid]);

  const running = phase !== "ended" && phase !== "lost";
  const badge: RunStatus =
    phase === "ended"
      ? isRunStatus(status)
        ? status
        : "done"
      : cancelRequested
        ? "cancelled"
        : "running";

  return (
    <div className="flex min-w-0 flex-col gap-4" data-live-log>
      <header className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-base font-semibold tracking-tight">
            {running ? "Running" : "Finished"}
            {kind !== null ? <span className="ml-2 font-mono text-sm text-muted">{kind}</span> : null}
          </h1>
          <StatusBadge status={badge} />
          {pid !== null ? (
            <span className="font-mono text-xs text-muted" data-live-pid>
              pid {pid}
            </span>
          ) : null}
          <span className="text-xs text-muted" data-live-phase={phase}>
            {phase === "connecting"
              ? "connecting…"
              : phase === "streaming"
                ? cancelRequested
                  ? "cancelling…"
                  : "streaming"
                : phase === "ended"
                  ? "stream closed"
                  : "stream lost — reload to reconnect"}
          </span>
        </div>

        {display !== null ? (
          <code className="min-w-0 overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs whitespace-pre">
            {display}
          </code>
        ) : null}

        {argv !== null && argv.length > 0 ? (
          <details className="min-w-0 text-xs text-muted">
            <summary className="cursor-pointer">
              argv ({argv.length} arguments, as the process received them)
            </summary>
            <ol className="mt-2 flex min-w-0 flex-col gap-1" data-live-argv>
              {argv.map((value, index) => (
                <li key={index} className="flex min-w-0 gap-2">
                  <span className="shrink-0 font-mono text-muted">[{index}]</span>
                  {/* JSON.stringify so a value containing a newline, a quote or a `;` is visible
                      as ONE argument with those bytes in it. */}
                  <code className="min-w-0 break-all whitespace-pre-wrap">
                    {JSON.stringify(value)}
                  </code>
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          {pid !== null && running ? (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={cancelRequested}
              data-live-cancel
              className="rounded border border-line px-3 py-1.5 text-sm text-error-fg transition-colors hover:border-error-fg hover:bg-error-bg disabled:opacity-50"
            >
              {cancelRequested ? "Cancelling…" : "Cancel run"}
            </button>
          ) : null}

          {runId !== null ? (
            <Link
              href={`/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(runId)}`}
              data-live-run-link
              className="text-sm text-link hover:underline"
            >
              {running ? "run page" : `open ${runId}`}
            </Link>
          ) : running ? (
            <span className="text-xs text-muted">
              the run id is announced when the workflow saves its manifest
            </span>
          ) : (
            <span className="text-xs text-muted" data-live-no-run>
              this process ended without saving a run
            </span>
          )}

          <Link href={`/ws/${encodeURIComponent(ws)}`} className="text-sm text-link hover:underline">
            back to {ws}
          </Link>

          {lastPing !== null ? (
            <span className="text-xs text-muted" data-live-heartbeat={lastPing}>
              heartbeat {lastPing.slice(11, 19)}
            </span>
          ) : null}
        </div>

        {cancelError !== null ? (
          <p className="rounded border border-line bg-error-bg px-3 py-2 text-xs text-error-fg">
            {cancelError}
          </p>
        ) : null}
      </header>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">
            {text.length === 0 ? "waiting for output…" : `${text.length} characters`}
          </span>
          {!follow ? (
            <button
              type="button"
              onClick={toBottom}
              data-live-resume
              className="rounded border border-line px-2 py-0.5 text-xs text-muted transition-colors hover:border-link hover:text-fg"
            >
              auto-scroll paused — jump to end
            </button>
          ) : (
            <span className="text-xs text-muted" data-live-following>
              following
            </span>
          )}
        </div>
        <pre
          ref={box}
          onScroll={onScroll}
          data-live-output
          className="h-[60vh] min-w-0 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre"
        >
          {text}
        </pre>
      </div>
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

