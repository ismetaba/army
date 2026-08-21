import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Root of the agent-workflows state directory.
 * SPEC § Storage: `~/.agent-workflows`, overridable with env `AW_HOME`.
 * Read from the environment on every call so tests can change it at runtime.
 */
export function awHome(): string {
  const override = process.env.AW_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.agent-workflows');
}

/**
 * Filesystem-safe slug for a single path segment (T06 step 2; reused by T09/T10/T16).
 * Lowercases, collapses every run of non-alphanumerics into `-`, trims leading/trailing `-`.
 * Because `/`, `.` and spaces all collapse to `-`, the result can never traverse directories.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// ensureUp — "is the app under test listening, and if not, start it"
// (T09 step 3; T10 needs the same dance for the frontend dev server)
// ---------------------------------------------------------------------------

/**
 * Hostnames that mean "this machine". Deliberately the same narrow set that
 * `src/tools/core.ts` exempts from the destructive-method guard, plus the IPv6 loopback:
 * a workflow must never treat a host as local that the tool layer would treat as remote.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** True when `url` is a parseable http(s) URL pointing at this machine. */
export function isLocalUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface ProbeResult {
  /** A server answered. Any status counts — 404 still means "the port is listening". */
  up: boolean;
  status?: number;
  error?: string;
}

/**
 * One HTTP probe with its own timeout.
 *
 * "Up" means *something answered*, not that it answered well: a health path that 404s still
 * proves the process is listening, and reporting it as down would make the caller start a
 * second copy of the server.
 */
export async function probeUrl(url: string, timeoutMs = 5_000): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is never used, but leaving it unread keeps the socket busy.
    await response.arrayBuffer().catch(() => undefined);
    return { up: true, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { up: false, error: message };
  }
}

export interface EnsureUpOptions {
  /** URL polled to decide whether the app is up (usually `<baseUrl><healthPath>`). */
  url: string;
  /** Shell command that starts the app; omitted means "never start anything". */
  start?: string;
  /** Working directory for `start` — the target repo root. */
  cwd?: string;
  /** Timeout of a single probe (default 5 s). */
  probeTimeoutMs?: number;
  /** How long to keep polling after starting (default 60 s). */
  waitMs?: number;
  /** Delay between polls (default 2 s). */
  intervalMs?: number;
  /** Where the child's stdout/stderr and progress lines go (default: nothing). */
  log?: (line: string) => void;
}

export interface EnsureUpHandle {
  up: boolean;
  /** True when this call spawned `start` (so the caller owns the process). */
  started: boolean;
  /** The command that was run, when one was. */
  command?: string;
  /** Last probe error, for the caller's failure message. */
  lastError?: string;
  /**
   * Terminate the spawned process group. Synchronous and safe to call repeatedly — it is
   * also called from a `process.on('exit')` handler, where nothing can be awaited.
   */
  stop(): void;
  /** `stop()`, then wait (up to `graceMs`) for the process to actually die, SIGKILLing if not. */
  stopAndWait(graceMs?: number): Promise<void>;
}

const NOOP_HANDLE = (up: boolean, lastError?: string): EnsureUpHandle => ({
  up,
  started: false,
  lastError,
  stop() {},
  async stopAndWait() {},
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Make sure `url` answers, starting the app with `start` if it does not.
 *
 * The child is spawned `detached`, so it becomes its own process-group leader and
 * `kill(-pid)` reaches the whole tree — `npm run dev:api` is a shell that spawns npm that
 * spawns node, and killing only the shell would leave the server holding the port.
 *
 * Never throws: a failure to start is reported through `up: false` + `lastError`, because the
 * caller has a better error message (it knows the target and the config field) than this does.
 */
export async function ensureUp(opts: EnsureUpOptions): Promise<EnsureUpHandle> {
  const {
    url,
    start,
    cwd,
    probeTimeoutMs = 5_000,
    waitMs = 60_000,
    intervalMs = 2_000,
    log = () => {},
  } = opts;

  const first = await probeUrl(url, probeTimeoutMs);
  if (first.up) return NOOP_HANDLE(true);
  if (!start?.trim()) return NOOP_HANDLE(false, first.error);

  const command = start.trim();
  log(`target is down (${first.error ?? 'no response'}) — starting: ${command}`);

  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let exited = false;
  let exitNote: string | undefined;
  child.once('exit', (code, signal) => {
    exited = true;
    exitNote = `start command exited early (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
  });
  // A command that cannot be spawned at all (bad cwd) reports through 'error', not 'exit'.
  child.once('error', (err) => {
    exited = true;
    exitNote = `start command could not be run: ${err.message}`;
  });

  const pipe = (stream: NodeJS.ReadableStream | null, tag: string): void => {
    if (!stream) return;
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) log(`[${tag}] ${line}`);
    });
  };
  pipe(child.stdout, 'app');
  pipe(child.stderr, 'app');

  const pid = child.pid;
  let stopped = false;
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (pid === undefined) return;
    try {
      // Negative pid = the whole process group (see `detached` above).
      process.kill(-pid, signal);
    } catch {
      // ESRCH: already gone. Nothing else can be done from here.
    }
  };
  const stop = (): void => {
    if (stopped || exited) return;
    stopped = true;
    signalGroup('SIGTERM');
  };
  // Registered before the poll loop: an `exit` triggered by a later `process.exit(1)` must
  // still take the server down, or a failed run leaves the port occupied.
  const onExit = (): void => stop();
  process.once('exit', onExit);

  const handle = (up: boolean, lastError?: string): EnsureUpHandle => ({
    up,
    started: true,
    command,
    lastError,
    stop,
    async stopAndWait(graceMs = 5_000) {
      process.removeListener('exit', onExit);
      stop();
      const until = Date.now() + graceMs;
      while (!exited && Date.now() < until) await sleep(100);
      // SIGTERM ignored (or swallowed by an npm wrapper): take the port back by force.
      if (!exited) signalGroup('SIGKILL');
    },
  });

  const deadline = Date.now() + waitMs;
  let lastError = first.error;
  for (;;) {
    if (exited) return handle(false, exitNote ?? lastError);
    await sleep(intervalMs);
    const probe = await probeUrl(url, probeTimeoutMs);
    if (probe.up) {
      log(`target is up: ${url} (${probe.status})`);
      return handle(true);
    }
    lastError = probe.error;
    if (Date.now() >= deadline) break;
  }

  log(`target still down after ${Math.round(waitMs / 1000)}s`);
  stop();
  return handle(false, lastError);
}
