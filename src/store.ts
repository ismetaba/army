/**
 * T16 — the run store: every workflow run leaves a machine-readable trail on disk.
 *
 * SPEC § Storage:
 *
 * ```
 * $AW_HOME/                          (default ~/.agent-workflows)
 * ├── workspaces.json                # WorkspacesFile
 * └── <workspace>/runs/<runId>/
 *     ├── manifest.json              # RunManifest
 *     ├── log.txt                    # streamed agent/tool output
 *     └── artifacts/                 # diff.patch, report.md, screenshots/, video.webm
 * ```
 *
 * Two rules shape everything below, because the dashboard (T17+) reads this directory while
 * workflows are writing it:
 *
 * 1. **A run never stays `running` after any exit the process can observe.** `startRun` installs
 *    one `exit` handler and one handler per termination signal, so a workflow that calls
 *    `process.exit()` (every `fail()` does), throws, or is SIGTERMed still leaves a terminal
 *    status behind. A manifest stuck on `running` is indistinguishable from a run in progress,
 *    and the panel would show a ghost forever. The two exits nothing in-process can cover are
 *    `SIGKILL` and losing power: neither runs a handler, so both do leave a ghost `running`
 *    manifest behind, and only a reader comparing its age against the clock can tell.
 * 2. **A reader never throws.** `listRuns` skips a manifest it cannot parse instead of failing
 *    the whole listing: one truncated file — a run killed mid-write, an older schema — must not
 *    take the dashboard down with it.
 *
 * Every write here is synchronous, because the safety net runs inside `process.on('exit')`,
 * where nothing asynchronous can be awaited.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RunManifest, WorkspacesFile } from '../shared/schemas';
import type { AgentName, ProviderId, Workspace } from '../shared/schemas';
import { awHome } from './util';

// `awHome()` is defined in src/util.ts (T03) and re-exported here so the store is the single
// import the dashboard and the workflows need. One implementation, two names for it.
export { awHome };

export type RunKind = RunManifest['kind'];
export type RunStatus = RunManifest['status'];
export type TerminalStatus = Exclude<RunStatus, 'running'>;
export type RunInput = RunManifest['input'];
/** Fields a workflow may fill in as it goes; `status`/`durationMs` are the store's business. */
export type RunPatch = Partial<Omit<RunManifest, 'runId' | 'kind' | 'workspace' | 'createdAt'>>;

/** Thrown for programmer errors (a bad workspace name, an artifact path escaping the run). */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

/**
 * A workspace name and a run id both become a single directory segment under `$AW_HOME`.
 * Same rule `aw init` validates workspace names with (src/commands/init.ts): a leading
 * alphanumeric, then letters, digits, `.`, `-`, `_`. `.`, `..` and anything containing a
 * separator are rejected by construction, so no caller can traverse out of the store.
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!SAFE_SEGMENT_RE.test(trimmed)) {
    throw new StoreError(
      `invalid ${label} "${value}" — it becomes a directory under ${awHome()}, so it must be a ` +
        'single segment of letters, digits, ".", "-" or "_" starting with a letter or digit',
    );
  }
  return trimmed;
}

/** `$AW_HOME/<workspace>`. */
export function workspaceDir(workspace: string): string {
  return path.join(awHome(), checkSegment(workspace, 'workspace name'));
}

/** `$AW_HOME/<workspace>/runs`. */
export function runsDir(workspace: string): string {
  return path.join(workspaceDir(workspace), 'runs');
}

/** `$AW_HOME/<workspace>/runs/<runId>`. */
export function runDir(workspace: string, runId: string): string {
  return path.join(runsDir(workspace), checkSegment(runId, 'run id'));
}

/** `$AW_HOME/workspaces.json` (SPEC § Storage). */
export function workspacesPath(): string {
  return path.join(awHome(), 'workspaces.json');
}

// ---------------------------------------------------------------------------
// creating a run
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `YYYYMMDD-HHmmss` in LOCAL time — a run id must match the clock the user ran it by. */
export function runTimestamp(now: Date = new Date()): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * Create `<awHome>/<workspace>/runs/<runId>/artifacts/` and return the run id and directory.
 *
 * The run directory is created with a non-recursive `mkdir` on purpose: it is what makes the
 * id collision *visible*. Two runs started in the same second would otherwise share a directory
 * and the second would overwrite the first one's manifest, log and artifacts — so the second
 * gets `-2`, the third `-3`, exactly like the test-report namer in T09.
 */
export function newRun(
  workspace: string,
  kind: RunKind,
  now: Date = new Date(),
): { runId: string; dir: string } {
  const runs = runsDir(workspace);
  /**
   * A store that cannot be written to is reported as a store problem, naming `$AW_HOME` — that
   * is the knob the user has to turn. A bare `EACCES: permission denied, mkdir '…'` mentions
   * neither the setting nor what the directory is for.
   */
  const mkdir = (dir: string, recursive: boolean): void => {
    try {
      fs.mkdirSync(dir, { recursive });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'EEXIST' && !recursive) throw err; // the id-collision path below handles it
      throw new StoreError(
        `cannot create the run directory ${dir} under $AW_HOME (${awHome()}): ` +
          `${e.code ?? 'error'} — ${e.message}`,
      );
    }
  };

  mkdir(runs, true);
  const base = `${kind}-${runTimestamp(now)}`;
  for (let n = 1; n < 1000; n += 1) {
    const runId = n === 1 ? base : `${base}-${n}`;
    const dir = path.join(runs, runId);
    try {
      mkdir(dir, false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    mkdir(path.join(dir, 'artifacts'), true);
    return { runId, dir };
  }
  throw new StoreError(`cannot allocate a run id: ${path.join(runs, base)} and 999 suffixes exist`);
}

// ---------------------------------------------------------------------------
// manifest / log / artifacts
// ---------------------------------------------------------------------------

/**
 * Validate with `RunManifest.parse` FIRST, then write pretty JSON.
 *
 * Validation before writing is the point: an invalid manifest that reached disk would be
 * skipped by `listRuns` and the run would silently vanish from the dashboard. Better to throw
 * in the workflow, where the wrong field is still fixable.
 *
 * The write goes through a temp file + `rename` so a reader never sees half a manifest: the
 * dashboard polls this file while the run is still going.
 */
export function writeManifest(dir: string, m: RunManifest): void {
  const manifest = RunManifest.parse(m);
  const file = path.join(dir, 'manifest.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** `[HH:mm:ss] ` in local time, per T16 step 1. */
function stamp(now: Date = new Date()): string {
  return `[${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}] `;
}

/**
 * Append one entry to the run's `log.txt`.
 *
 * Every physical line gets the prefix, not just the first: tool results are multi-line and a
 * continuation line that starts with `[` would otherwise be unparseable for the log viewer.
 * Never throws — losing a log line must not fail the run that was producing it.
 */
export function appendLog(dir: string, line: string): void {
  const prefix = stamp();
  const text = String(line)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
  try {
    fs.appendFileSync(path.join(dir, 'log.txt'), `${text}\n`, 'utf8');
  } catch {
    // A full or read-only disk is the run's problem, not the log's.
  }
}

/**
 * A relative artifact name: POSIX separators, no `..`, never absolute.
 * Sub-paths are allowed (`screenshots/home-mobile.png`) — the design loop needs them — but
 * nothing may climb out of `artifacts/`.
 */
function artifactName(name: string): string {
  const parts = name
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) throw new StoreError('artifact name is empty');
  if (parts.some((p) => p === '..')) {
    throw new StoreError(`artifact name must stay inside artifacts/: "${name}"`);
  }
  return parts.join('/');
}

/**
 * Write `artifacts/<name>` under the run directory and return that RELATIVE path.
 *
 * Relative on purpose: the manifest is copied around, read by the dashboard from a different
 * working directory, and `$AW_HOME` can move. A path relative to the run directory survives all
 * three; an absolute one pins the manifest to one machine.
 */
export function saveArtifact(dir: string, name: string, content: string | Buffer): string {
  const rel = artifactName(name);
  const file = path.join(dir, 'artifacts', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return `artifacts/${rel}`;
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/** Where a skipped/corrupt run is reported. Default: stderr, like every other progress line. */
export interface ReadOptions {
  onWarn?: (message: string) => void;
}

function warnTo(opts: ReadOptions): (message: string) => void {
  return (
    opts.onWarn ??
    ((message: string) => {
      try {
        fs.writeSync(2, `warning: ${message}\n`);
      } catch {
        // stderr is gone; the skip already happened.
      }
    })
  );
}

/** Parse one `manifest.json`, or explain why it cannot be used. Never throws. */
function loadManifest(dir: string): { ok: true; manifest: RunManifest } | { ok: false; why: string } {
  const file = path.join(dir, 'manifest.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, why: code === 'ENOENT' ? 'no manifest.json' : `unreadable (${code})` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return { ok: false, why: `not valid JSON (${(err as Error).message})` };
  }
  const parsed = RunManifest.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join('.') : '(root)';
    return { ok: false, why: `not a RunManifest (${where}: ${issue?.message ?? 'invalid'})` };
  }
  return { ok: true, manifest: parsed.data };
}

/** Every workspace that has a `runs/` directory, whether or not it is in workspaces.json. */
function storedWorkspaces(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(awHome(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SAFE_SEGMENT_RE.test(e.name))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(awHome(), name, 'runs')))
    .sort();
}

/**
 * Every run, newest first. With no argument: every workspace under `$AW_HOME`.
 *
 * A manifest that is missing, truncated, or from an incompatible schema is SKIPPED with a
 * warning. The dashboard lists whatever is readable; one bad file is a gap in a table, not a
 * 500. Sorted by `createdAt` (ISO 8601 sorts lexically), with the run id as the tie-break so
 * two runs from the same second keep a stable order.
 */
export function listRuns(workspace?: string, opts: ReadOptions = {}): RunManifest[] {
  const warn = warnTo(opts);
  const names = workspace ? [checkSegment(workspace, 'workspace name')] : storedWorkspaces();
  const out: RunManifest[] = [];
  for (const name of names) {
    const dir = runsDir(name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // No runs yet for this workspace; an explicit `--workspace` that never ran is not an error.
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const loaded = loadManifest(path.join(dir, entry.name));
      if (!loaded.ok) {
        warn(`skipped run ${name}/${entry.name}: ${loaded.why}`);
        continue;
      }
      out.push(loaded.manifest);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
}

/** One run's manifest, or `null` when it is missing or unreadable (with a warning). */
export function readRun(
  workspace: string,
  runId: string,
  opts: ReadOptions = {},
): RunManifest | null {
  const loaded = loadManifest(runDir(workspace, runId));
  if (!loaded.ok) {
    warnTo(opts)(`cannot read run ${workspace}/${runId}: ${loaded.why}`);
    return null;
  }
  return loaded.manifest;
}

/** The run's `log.txt`, or `''` when it has none. Never throws. */
export function readLog(workspace: string, runId: string): string {
  try {
    return fs.readFileSync(path.join(runDir(workspace, runId), 'log.txt'), 'utf8');
  } catch {
    return '';
  }
}

/** The registered workspaces (SPEC § Storage). `[]` when the registry is missing or invalid. */
export function listWorkspaces(opts: ReadOptions = {}): Workspace[] {
  const file = workspacesPath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    warnTo(opts)(`ignoring ${file}: not valid JSON (${(err as Error).message})`);
    return [];
  }
  const parsed = WorkspacesFile.safeParse(raw);
  if (!parsed.success) {
    warnTo(opts)(`ignoring ${file}: not a WorkspacesFile`);
    return [];
  }
  return parsed.data.workspaces;
}

// ---------------------------------------------------------------------------
// recording a live run
// ---------------------------------------------------------------------------

export interface RunInit {
  workspace: string;
  kind: RunKind;
  agent: AgentName;
  provider: ProviderId;
  model: string;
  input: RunInput;
  /** Injectable clock — the tests need two runs with different timestamps. */
  now?: Date;
}

export interface RunHandle {
  readonly runId: string;
  readonly dir: string;
  readonly workspace: string;
  /** The manifest as it currently stands on disk. */
  readonly manifest: RunManifest;
  /** True once a terminal status has been written. */
  readonly finished: boolean;
  /** Append to `log.txt`. Bound, so it can be handed straight to `setLogSink`. */
  log: (line: string) => void;
  /**
   * `saveArtifact` into this run; returns the relative path to store in the manifest.
   *
   * NEVER throws: a full or read-only store must not turn a review that produced a verdict into
   * a crashed run (see `update`/`finish` below — same rule). A failed write warns on stderr and
   * in `log.txt` and still returns the run-relative path it would have written, because manifest
   * artifact paths are relative by contract; the panel renders one whose file is absent as
   * missing rather than as a link.
   */
  artifact: (name: string, content: string | Buffer) => string;
  /** Merge fields into the manifest and rewrite it (still `running`). */
  update: (patch: RunPatch) => void;
  /** Write the terminal status + `durationMs`. Idempotent: the first call wins. */
  finish: (status: TerminalStatus, patch?: RunPatch) => void;
}

interface OpenRun {
  finish: (status: TerminalStatus, patch?: RunPatch) => void;
  get finished(): boolean;
}

/** Runs that have not reached a terminal status yet, for the exit/signal safety net. */
const openRuns = new Set<OpenRun>();

/**
 * The message of the failure that is about to end the process.
 *
 * `fail()` (src/workflows/common.ts) prints to stderr and calls `process.exit(1)`, so the
 * workflow's own `catch` never runs and the reason would be lost. It hands the message here
 * first; the `exit` handler then records the run as `error` with the reason the user was shown,
 * instead of a generic "the process exited".
 */
let pendingFailure: string | undefined;

export function noteRunFailure(message: string): void {
  pendingFailure = message.trim() || undefined;
}

const SIGNAL_EXIT_CODE: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

let guardsInstalled = false;

function finalizeOpen(status: TerminalStatus, reason: string): void {
  for (const run of [...openRuns]) {
    try {
      run.finish(status, { error: reason });
    } catch {
      // Nothing useful can be done while the process is on its way out.
    }
  }
}

/**
 * Install the "no run stays `running`" net, once per process.
 *
 * - `exit`: covers `fail()`/`process.exit()` and any uncaught throw — both end the process
 *   without unwinding the workflow's `try/catch`.
 * - `SIGINT`/`SIGTERM`/`SIGHUP`: a killed run is `cancelled`, not `error`. Registering these
 *   replaces the default "die immediately" behaviour, so each handler exits explicitly with the
 *   conventional 128+signal code — which also lets the `exit` handlers that stop dev servers
 *   (src/util.ts `ensureUp`) run, instead of leaving the port held.
 */
function installGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on('exit', (code) => {
    if (openRuns.size === 0) return;
    finalizeOpen(
      'error',
      pendingFailure ?? `the process exited (code ${code}) before the run recorded a result`,
    );
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    process.on(signal, () => {
      finalizeOpen('cancelled', `received ${signal}`);
      process.exit(SIGNAL_EXIT_CODE[signal] ?? 1);
    });
  }
}

function writeStderr(line: string): void {
  try {
    fs.writeSync(2, `${line}\n`);
  } catch {
    // A closed stderr must not turn a finished run into a crash.
  }
}

/**
 * Begin recording a run: create its directory, write the `running` manifest, and register it
 * with the safety net. The returned handle is the only thing a workflow needs.
 */
export function startRun(init: RunInit): RunHandle {
  const now = init.now ?? new Date();
  const workspace = checkSegment(init.workspace, 'workspace name');
  const { runId, dir } = newRun(workspace, init.kind, now);
  const startedMs = Date.now();

  let current: RunManifest = RunManifest.parse({
    runId,
    kind: init.kind,
    workspace,
    createdAt: now.toISOString(),
    agent: init.agent,
    provider: init.provider,
    model: init.model,
    status: 'running',
    input: init.input,
  });
  writeManifest(dir, current);

  let finished = false;
  const log = (line: string): void => appendLog(dir, line);
  log(`run ${runId} started — ${init.kind}, ${init.agent}, ${init.provider}/${init.model}`);
  log(`args: ${init.input.args}`);

  /**
   * Why a mid-run `update` could not be written, if one could not.
   *
   * Recording is not allowed to break the thing it records: a rejected result block (or a full
   * disk) must not turn a finished review into a crashed one. It is reported on stderr, in the
   * run log, and — so the panel shows it too — in the finished manifest's `error`.
   */
  let updateProblem: string | undefined;

  /** Validate + write, or say why not. Never throws. */
  const seal = (candidate: unknown): string | undefined => {
    try {
      const parsed = RunManifest.parse(candidate);
      writeManifest(dir, parsed);
      current = parsed;
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const handle: RunHandle = {
    runId,
    dir,
    workspace,
    get manifest() {
      return current;
    },
    get finished() {
      return finished;
    },
    log,
    artifact: (name, content) => {
      try {
        return saveArtifact(dir, name, content);
      } catch (err) {
        const why = `could not save artifact "${name}": ${err instanceof Error ? err.message : String(err)}`;
        log(`warning: ${why}`);
        writeStderr(`warning: ${why}`);
        const rel = String(name)
          .split(/[\\/]+/)
          .map((p) => p.trim())
          .filter((p) => p !== '' && p !== '.' && p !== '..')
          .join('/');
        return `artifacts/${rel}`;
      }
    },
    update: (patch) => {
      if (finished) return;
      const why = seal({ ...current, ...patch, status: current.status });
      if (why === undefined) return;
      updateProblem = `manifest update rejected: ${why}`;
      log(`warning: ${updateProblem}`);
      writeStderr(`warning: ${updateProblem}`);
    },
    finish: (status, patch = {}) => {
      if (finished) return;
      finished = true;
      openRuns.delete(entry);
      const durationMs = Date.now() - startedMs;
      const error = patch.error ?? updateProblem;
      const why = seal({ ...current, ...patch, status, durationMs, ...(error ? { error } : {}) });
      if (why !== undefined) {
        // The recorded *result* must never cost us the terminal status: fall back to a
        // manifest that carries only the status and the reason the rest was rejected.
        seal({
          ...current,
          status,
          durationMs,
          error: `${error ? `${error} — ` : ''}manifest rejected: ${why}`,
        });
      }
      // Duration on the first line: `error` is often several lines long, and a `(52 ms)` glued
      // to the end of a raw model dump reads as part of the dump.
      log(`run ${status} in ${current.durationMs} ms${current.error ? `\n${current.error}` : ''}`);
      // T16 step 2: printed at the very end of EVERY run. stderr, because stdout carries the
      // workflow's contract output (the VERDICT block, the report path) and nothing else.
      writeStderr(`run saved: ${workspace}/${runId}`);
    },
  };

  const entry: OpenRun = {
    finish: handle.finish,
    get finished() {
      return finished;
    },
  };
  openRuns.add(entry);
  installGuards();
  return handle;
}
