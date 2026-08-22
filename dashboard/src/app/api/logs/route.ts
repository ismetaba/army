/**
 * `GET /api/logs?ws=&pid=` or `?ws=&run=` — Server-Sent Events, tailing one log file (T22 step 2).
 *
 * Read-only, but not therefore uninteresting: a run's `log.txt` mirrors every tool call, so it can
 * contain request bodies built from the configured test account (SPEC § Dashboard security
 * invariants, preamble). Two things follow.
 *
 * **What can be streamed is not a path — and not a symlink either.** `?pid=` streams
 * `$AW_HOME/<ws>/pending/<pid>.log`, built from a workspace name validated against the store's
 * `SAFE_SEGMENT` rule and a number; `?run=` streams `<runDir>/log.txt` for a run `readRun` has
 * already resolved with `realpath`. Both file names are constants joined on afterwards, so there
 * is no caller-supplied path component anywhere and nothing to traverse out of. That was the whole
 * argument until a symlink AT one of those constant names — `ln -s /etc/passwd
 * $AW_HOME/<ws>/runs/<id>/log.txt`, which the designer/tester `bash` tool is free to create —
 * turned the route into a read-any-file primitive. Two answers, both applied: `runLogFile` now
 * resolves the file itself and re-checks containment (`resolveRunFile` in `@/lib/store`), and
 * `pump()` below opens with `O_NOFOLLOW` and `lstat`s rather than `stat`s, so no name this route
 * ever opens can be a link — including the `pending/<pid>.log` transcript, which lives outside a
 * run directory and has no containment check to lean on.
 *
 * **Cross-origin reads are the browser's job to stop — once the Host is pinned.** `EventSource`
 * cannot set headers, so this route cannot use T21's `guardMutation`. A cross-origin
 * `EventSource`/`fetch` is subject to CORS, this route sends no `Access-Control-Allow-Origin`, and
 * the browser therefore refuses to hand the body to the page that asked. But a DNS-rebound page is
 * not cross-origin — the browser considers it the same origin as the panel — so CORS withholds
 * nothing from it and the `Origin`-vs-`Host` comparison below is satisfied by the attacker's own
 * name on both sides. `guardHost` (shared with every other route, and with `middleware.ts`) is
 * what closes that: the `Host` must name loopback, which a rebound page cannot send.
 *
 * ── how the tail works ────────────────────────────────────────────────────────────────────────
 *
 * A byte offset, an `fs.watch` on the file's DIRECTORY (not the file: it may not exist yet, and
 * for a `?pid=` stream it is renamed out from under us when the run finishes — see
 * `transcriptFile`), and a slow interval as a floor under the watcher, because `fs.watch` is
 * documented as not guaranteed to fire on every platform. Both are cleared, together, by one
 * `close()` that runs whichever way the stream ends:
 *
 *   - the client navigated away or reloaded  → `request.signal` aborts
 *   - the client called `EventSource.close()` → the stream's `cancel()` callback
 *   - the run finished and drained           → we close it ourselves after the `end` event
 *
 * `streamStats()` counts the watchers and timers currently held so a leak is a number someone can
 * look at instead of a slow limp.
 */
import fs from "node:fs";
import path from "node:path";
import { guardHost } from "@/lib/api-guard";
import { isWorkspaceName, readRun } from "@/lib/store";
import {
  getTriggeredRun,
  runLogFile,
  streamStats,
  transcriptFile,
  type ActiveRun,
} from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** T22 step 2: "heartbeat every 15 s". A named event, not an SSE comment, so a client can see it. */
export const HEARTBEAT_MS = 15_000;

/**
 * The floor under `fs.watch`. Short enough that "it streams as it grows" is true even where the
 * watcher never fires, long enough that an idle tab costs two `stat`s a second.
 */
const POLL_MS = 500;

/** How much of an existing log is sent on connect. The panel is a tail, not an archive. */
const PRIME_BYTES = 256 * 1024;

/** Chunk size for a single `event: log`. Keeps one frame from being a megabyte of JSON. */
const CHUNK_BYTES = 32 * 1024;

/** After the run has ended, how long to keep reading before closing (lets the tail settle). */
const DRAIN_MS = 1_500;

function bad(message: string, status: number): Response {
  return new Response(`${JSON.stringify({ ok: false, message }, null, 2)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

interface Target {
  /** Resolved fresh on every tick: a `?pid=` transcript is renamed when the run finishes. */
  file: () => string;
  /** The directory to watch, and the file name inside it to react to. */
  watchDir: string;
  /** `null` while it is still going. */
  ended: () => { status: string; runId: string | null; exitCode: number | null; exitSignal: string | null } | null;
  /** Metadata for the `open`/`status` events. */
  describe: () => Record<string, unknown>;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // The rebinding gate first: a `Host` that is not a loopback name is refused outright, so the
  // Origin comparison below is a comparison against something the caller could not choose.
  const hostRefusal = guardHost(request);
  if (hostRefusal !== null) return hostRefusal;

  // Same-origin check (see the header comment: belt, with CORS as the braces).
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let host: string | null = null;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host === null || host !== (request.headers.get("host") ?? "")) {
      return bad("cross-origin request rejected", 403);
    }
  }

  const ws = url.searchParams.get("ws") ?? "";
  const pidParam = url.searchParams.get("pid");
  const runParam = url.searchParams.get("run");

  if (!isWorkspaceName(ws)) return bad("no such workspace", 404);
  if ((pidParam === null) === (runParam === null)) {
    return bad("exactly one of pid or run is required", 400);
  }

  let target: Target;

  if (pidParam !== null) {
    if (!/^[0-9]{1,10}$/.test(pidParam)) return bad("pid must be a positive integer", 400);
    const pid = Number(pidParam);
    const pending = transcriptFile(ws, pid);
    if (pending === null) return bad("no such run", 404);
    // A pid the panel never started has no transcript to show and must not be probeable.
    const tracked = getTriggeredRun(pid);
    if (tracked === null || tracked.ws !== ws) return bad("no such run", 404);

    target = {
      file: () => transcriptFile(ws, pid) ?? pending,
      watchDir: path.dirname(pending),
      ended: () => {
        const now = getTriggeredRun(pid);
        if (now === null) return { status: "gone", runId: null, exitCode: null, exitSignal: null };
        if (now.state === "running") return null;
        return {
          status: manifestStatusOf(now),
          runId: now.runId,
          exitCode: now.exitCode,
          exitSignal: now.exitSignal,
        };
      },
      describe: () => {
        const now = getTriggeredRun(pid);
        return {
          source: "pending",
          pid,
          ws,
          kind: now?.kind ?? tracked.kind,
          runId: now?.runId ?? null,
          state: now?.state ?? "running",
          cancelRequested: now?.cancelRequested ?? false,
          display: now?.display ?? tracked.display,
          argv: now?.argv ?? tracked.argv,
        };
      },
    };
  } else {
    const runId = runParam ?? "";
    const file = runLogFile(ws, runId);
    if (file === null) return bad("no such run", 404);

    target = {
      file: () => file,
      watchDir: path.dirname(file),
      ended: () => {
        const manifest = readRun(ws, runId);
        if (manifest === null) return { status: "gone", runId, exitCode: null, exitSignal: null };
        if (manifest.status === "running") return null;
        return { status: manifest.status, runId, exitCode: null, exitSignal: null };
      },
      describe: () => {
        const manifest = readRun(ws, runId);
        return {
          source: "run",
          ws,
          runId,
          kind: manifest?.kind ?? null,
          state: manifest?.status === "running" ? "running" : "exited",
          status: manifest?.status ?? null,
        };
      },
    };
  }

  return sse(request, target);
}

/** A finished child's status as the manifest will read it — the badge colour the UI should show. */
function manifestStatusOf(run: ActiveRun): string {
  if (run.runId !== null) {
    const manifest = readRun(run.ws, run.runId);
    if (manifest !== null) return manifest.status;
  }
  if (run.cancelRequested) return "cancelled";
  return run.exitCode === 0 || run.exitCode === 2 ? "done" : "error";
}

function sse(request: Request, target: Target): Response {
  const stats = streamStats();
  const encoder = new TextEncoder();

  let watcher: fs.FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let offset = 0;
  let lastState = "";
  let endedAt: number | null = null;
  /** Assigned by `start`, called by `cancel` — declared first so neither reads it uninitialised. */
  let cancelRef: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      stats.open += 1;
      stats.opened += 1;

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The consumer is gone and the controller is already closed; the abort handler below
          // will run. Nothing to report.
          close();
        }
      };

      function close(): void {
        if (closed) return;
        closed = true;
        if (watcher !== null) {
          watcher.close();
          watcher = null;
          stats.watchers -= 1;
        }
        if (poll !== null) {
          clearInterval(poll);
          poll = null;
          stats.timers -= 1;
        }
        if (beat !== null) {
          clearInterval(beat);
          beat = null;
          stats.timers -= 1;
        }
        stats.open -= 1;
        stats.closed += 1;
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* already closed by the consumer */
        }
      }

      // Kept on the instance so `cancel()` below can reach it.
      cancelRef = close;

      /** Read everything after `offset` and emit it, in bounded frames. */
      const pump = (): boolean => {
        const file = target.file();
        let size: number;
        try {
          // `lstat`, not `stat`: a symlink at this name must read as "not a regular file" rather
          // than as its target. The store's `resolveRunFile` already refuses one for `?run=`, and
          // this is the same rule for `pending/<pid>.log`, which sits outside any run directory.
          const stat = fs.lstatSync(file);
          if (!stat.isFile()) return false;
          size = stat.size;
        } catch {
          return false; // not created yet, or renamed between the two calls — try again next tick
        }
        // A file that shrank was truncated or replaced; start over rather than reading garbage.
        if (size < offset) offset = 0;
        if (size <= offset) return false;

        // On connect, prime with the TAIL rather than the whole file.
        if (offset === 0 && size > PRIME_BYTES) {
          offset = size - PRIME_BYTES;
          send("log", { text: `…[earlier output trimmed: ${offset} bytes]\n`, trimmed: offset });
        }

        let handle: number;
        try {
          // `O_NOFOLLOW` closes the TOCTOU between the `lstat` above and this open: a link planted
          // in the gap makes the open fail (ELOOP) rather than succeed on its target.
          handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch {
          return false;
        }
        try {
          while (offset < size) {
            const length = Math.min(CHUNK_BYTES, size - offset);
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(handle, buffer, 0, length, offset);
            if (read <= 0) break;
            offset += read;
            send("log", { text: buffer.subarray(0, read).toString("utf8") });
          }
        } finally {
          fs.closeSync(handle);
        }
        return true;
      };

      const tick = (): void => {
        if (closed) return;
        pump();

        const description = target.describe();
        const stateKey = JSON.stringify(description);
        if (stateKey !== lastState) {
          lastState = stateKey;
          send("status", description);
        }

        const ended = target.ended();
        if (ended === null) {
          endedAt = null;
          return;
        }
        // Give the writer a moment after exit: the runner appends its `[runner] exited …` trailer
        // and then renames the file, and closing on the first tick would cut both off.
        if (endedAt === null) {
          endedAt = Date.now();
          return;
        }
        if (Date.now() - endedAt < DRAIN_MS) return;
        pump();
        send("end", ended);
        close();
      };

      send("open", { ...target.describe(), heartbeatMs: HEARTBEAT_MS });
      tick();

      try {
        watcher = fs.watch(target.watchDir, () => tick());
        watcher.on("error", () => {
          /* the directory went away; the poll below keeps the stream honest */
        });
        stats.watchers += 1;
      } catch {
        watcher = null; // no watcher on this platform/path — the poll is the whole tail then
      }

      poll = setInterval(tick, POLL_MS);
      stats.timers += 1;

      beat = setInterval(() => send("ping", { t: new Date().toISOString() }), HEARTBEAT_MS);
      stats.timers += 1;

      // A closed tab, a reload, a navigation: Next aborts the request signal. This is the path
      // that actually fires in a browser, and the one a leak would hide behind.
      request.signal.addEventListener("abort", close);
      if (request.signal.aborted) close();
    },

    cancel() {
      cancelRef?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer `text/event-stream` by default, which turns a live tail into one
      // flush at the end. Harmless here (nothing proxies loopback), free to be explicit about.
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
