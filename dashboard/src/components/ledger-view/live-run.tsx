"use client";

/**
 * One live connection per workspace screen, shared by everything that shows the running task.
 *
 * The 1440 margin, the 375 in-progress card and the ledger's running row all display the same
 * clock, the same step and the same log tail. Three components each opening their own
 * `EventSource` would be three `fs.watch` handles and three poll intervals on the server for one
 * run (`streamStats()` in `@/lib/runner` counts them, and this task's verification asserts they
 * return to zero) — so the connection lives here, once, and the three read it through context.
 *
 * The machinery is the existing panel's, deliberately unchanged in behaviour:
 *
 *   - the 5 s poll of `/api/runs?ws=` with a digest and `router.refresh()`.
 *     The TABLE stays server-rendered from the store; this only decides WHEN to re-read it, so the
 *     panel keeps one idea of what a run is.
 *   - the `/api/logs` SSE tail with an explicit `close()` on `end`, from `live-log.tsx`. An
 *     `EventSource` the server closes reconnects by itself, and a finished run would replay its
 *     whole log every few seconds forever.
 *
 * What is added here is the reading of it: elapsed seconds on a 1 s clock (computed from
 * `startedAt`, never from a counter that a backgrounded tab would stall), and `advanceProgress`
 * folded over the streaming lines so the progress rule reflects the phase the workflow has
 * announced rather than the passage of time.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActiveRun } from "@/lib/runner";
import type { RunManifest } from "@shared/schemas";
import { advanceProgress, NO_PROGRESS, type Progress, type RunKind } from "./model";

const POLL_MS = 5_000;
/** Lines kept for the `LOG` block. The design shows four; a couple of spares smooth the churn. */
const TAIL_LINES = 8;

type RunRow = Pick<RunManifest, "runId" | "workspace" | "kind" | "status" | "createdAt">;

interface Poll {
  active: ActiveRun[];
  runs: RunRow[];
}

export interface LiveRun {
  /** `null` for a process this panel started, until the CLI announces or the panel correlates one. */
  runId: string | null;
  kind: RunKind;
  startedAt: string;
  /** `null` for a run started from a terminal — the panel cannot cancel what it did not spawn. */
  pid: number | null;
  cancelRequested: boolean;
}

/**
 * A log line with an id that only ever counts up.
 *
 * The design rises each new line in on mount and leaves the settled ones still (handoff § Motion:
 * "on mount only"). React only remounts a node when its KEY changes, and a tail keyed by index
 * re-uses the same four nodes forever — every line would arrive without its animation while an
 * unchanged one would replay it whenever the array shifted. The id is what makes "this is a new
 * line" a fact rather than a guess.
 */
export interface LogLine {
  id: number;
  text: string;
}

export interface LiveState {
  run: LiveRun | null;
  /** Whole seconds since the run started, or `null` before the first client tick. */
  elapsed: number | null;
  /** The tail of the run's output, oldest first. */
  lines: LogLine[];
  progress: Progress;
}

const LiveContext = createContext<LiveState>({ run: null, elapsed: null, lines: [], progress: NO_PROGRESS });

export function useLiveRun(): LiveState {
  return useContext(LiveContext);
}

export function LiveRunProvider({
  ws,
  /** The tail the SERVER already read for the newest run, so the LOG block is never empty on paint. */
  seedLines,
  children,
}: {
  ws: string;
  seedLines: string[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [run, setRun] = useState<LiveRun | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<Progress>(NO_PROGRESS);
  const digest = useRef<string>("");
  const polling = useRef(false);
  /** Never reset, so a line that scrolls out and an identical one arriving later are different. */
  const nextLineId = useRef(0);

  // ── the poll ────────────────────────────────────────────────────────────────────────────────
  const tick = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const response = await fetch(`/api/runs?ws=${encodeURIComponent(ws)}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as Partial<Poll>;
      const active = (Array.isArray(body.active) ? body.active : []).filter((a) => a.state === "running");
      const runs = Array.isArray(body.runs) ? body.runs : [];

      // A process this panel started wins over a manifest, because it has a pid: a live transcript
      // to stream and a run that can be cancelled. A `running` manifest with no process of ours is
      // a run started from a terminal — still worth showing, still tailable by run id.
      const tracked = new Set(active.map((a) => a.runId).filter((id): id is string => id !== null));
      const orphan = runs.find((r) => r.status === "running" && !tracked.has(r.runId)) ?? null;
      const first = active[0];

      const next: LiveRun | null =
        first !== undefined
          ? {
              runId: first.runId,
              kind: first.kind,
              startedAt: first.startedAt,
              pid: first.pid,
              cancelRequested: first.cancelRequested,
            }
          : orphan !== null
            ? { runId: orphan.runId, kind: orphan.kind, startedAt: orphan.createdAt, pid: null, cancelRequested: false }
            : null;

      setRun((previous) => (sameRun(previous, next) ? previous : next));
      setNow(Date.now());

      // Only what changes what the SERVER would render. A duration ticking up must not refresh.
      const stamp = JSON.stringify([
        runs.map((r) => `${r.runId}:${r.status}`),
        active.map((a) => `${a.pid}:${a.state}:${a.cancelRequested}:${a.runId ?? ""}`),
      ]);
      if (digest.current !== "" && digest.current !== stamp) router.refresh();
      digest.current = stamp;
    } catch {
      // The next poll is five seconds away; a failed one is not worth a banner.
    } finally {
      polling.current = false;
    }
  }, [router, ws]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const immediate = setTimeout(() => void tick(), 0);
    const start = () => {
      if (timer === null) timer = setInterval(() => void tick(), POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void tick();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(immediate);
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tick]);

  // ── the clock ───────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (run === null) return;
    // The first reading is a task rather than part of the effect body: a synchronous `setState`
    // there is a cascading render (and the lint rule that says so).
    const immediate = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(timer);
    };
  }, [run]);

  // ── the tail ────────────────────────────────────────────────────────────────────────────────
  /*
   * The stream is keyed by a STRING, and that string is the effect's only dependency besides `ws`.
   * `live-log.tsx` learned this the hard way: depending on the run id — which is `null` until the
   * run announces itself — re-ran the effect mid-run and replayed the whole log into a buffer that
   * still held the first copy.
   */
  const streamKey =
    run === null ? null : run.pid !== null ? `pid=${run.pid}` : run.runId !== null ? `run=${encodeURIComponent(run.runId)}` : null;

  useEffect(() => {
    if (streamKey === null) return;

    const source = new EventSource(`/api/logs?ws=${encodeURIComponent(ws)}&${streamKey}`);
    // A chunk can end mid-line; the remainder is carried to the next one rather than counted as a
    // line of its own, which would double-count a `[tool]` marker split across two frames.
    let carry = "";
    let folded = NO_PROGRESS;
    const tail: LogLine[] = [];

    const consume = (text: string) => {
      const parts = (carry + text).split("\n");
      carry = parts.pop() ?? "";
      let changed = false;
      for (const line of parts) {
        if (line.trim() === "") continue;
        folded = advanceProgress(folded, line);
        tail.push({ id: nextLineId.current++, text: line });
        if (tail.length > TAIL_LINES) tail.shift();
        changed = true;
      }
      if (!changed) return;
      setLines([...tail]);
      setProgress(folded);
    };

    source.addEventListener("log", (event) => {
      const data = parse(event);
      if (typeof data?.text === "string") consume(data.text);
    });
    source.addEventListener("end", () => {
      if (carry.trim() !== "") consume("\n");
      // Close from THIS side: a server-closed EventSource reconnects on its own.
      source.close();
      router.refresh();
    });

    return () => source.close();
  }, [router, streamKey, ws]);

  /*
   * Nothing streamed yet: show the tail the SERVER read for the newest run, so the LOG block is
   * the last thing that happened rather than an empty box. Derived rather than seeded into state,
   * because the server hands over a fresh tail on every refresh and state would pin the first one.
   * Negative ids keep these apart from streamed lines, which start at 0.
   */
  const seedKey = seedLines.join("\n");
  const seeded = useMemo<LogLine[]>(() => {
    if (seedKey === "") return [];
    const texts = seedKey.split("\n");
    return texts.map((text, index) => ({ id: index - texts.length, text }));
  }, [seedKey]);
  const shown = lines.length === 0 ? seeded : lines;

  const elapsed = useMemo(() => {
    if (run === null || now === null) return null;
    const started = new Date(run.startedAt).getTime();
    if (Number.isNaN(started)) return null;
    return Math.max(0, Math.round((now - started) / 1000));
  }, [now, run]);

  const value = useMemo<LiveState>(
    () => ({ run, elapsed, lines: shown, progress }),
    [elapsed, progress, run, shown],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function sameRun(a: LiveRun | null, b: LiveRun | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.pid === b.pid &&
    a.runId === b.runId &&
    a.kind === b.kind &&
    a.startedAt === b.startedAt &&
    a.cancelRequested === b.cancelRequested
  );
}

/** SSE `data:` is always JSON here. A frame that will not parse is dropped, never rendered raw. */
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
