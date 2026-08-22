"use client";

/**
 * "Something is running" — the banner and the 5-second poll (T22 step 3).
 *
 * The run tables stay SERVER components. This one client component polls `/api/runs`, compares a
 * digest of what it sees against the previous poll, and calls `router.refresh()` when it changes;
 * Next re-runs the server render and the table updates itself from the store. The alternative —
 * having the client patch a list it did not render — would give the panel two ideas of what a run
 * is, and they would disagree the first time a CLI run finished while a tab was open.
 *
 * It reports two different things, because they answer different questions:
 *
 *   - **active** — processes THIS panel started. They have a pid, a live transcript and a Cancel
 *     button.
 *   - **running manifests with no process** — a run started from a terminal, or one whose panel
 *     process is gone. Its `log.txt` can still be tailed (`?run=`), but the panel cannot cancel
 *     what it did not spawn, and pretending otherwise with a dead button would be worse than
 *     saying so.
 *
 * Polling stops while the tab is hidden: a background tab does not need a five-second refresh
 * loop, and `visibilitychange` brings it back with an immediate poll rather than a five-second gap.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { RunManifest } from "@shared/schemas";
import type { ActiveRun } from "@/lib/runner";

const POLL_MS = 5_000;

/*
 * The two shapes `/api/runs` answers with, imported rather than re-declared.
 *
 * `ActiveRun` is `runner.ts`'s own exported interface (it documents itself as "Plain JSON — it
 * crosses to a client", which is this client) and a run row is a slice of `RunManifest`. Both are
 * TYPE-only imports, so they are erased before anything has to resolve `node:fs` — the same thing
 * `live-log.tsx` already relies on for `RunStatus`. Hand-copied versions typed `kind` and `status`
 * as bare `string`, so a field renamed in `ActiveRun` would compile here and silently stop the
 * banner working.
 */
type RunRow = Pick<RunManifest, "runId" | "workspace" | "kind" | "status" | "createdAt">;

interface Poll {
  active: ActiveRun[];
  runs: RunRow[];
}

export function RunPoller({ ws }: { ws?: string }) {
  const router = useRouter();
  const [poll, setPoll] = useState<Poll | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const digest = useRef<string>("");
  const busy = useRef(false);

  const tick = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const query = ws === undefined ? "" : `?ws=${encodeURIComponent(ws)}`;
      const response = await fetch(`/api/runs${query}`, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as Partial<Poll>;
      const active = Array.isArray(body.active) ? body.active : [];
      const runs = Array.isArray(body.runs) ? body.runs : [];
      setPoll({ active, runs });
      setNow(Date.now());

      // Only the parts that change what the SERVER would render: which runs exist, what their
      // status is, and which processes are live. A duration ticking up must not cause a refresh.
      const next = JSON.stringify([
        runs.map((r) => `${r.workspace}/${r.runId}:${r.status}`),
        active.map((a) => `${a.pid}:${a.state}:${a.cancelRequested}:${a.runId ?? ""}`),
      ]);
      if (digest.current !== "" && digest.current !== next) router.refresh();
      digest.current = next;
    } catch {
      // A failed poll is not worth surfacing: the next one is five seconds away.
    } finally {
      busy.current = false;
    }
  }, [router, ws]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    // The first poll is a task, not part of the effect body: fetching synchronously from an effect
    // makes the state update a cascading render, which is both slower and what the lint rule is
    // about. A zero-delay timeout is the same "poll immediately" with the render out of the way.
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
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(immediate);
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tick]);

  // A one-second clock for the elapsed column, independent of the poll.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (poll === null) return null;

  const active = poll.active.filter((a) => a.state === "running");
  const tracked = new Set(active.map((a) => a.runId).filter((id): id is string => id !== null));
  const orphans = poll.runs.filter((r) => r.status === "running" && !tracked.has(r.runId));

  if (active.length === 0 && orphans.length === 0) return null;

  return (
    <section
      data-run-poller
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-running-bg p-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-running-fg">
        In progress ({active.length + orphans.length})
      </h2>

      <ul className="flex min-w-0 flex-col gap-2">
        {active.map((run) => (
          <li
            key={run.pid}
            data-active-run={run.pid}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-running-fg"
          >
            <Spinner />
            <span className="font-medium">{run.kind}</span>
            {ws === undefined ? (
              <Link
                href={`/ws/${encodeURIComponent(run.ws)}`}
                className="font-mono text-xs underline"
              >
                {run.ws}
              </Link>
            ) : null}
            {/* The run id appears as soon as the panel can correlate the process with the
                `running` manifest it is writing — see `adoptRunId` in `@/lib/runner`. Until then
                the pid is the only name this run has. */}
            {run.runId === null ? (
              <span className="font-mono text-xs opacity-80">pid {run.pid}</span>
            ) : (
              <span className="font-mono text-xs break-all opacity-80">{run.runId}</span>
            )}
            <span className="text-xs tabular-nums opacity-80">{elapsed(run.startedAt, now)}</span>
            {run.cancelRequested ? <span className="text-xs">cancelling…</span> : null}
            <Link
              href={`/ws/${encodeURIComponent(run.ws)}/live?pid=${run.pid}`}
              data-watch-run={run.pid}
              className="text-xs font-medium underline"
            >
              watch
            </Link>
          </li>
        ))}

        {orphans.map((run) => (
          <li
            key={`${run.workspace}/${run.runId}`}
            data-orphan-run={run.runId}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-running-fg"
          >
            <Spinner />
            <span className="font-medium">{run.kind}</span>
            <span className="font-mono text-xs break-all opacity-80">{run.runId}</span>
            <span className="text-xs opacity-80">started outside the panel</span>
            <Link
              href={`/ws/${encodeURIComponent(run.workspace)}/live?run=${encodeURIComponent(run.runId)}`}
              className="text-xs font-medium underline"
            >
              tail its log
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 animate-spin rounded-full border border-current border-t-transparent"
    />
  );
}

/** `1m 04s`, computed on the client so it keeps moving without a poll. */
function elapsed(startedAt: string, now: number | null): string {
  if (now === null) return "";
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return "";
  const secs = Math.max(0, Math.round((now - started) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${String(secs - mins * 60).padStart(2, "0")}s`;
}
