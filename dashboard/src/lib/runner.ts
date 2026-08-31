/**
 * T22 — the panel's only way to START a process. SERVER ONLY.
 *
 * Until this task the panel could read the store, write two JSON files and rename a directory.
 * This module lets a button in a browser run the CLI, which is the single most dangerous thing in
 * the project, so the shape of it is deliberate and worth reading before the code:
 *
 * ```
 *   POST /api/trigger ──► startTriggeredRun(ws, kind, args)
 *                             │  ws     → looked up in $AW_HOME/workspaces.json (never a path)
 *                             │  kind   → one of three literals
 *                             │  args   → buildTriggerArgv(): per-kind allowlist, one element each
 *                             ▼
 *                         spawn("npx", ["tsx", "<toolkit>/src/cli.ts", …argv], {
 *                             cwd: <repoRoot from the registry>,   shell: FALSE,
 *                             detached: true,                      stdio: [ignore, pipe, pipe] })
 * ```
 *
 * **SPEC § Dashboard security invariants #4 — argv array, never a shell string.** There is exactly
 * one `spawn` in this file, it takes an array, and `shell` is never set. Nothing here builds a
 * command by concatenation; the only string form of the command (`displayCommand`) is for
 * rendering and is derived FROM the array, not the other way round. So `; rm -rf ~`, `$(id)`,
 * backticks, newlines and glob characters reach `process.argv` of the CLI as literal bytes and
 * are never seen by a shell — proven in this task's verification by triggering exactly that.
 *
 * **`detached: true` is a cancellation requirement, not a detail.** It makes the child a process
 * GROUP leader (`setsid`), so `process.kill(-pid, …)` reaches the whole tree: `npx` → `tsx` →
 * `node src/cli.ts` → Chromium. Signalling only the pid would leave a browser and a dev server
 * running with nothing to stop them. The one thing that is NOT in that group is a dev server
 * started by `ensureUp` (src/util.ts spawns it detached as well, on purpose, so it survives a
 * crashed poll loop) — the CLI's own `process.on('exit')` handler signals that group, which is
 * why cancellation goes through SIGTERM first and only escalates to SIGKILL if the CLI is still
 * alive 10 s later. A SIGKILLed CLI runs no handler and would leave a dev server holding a port.
 *
 * **Only pids this module started can be signalled.** `cancelTriggeredRun` looks the pid up in the
 * in-memory map and refuses anything else. A route that passed a caller's number to
 * `process.kill` would be a "kill any process on this machine" endpoint.
 *
 * State lives on `globalThis` rather than in a module-level `const`: `next dev` re-evaluates a
 * module when the file it belongs to (or one it imports) changes, and a re-evaluated module map
 * would forget about a running child — losing its log, its cancel button and the 1-per-workspace
 * guard while the process kept running.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  awHome,
  isWorkspaceName,
  listRuns,
  listWorkspaces,
  readRun,
  realRunDir,
  resolveRunFile,
} from "@/lib/store";
import {
  buildTriggerArgv,
  displayCommand,
  type TriggerArgs,
  type TriggerKind,
} from "@/lib/trigger-args";

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/** What the panel shows about a process this module started. Plain JSON — it crosses to a client. */
export interface ActiveRun {
  pid: number;
  ws: string;
  kind: TriggerKind;
  /** Known only once the CLI prints `run saved: <ws>/<runId>`, i.e. at the very end of the run. */
  runId: string | null;
  startedAt: string;
  endedAt: string | null;
  /** `running` until the child exits; then how it ended. */
  state: "running" | "exited";
  exitCode: number | null;
  exitSignal: string | null;
  /** True once someone pressed Cancel — the badge says "cancelling…" rather than "running". */
  cancelRequested: boolean;
  /** The command as a human would type it. Display only; never executed, never re-parsed. */
  display: string;
  /** The argv the child was actually given, one element per array slot. The injection audit trail. */
  argv: string[];
  /** The child's working directory — the workspace's `repoRoot`, from the registry. */
  cwd: string;
}

interface Tracked extends ActiveRun {
  child: ChildProcess;
  logFile: string;
  /** The SIGKILL escalation timer, cleared the moment the child exits. */
  killTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Live counts of the resources `/api/logs` holds open.
 *
 * An SSE stream owns an `fs.watch` handle and two timers for as long as a browser tab is pointed
 * at it, and a tab is closed by navigating away, by a reload, or by the laptop lid — none of which
 * the server is told about except through the request's abort signal. A leak here is invisible
 * (the panel keeps working) and unbounded (one more watcher per reload, forever), so the counters
 * are exported: `GET /api/runs` reports them, and this task's verification asserts they return to
 * zero after the clients disconnect.
 */
export interface StreamStats {
  /** Streams currently connected. */
  open: number;
  /** `fs.watch` handles currently held. */
  watchers: number;
  /** `setInterval` timers currently held (one poll + one heartbeat per stream). */
  timers: number;
  /** Lifetime totals, so "opened 12, closed 12" is checkable even at open: 0. */
  opened: number;
  closed: number;
}

interface RunnerState {
  /** pid → tracked child, for children of THIS process only. */
  runs: Map<number, Tracked>;
  streams: StreamStats;
}

const STATE_KEY = Symbol.for("agent-workflows.runner.state");

function state(): RunnerState {
  const holder = globalThis as unknown as Record<symbol, RunnerState | undefined>;
  let existing = holder[STATE_KEY];
  if (existing === undefined) {
    existing = {
      runs: new Map(),
      streams: { open: 0, watchers: 0, timers: 0, opened: 0, closed: 0 },
    };
    holder[STATE_KEY] = existing;
  }
  return existing;
}

/** The live resource counts above. Mutated by `/api/logs`, read by `/api/runs`. */
export function streamStats(): StreamStats {
  return state().streams;
}

/**
 * The public view of a tracked run.
 *
 * Field by field rather than by spreading and deleting: this object is JSON-serialised into an API
 * response and passed to a client component, and a rest-spread would carry any field a later edit
 * adds to `Tracked` — a child process handle, an open file descriptor, a timer — straight into it.
 * Listing the fields makes leaking one a compile error instead of a surprise in a response body.
 */
function view(run: Tracked): ActiveRun {
  return {
    pid: run.pid,
    ws: run.ws,
    kind: run.kind,
    runId: run.runId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    state: run.state,
    exitCode: run.exitCode,
    exitSignal: run.exitSignal,
    cancelRequested: run.cancelRequested,
    display: run.display,
    argv: [...run.argv],
    cwd: run.cwd,
  };
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * The root of THIS toolkit — the directory holding `src/cli.ts`.
 *
 * T22 step 1 says "resolve from `process.cwd()/..`", which is right for the way the panel is
 * always started (`next dev` runs with cwd = `dashboard/`). The walk below starts at the cwd
 * itself and stops at the first ancestor that actually contains `src/cli.ts`, so the same code
 * also works from the repo root (`npm run dashboard`) and from a test — and it fails loudly with
 * the cwd it searched from rather than spawning `npx tsx` on a path that does not exist.
 * `AW_TOOLKIT_ROOT` overrides it, which is how the verification runs the panel against a copy.
 */
export function toolkitRoot(): string {
  const override = process.env.AW_TOOLKIT_ROOT?.trim();
  if (override) return path.resolve(override);

  let dir = path.resolve(process.cwd());
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, "src", "cli.ts"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(process.cwd(), "..");
}

/** `$AW_HOME/<ws>/pending` — where a run's transcript lives before its run id is known. */
function pendingDir(ws: string): string {
  return path.join(awHome(), ws, "pending");
}

/**
 * `$AW_HOME/<ws>/pending/<pid>.log`, or `null` for a workspace name or pid that is not a plain
 * segment. Both halves are validated rather than escaped: `isWorkspaceName` is the store's own
 * `SAFE_SEGMENT` rule (no separator, never `.` or `..`) and a pid is digits, so the joined path
 * cannot leave the store however the query string was written.
 */
export function pendingLogFile(ws: string, pid: number): string | null {
  if (!isWorkspaceName(ws)) return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return path.join(pendingDir(ws), `${pid}.log`);
}

/**
 * Where a triggered run's transcript is RIGHT NOW.
 *
 * While the child is alive it is `pending/<pid>.log`; once it has finished and announced a run id
 * the same file has been renamed to `<runDir>/spawn.log` (see `archiveTranscript`). A `rename`
 * does not change the bytes, so a reader that is part-way through can carry its byte offset
 * straight over to the new name — which is exactly what the SSE tail does, and why the move never
 * costs the last few lines of a run.
 *
 * `null` only when the workspace name or pid is not a usable segment.
 */
export function transcriptFile(ws: string, pid: number): string | null {
  const pending = pendingLogFile(ws, pid);
  if (pending === null) return null;
  if (fs.existsSync(pending)) return pending;

  const tracked = state().runs.get(pid);
  if (tracked?.runId != null && tracked.ws === ws) {
    // `resolveRunFile`, not `path.join`: the archived transcript is opened and streamed, so a
    // symlink at `<runDir>/spawn.log` must read as "no such file" rather than as its target.
    const archived = resolveRunFile(ws, tracked.runId, "spawn.log");
    if (archived !== null) return archived;
  }
  // Nothing on disk yet — return the pending name so the watcher waits for it to appear.
  return pending;
}

/**
 * `<runDir>/log.txt` for a run that exists, or `null`.
 *
 * `resolveRunFile` is the gate (`@/lib/store`): it resolves the run DIRECTORY with `realpath` and
 * re-checks it against the resolved `$AW_HOME`, then resolves the FILE and re-checks containment
 * again. The second half is the one this function used to be missing — it joined the constant name
 * onto the unresolved directory and handed the result to `fs.openSync`, so `ln -s /etc/passwd
 * <runDir>/log.txt` (an agent's `bash` can create that; SPEC § Tools blocks neither `ln` nor
 * symlinks) turned `GET /api/logs?run=` into a read-any-file endpoint. Reproduced with a canary
 * file before the fix; 404 after it.
 */
export function runLogFile(ws: string, runId: string): string | null {
  if (readRun(ws, runId) === null) return null;
  const resolved = resolveRunFile(ws, runId, "log.txt");
  if (resolved !== null) return resolved;

  // Not written yet. A run whose manifest exists a moment before its first log line must still be
  // tailable, so the intended name is handed back for the watcher to wait on — but ONLY when
  // nothing occupies it. Something that is there and did not resolve is a link, a directory or a
  // fifo, and none of those is a log. (`pump()` re-checks with `lstat` + `O_NOFOLLOW` regardless.)
  const dir = realRunDir(ws, runId);
  if (dir === null) return null;
  const intended = path.join(dir, "log.txt");
  try {
    fs.lstatSync(intended);
    return null;
  } catch {
    return intended;
  }
}

// ---------------------------------------------------------------------------
// pids.json — the durable mirror of the map above
// ---------------------------------------------------------------------------

/**
 * `$AW_HOME/<ws>/pending/pids.json` (T22 step 1).
 *
 * Written for the human and for the next process, never read back as authority: `ownerPid` records
 * which panel process spawned each entry, and only entries this process owns are ever signalled.
 * A pid from an earlier `next dev` may have been recycled by something unrelated, and "kill the
 * process that happens to hold pid 4711 now" is not a thing this module will do.
 */
function writePidsFile(ws: string): void {
  const dir = pendingDir(ws);
  const entries = [...state().runs.values()]
    .filter((r) => r.ws === ws)
    .map((r) => ({ ...view(r), ownerPid: process.pid }));
  const file = path.join(dir, "pids.json");
  const tmp = path.join(dir, `.pids.json.${process.pid}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // The mirror is a convenience. Losing it must never fail or stop a run.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

// ---------------------------------------------------------------------------
// starting
// ---------------------------------------------------------------------------

export type StartResult =
  | { ok: true; run: ActiveRun }
  | { ok: false; status: number; message: string; field?: string | null; runningPid?: number };

/** `process.kill(pid, 0)`: EPERM means it exists and is not ours, which still counts as alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The 1-per-workspace guard (T22 step 4), and why it cannot be raced.
 *
 * Everything from this check to `runs.set(pid, …)` in `startTriggeredRun` is SYNCHRONOUS — no
 * `await`, and `spawn` returns before the child has done anything. Node runs one turn of the event
 * loop at a time, so two simultaneous requests cannot interleave inside that window: the first
 * inserts, the second sees it and gets its 409. (Proven in this task's verification with twelve
 * concurrent `fetch`es, not two sequential ones.) A promise-based lock would be strictly weaker
 * here — it would introduce the very await that opens the window.
 */
function runningIn(ws: string): Tracked | null {
  for (const run of state().runs.values()) {
    if (run.ws !== ws) continue;
    if (run.state !== "running") continue;
    if (!isAlive(run.pid)) {
      // The child died without us seeing 'exit' (a hard crash of the pipe, a reload). Reap it
      // rather than letting a ghost hold the workspace shut forever.
      finish(run, null, null);
      continue;
    }
    return run;
  }
  return null;
}

/**
 * A workflow this panel process did NOT start but which is still running in `ws`, or `null`.
 *
 * `runningIn` above is an in-memory map, and a map dies with the process that holds it. `next dev`
 * restarts routinely (a config edit, a crash, Ctrl-C), and the child it spawned is `detached`, so
 * it survives — after which the panel's 1-per-workspace guard (T22 acceptance 4) was silently void
 * and a second `design-loop` could be started into the same repo. Measured: two agents writing the
 * same checkout, both racing for ports 3001 and 5173, and the first one's dev server holding them.
 *
 * The evidence is on disk. `pending/pids.json` records every child with the panel pid that spawned
 * it, so an entry that is still `running`, owned by another process, is the candidate. Two more
 * checks before it counts, because a pid alone is not an identity:
 *
 *   - the pid must be alive, and
 *   - its command line must still be the CLI, in this workspace.
 *
 * That is what makes this safe against the pid recycling T22 deviation 11 worried about: a pid
 * reused by an unrelated program has an unrelated command line and is ignored. A run started from
 * a TERMINAL is deliberately not covered — nothing records its pid, and refusing to start on the
 * strength of a `running` manifest alone would deadlock the panel behind every manifest a SIGKILL
 * left stale.
 */
interface OrphanRun {
  pid: number;
  kind: string;
  runId: string | null;
}

function orphanRunningIn(ws: string): OrphanRun | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(pendingDir(ws), "pids.json"), "utf8")) as unknown;
  } catch {
    return null; // no mirror, or an unreadable one: nothing to prove
  }
  if (!Array.isArray(raw)) return null;

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (entry.state !== "running") continue;
    if (entry.ws !== ws) continue;
    if (typeof entry.pid !== "number" || !Number.isSafeInteger(entry.pid) || entry.pid <= 0) continue;
    if (entry.ownerPid === process.pid) continue; // ours — `runningIn` is the authority on those
    if (state().runs.has(entry.pid)) continue;
    if (!isAlive(entry.pid)) continue;
    if (!looksLikeCli(entry.pid, ws)) continue;
    return {
      pid: entry.pid,
      kind: typeof entry.kind === "string" ? entry.kind : "workflow",
      runId: typeof entry.runId === "string" ? entry.runId : null,
    };
  }
  return null;
}

/** Does this pid's command line still look like `src/cli.ts … --workspace <ws>`? */
function looksLikeCli(pid: number, ws: string): boolean {
  let line: string;
  try {
    // `execFileSync` with an argv array — no shell, and `pid` is already proven to be an integer.
    line = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return false; // no `ps`, or the process vanished between the two calls
  }
  return line.includes(`${path.sep}src${path.sep}cli.ts`) && line.includes(`--workspace ${ws}`);
}

/**
 * The repo a triggered run starts in (T23): the primary target's root for that kind.
 *
 * - `design-loop` acts in the FRONTEND repo;
 * - `test-feature` acts in the BACKEND repo;
 * - `review` follows its (already-validated) `target` argument, defaulting to the backend.
 *
 * A registry entry written before T23 carries only `repoRoot`; both sides fall back to it, so a
 * single-repo workspace behaves exactly as it always has. Pure and exported for the unit tests.
 */
export function runCwd(
  entry: { repoRoot: string; backendRepo?: string; frontendRepo?: string },
  kind: TriggerKind,
  args: TriggerArgs,
): string {
  const backend = entry.backendRepo ?? entry.repoRoot;
  const frontend = entry.frontendRepo ?? entry.repoRoot;
  if (kind === "design-loop") return frontend;
  if (kind === "review") {
    const target = typeof args.target === "string" ? args.target.trim() : "";
    if (target === "frontend") return frontend;
    if (target === "backend") return backend;
    return entry.backendRepo !== undefined || entry.frontendRepo === undefined ? backend : frontend;
  }
  return backend;
}

/** Pending transcripts older than this, belonging to no live process, are swept on the next start. */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sweepPending(ws: string): void {
  const dir = pendingDir(ws);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // no pending directory yet
  }
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const entry of entries) {
    const match = /^(\d+)\.log$/.exec(entry.name);
    if (!entry.isFile() || match === null) continue;
    const pid = Number(match[1]);
    if (state().runs.has(pid) || isAlive(pid)) continue;
    const file = path.join(dir, entry.name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      /* someone else got there first */
    }
  }
}

export function startTriggeredRun(
  ws: unknown,
  kind: TriggerKind,
  args: TriggerArgs,
): StartResult {
  // 1. The workspace must be a REGISTERED one, and the repo it names must exist. The child's
  //    cwd comes from `workspaces.json` (per kind — see `runCwd`) and never from the request.
  if (typeof ws !== "string" || !isWorkspaceName(ws)) {
    return { ok: false, status: 404, message: "no such workspace" };
  }
  const entry = listWorkspaces().find((w) => w.name === ws);
  if (entry === undefined) {
    return { ok: false, status: 404, message: "no such workspace" };
  }
  if (!path.isAbsolute(entry.repoRoot)) {
    return { ok: false, status: 400, message: `workspace "${ws}" has no absolute repoRoot` };
  }

  // 2. The argv, from the per-kind allowlist. Nothing else can become an argument. Validated
  //    BEFORE the cwd choice below, which reads the (validated) `target` out of `args`.
  const built = buildTriggerArgv(kind, args);
  if (!built.ok) {
    return { ok: false, status: 400, message: built.error.message, field: built.error.field };
  }

  // 2b. T23: spawn in the PRIMARY target's repo for this kind. This is the panel-side half of
  //     "each spawn uses that target's own repoRoot as cwd" — and the one place a mistake means
  //     the CLI runs in the wrong repository.
  const chosen = runCwd(entry, kind, args);
  if (!path.isAbsolute(chosen)) {
    return { ok: false, status: 400, message: `workspace "${ws}" has no absolute repoRoot` };
  }
  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(chosen);
    if (!fs.statSync(repoRoot).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, status: 400, message: `the repo of workspace "${ws}" is not a directory` };
  }

  const cli = path.join(toolkitRoot(), "src", "cli.ts");
  if (!fs.existsSync(cli)) {
    return { ok: false, status: 500, message: "the toolkit's src/cli.ts could not be located" };
  }

  // 3. The guard. From here to `runs.set` there is no `await` (see `runningIn`).
  const busy = runningIn(ws);
  if (busy !== null) {
    return {
      ok: false,
      status: 409,
      message:
        `workspace "${ws}" already has a ${busy.kind} run in progress (pid ${busy.pid}). ` +
        "Wait for it to finish, or cancel it, then start this one.",
      runningPid: busy.pid,
    };
  }

  // 3b. The same guard across a panel restart: a child this process did not spawn, but which
  //     `pending/pids.json` says is still running here and whose command line agrees.
  const orphan = orphanRunningIn(ws);
  if (orphan !== null) {
    return {
      ok: false,
      status: 409,
      message:
        `workspace "${ws}" already has a ${orphan.kind} run in progress (pid ${orphan.pid}), ` +
        "started before this panel restarted. This panel cannot cancel it — stop it in the " +
        "terminal it is logging to, or `kill` that pid, then start this one.",
      runningPid: orphan.pid,
    };
  }

  // `--workspace <ws>` is appended HERE, from the validated registry name — not from `args`, which
  // has no field for it. It is what makes the child resolve `aw.config.json` through
  // `workspaces.json` (SPEC § CLI commands) instead of through a path anyone sent us.
  const argv = [...built.argv, "--workspace", ws];

  try {
    fs.mkdirSync(pendingDir(ws), { recursive: true });
  } catch {
    return { ok: false, status: 500, message: "the pending log directory could not be created" };
  }
  sweepPending(ws);

  /*
   * `npx tsx <cli>` is the canonical invocation (SPEC § Fixed decisions) and it is what the panel
   * SHOWS — but `npx` resolves `tsx` against the CHILD's working directory, and that directory is
   * the target repo, which has no reason to depend on tsx. `npx` would then reach for the network
   * to install it: slow, offline-fragile, and a package download nobody asked for. The toolkit's
   * own `node_modules/.bin/tsx` is the exact binary `npx tsx` would find when run from the toolkit
   * root, so it is used directly when it is there — same interpreter, one process instead of
   * three, and each of those three would be one more thing to signal on cancel. `npx` remains the
   * fallback for a toolkit whose dependencies are not installed, where it is the only thing that
   * could work at all.
   */
  const tsxBin = path.join(toolkitRoot(), "node_modules", ".bin", "tsx");
  const local = fs.existsSync(tsxBin);
  const file = local ? tsxBin : "npx";
  const fileArgs = local ? [cli, ...argv] : ["tsx", cli, ...argv];

  let child: ChildProcess;
  try {
    // THE spawn. An array, `shell` unset (false), `detached` so the whole tree can be signalled.
    child = spawn(file, fileArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: true,
    });
  } catch (err) {
    return {
      ok: false,
      status: 500,
      message: `the workflow could not be started: ${(err as Error).message}`,
    };
  }

  const pid = child.pid;
  if (pid === undefined) {
    return { ok: false, status: 500, message: "the workflow could not be started (no pid)" };
  }

  const logFile = path.join(pendingDir(ws), `${pid}.log`);
  const tracked: Tracked = {
    pid,
    ws,
    kind,
    runId: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    state: "running",
    exitCode: null,
    exitSignal: null,
    cancelRequested: false,
    display: displayCommand(argv),
    argv,
    cwd: repoRoot,
    child,
    logFile,
    killTimer: null,
  };
  state().runs.set(pid, tracked);

  attachLog(tracked);
  pruneFinished();
  writePidsFile(ws);
  return { ok: true, run: view(tracked) };
}

// ---------------------------------------------------------------------------
// the transcript
// ---------------------------------------------------------------------------

/**
 * `run saved: <ws>/<runId>` — printed to stderr by `finish()` in src/store.ts (T16 step 2).
 *
 * `(?:^|\n)` rather than a `^` with the `m` flag, and scanned over the STDERR tail alone. Both
 * halves of that were bugs:
 *
 * - one scan buffer fed by both pipes meant a stdout chunk that ended mid-line put the marker
 *   somewhere other than a line start in the concatenated tail, and the anchor missed it. Measured
 *   at the first 64 KB pipe-chunk boundary: a ~71 KB model reply lost the marker 6 times out of 6,
 *   which orphaned the transcript in `pending/` and left the live view saying "this process ended
 *   without saving a run" for a run that had been saved.
 * - `finish()` writes the marker with a single `fs.writeSync(2, …)`, so on the stderr stream alone
 *   it is always at a line start. Keeping the two tails apart is the actual fix; the widened
 *   anchor is the belt to its braces.
 */
const RUN_SAVED = /(?:^|\n)run saved: ([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*(?:\r?\n|$)/;

/** `RUN_SAVED` as a function, so the anchor that used to miss is a unit test and not a run. */
export function matchRunSaved(tail: string): { ws: string; runId: string } | null {
  const match = RUN_SAVED.exec(tail);
  return match === null ? null : { ws: match[1]!, runId: match[2]! };
}

/** How much output is kept while looking for a marker that may straddle two chunks. */
const SCAN_TAIL = 4096;

/**
 * Is this announced run id plausibly the one THIS child created?
 *
 * The marker is read out of the child's own output, and that output is not trustworthy: `log()`
 * writes to stderr (src/workflows/common.ts) and `test-feature`/`review` log `raw model output:`
 * followed by the model's text verbatim — so a model reading a hostile repo (SPEC § Dashboard
 * security invariants #3) can print a `run saved:` line naming any run it likes. Before this
 * check, doing so re-pointed the panel at an unrelated run AND made `archiveTranscript` rename
 * this process's transcript over that run's `spawn.log`: silent data loss inside the store.
 *
 * So the announcement is corroborated against the store, with the same conservative test
 * `adoptRunId` applies to a correlation:
 *
 *   - the workspace is the one we started;
 *   - no other tracked child has already claimed the id;
 *   - a manifest exists at that id, of the kind we started, stamped at or after this child was
 *     spawned (2 s of grace for clock rounding, as in `adoptRunId`).
 *
 * A spoofed id fails the last clause for any run that existed before this one started, which is
 * every run the model could have read a name for.
 */
function announcementIsOurs(run: Tracked, ws: string, runId: string): boolean {
  if (ws !== run.ws) return false;
  for (const other of state().runs.values()) {
    if (other.pid !== run.pid && other.ws === ws && other.runId === runId) return false;
  }
  const manifest = readRun(ws, runId);
  if (manifest === null) return false;
  if (manifest.kind !== run.kind) return false;
  const startedMs = new Date(run.startedAt).getTime();
  const createdMs = new Date(manifest.createdAt).getTime();
  if (Number.isNaN(startedMs) || Number.isNaN(createdMs)) return false;
  return createdMs >= startedMs - 2000;
}

function attachLog(run: Tracked): void {
  /*
   * ONE write stream for both pipes, and `write()` rather than `pipe()`.
   *
   * Two independent `pipe()`s into the same file interleave at chunk boundaries — the CLI writes
   * its progress to stderr and its result to stdout, and a half-written stderr line with a
   * VERDICT spliced into the middle of it is not a transcript anyone can read. Funnelling both
   * through one stream keeps chunks whole and in arrival order.
   */
  /*
   * A FRESH file, never an append, and never through a symlink.
   *
   * `flags: "a"` meant a recycled pid inherited whatever `pending/<pid>.log` was still lying
   * around — and transcripts do lie around: `sweepPending` only collects them after 7 days, and
   * macOS recycles pids well inside that. The new run's live view would then replay a stranger's
   * output as its own. `unlink` then `wx` (`O_WRONLY|O_CREAT|O_EXCL`) gives a guaranteed-new file
   * — and, for free, the property `O_NOFOLLOW` would have given: `unlink` removes a symlink
   * itself rather than its target, and `O_EXCL` then refuses to open ANY existing name, so a link
   * re-planted in the gap fails the open instead of being written through. That matters because
   * `pending/` sits inside a store agents with `bash` also write to.
   */
  try {
    fs.unlinkSync(run.logFile);
  } catch {
    /* nothing to replace — the normal case */
  }
  const sink = fs.createWriteStream(run.logFile, { flags: "wx" });
  sink.on("error", () => {
    /* a transcript that cannot be written must not kill the run producing it */
  });

  /*
   * The header IS the injection audit trail (T22, SPEC § Dashboard security invariants #4).
   *
   * One line per argv element, JSON-encoded, so a value containing `;`, `$(…)`, a backtick or a
   * newline is visible as ONE element with those bytes inside it rather than as something that
   * happened to split. Anyone reading a run's log can check what the process was actually given.
   */
  const argvLines = run.child.spawnargs.map(
    (value, index) => `[runner] argv[${index}]=${JSON.stringify(value)}`,
  );
  sink.write(
    [
      `[runner] ${run.startedAt} pid=${run.pid} ws=${run.ws} kind=${run.kind}`,
      `[runner] cwd=${run.cwd}`,
      "[runner] spawned with an argv ARRAY and shell=false — every argv[i] below is one literal",
      "[runner] execve argument, byte for byte. No shell parses any of it.",
      ...argvLines,
      "",
    ].join("\n"),
  );

  /*
   * ONE file, but TWO scan buffers.
   *
   * The transcript is still a single stream in arrival order (above). The marker hunt is not: it
   * runs over the stderr tail only, because that is the pipe `finish()` writes the marker to, and
   * because a stdout chunk boundary landing mid-line in a shared buffer is exactly what used to
   * make the `^` anchor miss it. See `RUN_SAVED`.
   */
  let stderrTail = "";
  let announced = false;

  const write = (chunk: Buffer): void => {
    sink.write(chunk);
  };

  const onStderr = (chunk: Buffer): void => {
    write(chunk);
    // Keep scanning even after `adoptRunId` has guessed one: this marker is the CLI's own
    // statement of what it saved, and it overrides a correlation — once corroborated.
    if (announced) return;
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-SCAN_TAIL);
    const match = matchRunSaved(stderrTail);
    if (match === null) return;
    // Not "the workspace matches" any more: the whole announcement is checked against the store,
    // because the model's own words reach this stream (see `announcementIsOurs`).
    if (!announcementIsOurs(run, match.ws, match.runId)) return;
    announced = true;
    run.runId = match.runId;
    writePidsFile(run.ws);
  };

  run.child.stdout?.on("data", write);
  run.child.stderr?.on("data", onStderr);

  const done = (code: number | null, signal: NodeJS.Signals | null): void => {
    sink.write(
      `\n[runner] ${new Date().toISOString()} exited code=${code ?? "null"} signal=${signal ?? "none"}` +
        `${run.runId === null ? " (no run id was announced)" : ` run=${run.ws}/${run.runId}`}\n`,
    );
    sink.end(() => archiveTranscript(run));
    finish(run, code, signal);
  };

  run.child.once("exit", done);
  run.child.once("error", (err) => {
    sink.write(`\n[runner] could not be started: ${err.message}\n`);
    sink.end(() => archiveTranscript(run));
    finish(run, null, null);
  });
}

/** Record the terminal state of a tracked child. Idempotent. */
function finish(run: Tracked, code: number | null, signal: NodeJS.Signals | null): void {
  if (run.state === "exited") return;
  run.state = "exited";
  run.endedAt = new Date().toISOString();
  run.exitCode = code;
  run.exitSignal = signal;
  if (run.killTimer !== null) {
    // Always: a live timer would SIGKILL whatever process inherits this pid next.
    clearTimeout(run.killTimer);
    run.killTimer = null;
  }
  writePidsFile(run.ws);
}

/**
 * Move the finished transcript next to the run it belongs to, as `<runDir>/spawn.log`.
 *
 * T22 step 1 says to move it into the run's `log.txt`. It is kept beside it instead, and that is a
 * recorded deviation: `log.txt` is written by the CLI itself as the run happens (`setLogSink` in
 * src/workflows/common.ts mirrors every `log()` and every stdout line into it), so appending this
 * file would duplicate nearly every line of it. What this transcript has that `log.txt` does not
 * is the part `log.txt` cannot have — the argv header above, `npx`/`tsx` output, an uncaught
 * stack, and everything printed BEFORE `startRun` created the run directory. That is worth
 * keeping, and worth keeping separate.
 *
 * A run that never announced a run id has no directory to move into; its transcript stays in
 * `pending/` (where `sweepPending` eventually collects it) and is the only record of why.
 */
function archiveTranscript(run: Tracked): void {
  if (run.runId === null) return;
  const dir = realRunDir(run.ws, run.runId);
  if (dir === null || readRun(run.ws, run.runId) === null) return;
  const target = path.join(dir, "spawn.log");
  // Never over another transcript. `rename` replaces silently, and an id that is not ours (a
  // spoofed marker, a correlation that guessed wrong) would take a different run's `spawn.log`
  // with it. `announcementIsOurs`/`adoptRunId` make that hard; this makes it impossible.
  try {
    fs.lstatSync(target);
    return;
  } catch {
    /* nothing there — the normal case */
  }
  try {
    fs.renameSync(run.logFile, target);
  } catch {
    // Different filesystems, or a race with a reader holding the file open: copy, then unlink.
    try {
      fs.copyFileSync(run.logFile, target);
      fs.unlinkSync(run.logFile);
    } catch {
      /* the transcript stays in pending/ — no run is failed over a log file */
    }
  }
}

// ---------------------------------------------------------------------------
// cancelling
// ---------------------------------------------------------------------------

/** T22 step 1: SIGTERM, then SIGKILL after 10 s. */
export const CANCEL_ESCALATE_MS = 10_000;

export type CancelResult =
  | { ok: true; run: ActiveRun; escalated: false }
  | { ok: false; status: number; message: string };

/**
 * Signal a whole process group, falling back to the single process.
 *
 * `-pid` is the group (the child is `detached`, so its group id IS its pid). The fallback covers
 * the case where the group is already empty but the leader has not been reaped yet.
 */
function signalTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // ESRCH — already gone
    }
  }
}

export function cancelTriggeredRun(pid: unknown): CancelResult {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return { ok: false, status: 400, message: "pid must be a positive integer" };
  }
  // The ONLY source of cancellable pids. A number from a request never reaches `process.kill`
  // unless this map says we started it.
  const run = state().runs.get(pid);
  if (run === undefined) {
    return { ok: false, status: 404, message: "no run with that pid was started by this panel" };
  }
  if (run.state === "exited") {
    return { ok: false, status: 409, message: "that run has already finished" };
  }

  run.cancelRequested = true;
  signalTree(pid, "SIGTERM");
  writePidsFile(run.ws);

  if (run.killTimer === null) {
    run.killTimer = setTimeout(() => {
      run.killTimer = null;
      // `state !== 'exited'` is checked again inside the timer: the child almost always dies from
      // the SIGTERM, and SIGKILLing a group whose leader has been reaped could reach a recycled pid.
      if (run.state === "exited") return;
      if (!isAlive(pid)) {
        finish(run, null, null);
        return;
      }
      signalTree(pid, "SIGKILL");
    }, CANCEL_ESCALATE_MS);
    // Do not hold the process open for the escalation alone.
    run.killTimer.unref?.();
  }

  return { ok: true, run: view(run), escalated: false };
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * Work out which run directory a still-running child is writing to.
 *
 * The CLI announces `run saved: <ws>/<runId>` only when it FINISHES (src/store.ts `finish`), so a
 * run that has been going for four minutes has no id to link to — and, worse, its `running`
 * manifest looks to the panel like a run somebody started in a terminal, so the "in progress"
 * banner listed the same run twice: once as a process, once as an orphan manifest. (Caught by a
 * screenshot in this task's verification, not by an assertion.)
 *
 * The manifest exists from the moment `startRun` creates the run directory, so the id is on disk;
 * it just has not been spoken aloud. This correlates the two, conservatively:
 *
 *   - same workspace, same kind, and `createdAt` at or after this child was spawned;
 *   - not already claimed by another tracked child;
 *   - and EXACTLY one candidate. Two candidates means something else is running in this workspace
 *     (the 1-per-workspace guard covers the panel, not a terminal), and a guess that could name
 *     the wrong run is worse than no link at all.
 *
 * Whatever this decides is provisional: `run saved:` overrides it the moment it is printed.
 */
function adoptRunId(run: Tracked): void {
  if (run.runId !== null) return;
  const startedMs = new Date(run.startedAt).getTime();
  if (Number.isNaN(startedMs)) return;
  const claimed = new Set(
    [...state().runs.values()].map((r) => r.runId).filter((id): id is string => id !== null),
  );
  // A 2 s grace: the child is spawned, then loads config and resolves a model before `startRun`
  // stamps `createdAt`, and the two clocks are the same one — but a run stamped a hair before the
  // spawn timestamp (rounding, an NTP step) would otherwise never be adopted.
  const candidates = listRuns(run.ws).filter(
    (m) =>
      m.kind === run.kind &&
      // `running`, as the doc comment above has always claimed: this correlates a LIVE child with
      // the manifest it is writing. Without it a finished run stamped inside the grace window was
      // an eligible candidate, and `archiveTranscript` would have filed this child's transcript in
      // that other run's directory.
      m.status === "running" &&
      !claimed.has(m.runId) &&
      new Date(m.createdAt).getTime() >= startedMs - 2000,
  );
  if (candidates.length !== 1) return;
  run.runId = candidates[0]!.runId;
  writePidsFile(run.ws);
}

/** Every run this panel process started, newest first; optionally one workspace's. */
export function listTriggeredRuns(ws?: string): ActiveRun[] {
  const all = [...state().runs.values()]
    .filter((r) => ws === undefined || r.ws === ws)
    .map(view)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return all;
}

/** The ones still going — what the "running" badges and the 1-per-workspace guard care about. */
export function listActiveRuns(ws?: string): ActiveRun[] {
  for (const run of [...state().runs.values()]) {
    // Reap first, so a child that died without an 'exit' event is not reported as running.
    if (run.state === "running" && !isAlive(run.pid)) finish(run, null, null);
    else if (run.state === "running" && (ws === undefined || run.ws === ws)) adoptRunId(run);
  }
  return listTriggeredRuns(ws).filter((r) => r.state === "running");
}

export function getTriggeredRun(pid: number): ActiveRun | null {
  const run = state().runs.get(pid);
  if (run === undefined) return null;
  if (run.state === "running") adoptRunId(run);
  return view(run);
}

/**
 * How many finished runs stay in the map.
 *
 * A finished entry is what the live view reads to show "it ended, here is the run" after the
 * stream closes, so it cannot be dropped at exit. It also cannot grow forever in a server that is
 * left running for days, so the oldest are pruned once there are more than this many.
 */
const KEEP_FINISHED = 50;

export function pruneFinished(): void {
  const finished = [...state().runs.values()]
    .filter((r) => r.state === "exited")
    .sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? ""));
  for (const run of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
    state().runs.delete(run.pid);
  }
}
