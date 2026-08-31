import { execFile as execFileCb, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

const execFileAsync = promisify(execFileCb);

/** Permission profile — SPEC § "Tools and permission profiles". */
export type ToolProfile = 'designer' | 'tester' | 'reviewer';

/** Every returned string is capped at 8 KB (http bodies at 4 KB, see below). */
const MAX_OUTPUT = 8 * 1024;
const MAX_HTTP_BODY = 4 * 1024;
const TRUNCATED = '…[truncated]';

/** Files bigger than this are refused by read_file instead of being slurped into memory. */
const MAX_READ_BYTES = 20 * 1024 * 1024;
const EXEC_MAX_BUFFER = 16 * 1024 * 1024;

const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 600_000;
/** After the timeout's SIGTERM, how long the process group gets before SIGKILL. */
const BASH_KILL_GRACE_MS = 2_000;
/** After the SIGKILL, how long we still wait for the pipes to close before reporting anyway. */
const BASH_CLOSE_GRACE_MS = 500;
const HTTP_TIMEOUT_MS = 30_000;

/** The only subtree the `tester` profile may write to (SPEC tools table). */
export const TESTER_WRITE_ROOT = 'test-reports/tmp';

/** SPEC § "Tools and permission profiles" — blocked bash patterns, verbatim. */
export const BLOCKED_BASH_PATTERNS: readonly RegExp[] = [
  /git\s+push/,
  /\brm\s+(-\w*\s+)*-\w*[rf]/,
  /git\s+reset\s+--hard/,
  /\bdd\b/,
  /mkfs/,
  /:\s*>\s*/,
];

/** Which tools each profile gets. Reviewer literally has no write/bash/http keys. */
const PROFILE_TOOLS: Record<ToolProfile, readonly string[]> = {
  reviewer: ['read_file', 'glob', 'grep', 'git_diff', 'git_log'],
  tester: [
    'read_file',
    'glob',
    'grep',
    'git_diff',
    'git_log',
    'write_file',
    'edit_file',
    'bash',
    'http_request',
  ],
  designer: [
    'read_file',
    'glob',
    'grep',
    'git_diff',
    'git_log',
    'write_file',
    'edit_file',
    'bash',
    'http_request',
  ],
};

/** Expected, user-facing tool failure. Never escapes execute(): it becomes `{ error }`. */
class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

function truncate(value: string, limit = MAX_OUTPUT): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + TRUNCATED;
}

/** Cap every string reachable from a tool result. */
function capDeep<T>(value: T): T {
  if (typeof value === 'string') return truncate(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => capDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = capDeep(v);
    return out as T;
  }
  return value;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    return `${err.message}${causeMsg}`;
  }
  return String(err);
}

/**
 * Run a tool body. Any throw — expected or not — becomes `{ error: string }`;
 * execute() never rejects, and every returned string is truncated.
 */
async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return capDeep(await fn());
  } catch (err) {
    return { error: truncate(messageOf(err)) };
  }
}

type ExecFailure = Error & {
  code?: number | string;
  killed?: boolean;
  signal?: string;
  stdout?: string;
  stderr?: string;
};

function asExecFailure(err: unknown): ExecFailure {
  return (err ?? new Error('unknown exec failure')) as ExecFailure;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * realpath() the deepest existing ancestor and re-append the missing tail, so
 * not-yet-created files still get symlink-resolved containment checks.
 */
async function realpathOrNearest(target: string): Promise<string> {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await fs.promises.realpath(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve `input` against `repoRoot` and refuse anything outside it — both
 * lexically (`../` escapes, absolute paths) and after symlink resolution.
 */
async function resolveInRepo(
  repoRoot: string,
  input: string,
): Promise<{ abs: string; rel: string }> {
  const given = typeof input === 'string' ? input.trim() : '';
  if (!given) throw new ToolError('path is required');

  const root = path.resolve(repoRoot);
  const outside = () =>
    new ToolError(`path escapes repoRoot: ${input} is outside repoRoot ${root}`);

  const lexical = path.resolve(root, given);
  const lexicalRel = path.relative(root, lexical);
  if (lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel)) throw outside();

  const realRoot = await realpathOrNearest(root);
  const realTarget = await realpathOrNearest(lexical);
  const rel = path.relative(realRoot, realTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw outside();

  return { abs: realTarget, rel: toPosix(rel) };
}

/**
 * glob patterns are matched by fs.glob with `cwd: repoRoot`, which happily walks out of
 * the repo. Refuse absolute patterns and any `..` segment before the iterator runs.
 */
function assertSafeGlobPattern(pattern: string): void {
  const given = typeof pattern === 'string' ? pattern.trim() : '';
  if (!given) throw new ToolError('pattern is required');
  if (path.isAbsolute(given) || /^[A-Za-z]:[\\/]/.test(given)) {
    throw new ToolError(`glob pattern must be relative to repoRoot: ${pattern}`);
  }
  if (given.split(/[\\/]+/).some((segment) => segment === '..')) {
    throw new ToolError(`glob pattern escapes repoRoot: ${pattern}`);
  }
}

/** True when `candidate` (relative to repoRoot) really resolves inside repoRoot. */
async function insideRepo(root: string, candidate: string): Promise<boolean> {
  try {
    await resolveInRepo(root, candidate);
    return true;
  } catch {
    return false;
  }
}

/** SPEC tools table: the tester may only write under `test-reports/tmp/`. */
function assertWritable(profile: ToolProfile, rel: string): void {
  if (profile !== 'tester') return;
  if (rel === TESTER_WRITE_ROOT || rel.startsWith(`${TESTER_WRITE_ROOT}/`)) return;
  throw new ToolError(
    `profile "tester" may only write under ${TESTER_WRITE_ROOT}/ (refused: ${rel || '.'})`,
  );
}

/** Blocked-pattern check for bash. Returns the offending pattern, or null. */
export function blockedBashPattern(command: string): RegExp | null {
  return BLOCKED_BASH_PATTERNS.find((re) => re.test(command)) ?? null;
}

function capPair(stdout: string, stderr: string): { stdout: string; stderr: string } {
  const out = truncate(stdout);
  return { stdout: out, stderr: truncate(stderr, Math.max(0, MAX_OUTPUT - out.length)) };
}

/**
 * Process groups of bash children that are still running, plus the one `exit` hook that
 * reaps them. A detached child does *not* die with the CLI (and, unlike the old in-group
 * child, no longer receives the terminal's Ctrl-C either), so a `process.exit()` mid-command
 * would leak exactly the orphan this whole file is trying to avoid. One shared listener
 * rather than one per call: concurrent tool calls would otherwise trip the max-listeners
 * warning at ten.
 */
const liveBashGroups = new Set<number>();
let bashExitHookInstalled = false;

/** Kill a whole process group; a negative pid is the group (see `detached` below). */
function signalBashGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone. Nothing else can be done from here.
  }
}

function trackBashGroup(pid: number): () => void {
  liveBashGroups.add(pid);
  if (!bashExitHookInstalled) {
    bashExitHookInstalled = true;
    // Nothing can be awaited in an `exit` handler, so there is no chance to escalate from a
    // polite SIGTERM: send the signal that is guaranteed to free the port.
    process.on('exit', () => {
      for (const groupPid of liveBashGroups) signalBashGroup(groupPid, 'SIGKILL');
      liveBashGroups.clear();
    });
  }
  return () => liveBashGroups.delete(pid);
}

interface ShellRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run `command` through a shell in `cwd`, as its own process group.
 *
 * This used to be `exec()`, which leaves the child in the CLI's own process group and, on
 * timeout, signals only the shell it spawned. `npm run dev:api` is a shell that spawns npm
 * that spawns node, so the server survived as an orphan still holding port 3001 and broke
 * every later run — and a group-wide signal from the doomed npm wrapper could reach the CLI
 * itself (one `aw test-feature` exited 143 right after such a timeout).
 *
 * The fix is the one `ensureUp()` in src/util.ts already uses: `detached: true` makes the
 * child a process-group leader, so `kill(-pid)` reaches every descendant.
 *
 * Resolves for any exit, including a non-zero one — that is a result the agent must see.
 * Only a spawn failure (bad cwd, no shell) rejects.
 */
function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; maxChars: number },
): Promise<ShellRun> {
  return new Promise<ShellRun>((resolve, reject) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      detached: true,
      // stdin is /dev/null, so a command that reads it gets EOF instead of hanging forever.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    const out = { stdout: '', stderr: '' };
    const timers: NodeJS.Timeout[] = [];
    let timedOut = false;
    let settled = false;
    let untrack: (() => void) | undefined;

    const pid = child.pid;
    const signalGroup = (signal: NodeJS.Signals): void => {
      if (pid !== undefined) signalBashGroup(pid, signal);
    };
    if (pid !== undefined) untrack = trackBashGroup(pid);

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      untrack?.();
      fn();
    };
    const after = (ms: number, fn: () => void): void => {
      timers.push(setTimeout(fn, ms));
    };

    const collect = (stream: NodeJS.ReadableStream | null, key: 'stdout' | 'stderr'): void => {
      if (!stream) return;
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        // Everything is truncated to MAX_OUTPUT before the agent sees it, so past the cap
        // there is nothing to gain from buffering more — just keep draining the pipe.
        const room = opts.maxChars - out[key].length;
        if (room > 0) out[key] += chunk.length > room ? chunk.slice(0, room) : chunk;
      });
      // A pipe torn down under us must not become an unhandled 'error'.
      stream.on('error', () => {});
    };
    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');

    child.once('error', (err) => settle(() => reject(err)));
    // 'close', not 'exit': the output pipes are only complete once every descendant holding
    // them has let go, which is the same point `exec()` reported at.
    child.once('close', (code, signal) => {
      settle(() => resolve({ exitCode: code, signal, timedOut, ...out }));
    });

    after(opts.timeoutMs, () => {
      timedOut = true;
      signalGroup('SIGTERM');
      // SIGTERM ignored, or swallowed by an npm wrapper: take the port back by force.
      after(BASH_KILL_GRACE_MS, () => signalGroup('SIGKILL'));
      // A descendant that escaped the group (it called setsid itself) can hold the pipes
      // open indefinitely. Stop waiting for 'close' and report what was collected.
      after(BASH_KILL_GRACE_MS + BASH_CLOSE_GRACE_MS, () =>
        settle(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          resolve({ exitCode: null, signal: 'SIGKILL', timedOut: true, ...out });
        }),
      );
    });
  });
}

/** SPEC: localhost/127.0.0.1 are exempt from the destructive-method guard. */
function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

const DESTRUCTIVE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const REPORTED_HEADERS = ['content-type', 'content-length', 'location'];

/**
 * The repositories one agent session may touch (T23).
 *
 * `primary` is the repo the workflow acts IN: relative paths resolve against it, `bash` runs in
 * it, `git_diff`/`git_log` describe it, and it is the ONLY root writes may land in. `readAlso`
 * is the other half of a two-repo product (design-loop reads the backend to learn the API
 * contract): its files are readable — via their absolute paths — and never writable.
 */
export interface ToolRoots {
  primary: string;
  readAlso?: string;
}

/**
 * Build the core (non-browser) tool set for one agent profile.
 *
 * @param profile         SPEC permission profile; decides which keys exist at all.
 * @param roots           the primary repo root, or `{ primary, readAlso }` (T23): write inside
 *                        primary only; read inside either. A bare string means primary only.
 * @param allowDestructive `--allow-destructive`: permits POST/PUT/PATCH/DELETE to non-local hosts.
 */
export function makeCoreTools(
  profile: ToolProfile,
  roots: string | ToolRoots,
  allowDestructive = false,
): ToolSet {
  const root = path.resolve(typeof roots === 'string' ? roots : roots.primary);
  const readAlsoGiven = typeof roots === 'string' ? undefined : roots.readAlso?.trim();
  const readAlsoResolved = readAlsoGiven ? path.resolve(readAlsoGiven) : undefined;
  /** The second READABLE root, when it is a genuinely different directory. */
  const readAlso = readAlsoResolved !== undefined && readAlsoResolved !== root
    ? readAlsoResolved
    : undefined;

  /**
   * Resolve `input` against the READ-ONLY second root, or throw.
   *
   * The path is taken as the PRIMARY would address it (`path.resolve(root, input)` — absolute
   * inputs stay themselves), then symlink-resolved and required to land inside the resolved
   * `readAlso`. No lexical pre-check against `readAlso` on purpose: the two legitimate ways in
   * are the other repo's absolute path and a symlink that points into it, and both are only
   * provable AFTER resolution. Containment still holds — the real location must be inside the
   * real `readAlso` — and nothing here is ever writable.
   */
  const resolveInReadAlso = async (
    input: string,
  ): Promise<{ abs: string; rel: string; cwd: string }> => {
    if (readAlso === undefined) throw new ToolError('no second root is configured');
    const given = typeof input === 'string' ? input.trim() : '';
    if (!given) throw new ToolError('path is required');
    const lexical = path.resolve(root, given);
    const realRoot = await realpathOrNearest(readAlso);
    const realTarget = await realpathOrNearest(lexical);
    const rel = path.relative(realRoot, realTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ToolError(`path escapes repoRoot: ${input} is outside ${readAlso}`);
    }
    return { abs: realTarget, rel: toPosix(rel), cwd: readAlso };
  };

  /**
   * Resolve a path for READING: the primary root first, then `readAlso`.
   * The returned `cwd` is the root the path resolved under — grep runs there.
   */
  const resolveForRead = async (
    input: string,
  ): Promise<{ abs: string; rel: string; cwd: string }> => {
    try {
      const resolved = await resolveInRepo(root, input);
      return { ...resolved, cwd: root };
    } catch (primaryErr) {
      if (readAlso === undefined) throw primaryErr;
      try {
        return await resolveInReadAlso(input);
      } catch {
        throw new ToolError(
          `path escapes repoRoot: ${input} is outside the writable repoRoot ${root} and the read-only root ${readAlso}`,
        );
      }
    }
  };

  /**
   * Resolve a path for WRITING: the primary root ONLY. A path that lands in `readAlso` gets its
   * own message naming which root is writable (T23 § tool containment), because "outside the
   * repo" would send the agent looking for a typo instead of telling it the rule.
   */
  const resolveForWrite = async (input: string): Promise<{ abs: string; rel: string }> => {
    try {
      return await resolveInRepo(root, input);
    } catch (primaryErr) {
      if (readAlso !== undefined) {
        let landsInReadAlso = false;
        try {
          await resolveInReadAlso(input);
          landsInReadAlso = true;
        } catch {
          landsInReadAlso = false;
        }
        if (landsInReadAlso) {
          throw new ToolError(
            `read-only root: ${input} is inside ${readAlso}, which this session may READ but not ` +
              `write — the only writable root is ${root}`,
          );
        }
      }
      throw primaryErr;
    }
  };

  /** Appended to read-tool descriptions so the model knows the second root exists. */
  const readAlsoNote = readAlso === undefined
    ? ''
    : ` Files under ${readAlso} may also be READ via their absolute paths (that repo is read-only).`;

  const all: ToolSet = {
    read_file: tool({
      description:
        'Read a UTF-8 text file inside the repo and return it as numbered lines. ' +
        'Optional 1-based `offset` and `limit` select a line window.' + readAlsoNote,
      inputSchema: z.object({
        path: z.string().describe('file path, relative to the repo root'),
        offset: z.number().int().min(1).optional().describe('first line to return (1-based)'),
        limit: z.number().int().min(1).optional().describe('max number of lines (default 2000)'),
      }),
      execute: async ({ path: filePath, offset, limit }) =>
        guarded(async () => {
          const { abs, rel } = await resolveForRead(filePath);
          const stat = await fs.promises.stat(abs);
          if (stat.isDirectory()) throw new ToolError(`not a file (it is a directory): ${rel}`);
          if (stat.size > MAX_READ_BYTES) {
            throw new ToolError(`file too large to read: ${rel} (${stat.size} bytes)`);
          }
          const lines = (await fs.promises.readFile(abs, 'utf8')).split('\n');
          const start = offset ?? 1;
          const count = limit ?? 2000;
          const window = lines.slice(start - 1, start - 1 + count);
          const width = String(start + Math.max(window.length - 1, 0)).length;
          const numbered = window
            .map((line, i) => `${String(start + i).padStart(width, ' ')}\t${line}`)
            .join('\n');
          return {
            path: rel,
            totalLines: lines.length,
            startLine: start,
            endLine: start + Math.max(window.length - 1, 0),
            content: numbered,
          };
        }),
    }),

    glob: tool({
      description:
        'List repo files matching a glob pattern (e.g. "src/**/*.ts"). node_modules and .git are skipped.',
      inputSchema: z.object({
        pattern: z.string().describe('glob pattern, relative to the repo root'),
      }),
      execute: async ({ pattern }) =>
        guarded(async () => {
          assertSafeGlobPattern(pattern);
          const files: string[] = [];
          const limit = 500;
          let truncatedList = false;
          const iterator = fs.promises.glob(pattern, {
            cwd: root,
            exclude: (entry: unknown) => {
              const name =
                typeof entry === 'string'
                  ? path.basename(entry)
                  : String((entry as { name?: string }).name ?? '');
              return name === 'node_modules' || name === '.git';
            },
          });
          for await (const match of iterator) {
            if (files.length >= limit) {
              truncatedList = true;
              break;
            }
            const rel = toPosix(String(match));
            // Second line of defence: a symlinked directory inside the repo can still
            // point outside it, so re-check every match after symlink resolution.
            if (!(await insideRepo(root, rel))) continue;
            files.push(rel);
          }
          files.sort();
          return { pattern, count: files.length, truncated: truncatedList, files };
        }),
    }),

    grep: tool({
      description:
        'Recursive grep over the repo (binary files, node_modules and .git skipped). No match is not an error.' +
        readAlsoNote,
      inputSchema: z.object({
        pattern: z.string().describe('basic-regex pattern passed to grep'),
        path: z.string().optional().describe('file or directory to search (default: whole repo)'),
      }),
      execute: async ({ pattern, path: target }) =>
        guarded(async () => {
          const where = target ? await resolveForRead(target) : { rel: '.', cwd: root };
          const resolved = where.rel || '.';
          const args = [
            '-rn',
            '-I',
            '--exclude-dir=node_modules',
            '--exclude-dir=.git',
            // `--` ends option parsing: without it a pattern like "-->" or "-l" is
            // consumed by grep as a flag (error, or silently wrong results).
            '--',
            pattern,
            resolved,
          ];
          try {
            const { stdout } = await execFileAsync('grep', args, {
              cwd: where.cwd,
              maxBuffer: EXEC_MAX_BUFFER,
            });
            return { pattern, path: resolved, matches: truncate(stdout) };
          } catch (err) {
            const failure = asExecFailure(err);
            // grep exit code 1 = "no lines selected", which is a normal result.
            if (failure.code === 1) return { pattern, path: resolved, matches: '' };
            throw new ToolError(`grep failed: ${failure.stderr?.trim() || messageOf(failure)}`);
          }
        }),
    }),

    git_diff: tool({
      description:
        'Show the working-tree diff (`git diff HEAD`), or `git diff <base>...HEAD` when `base` is given.',
      inputSchema: z.object({
        base: z.string().optional().describe('base ref, e.g. "main"'),
      }),
      execute: async ({ base }) =>
        guarded(async () => {
          const args = base ? ['diff', `${base}...HEAD`] : ['diff', 'HEAD'];
          try {
            const { stdout } = await execFileAsync('git', args, {
              cwd: root,
              maxBuffer: EXEC_MAX_BUFFER,
            });
            return { base: base ?? 'HEAD', diff: truncate(stdout) };
          } catch (err) {
            const failure = asExecFailure(err);
            throw new ToolError(`git diff failed: ${failure.stderr?.trim() || messageOf(failure)}`);
          }
        }),
    }),

    git_log: tool({
      description: 'Recent commits, one line each (`git log --oneline -n <limit>`).',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).optional().describe('number of commits (default 20)'),
      }),
      execute: async ({ limit }) =>
        guarded(async () => {
          const n = limit ?? 20;
          try {
            const { stdout } = await execFileAsync('git', ['log', '--oneline', '-n', String(n)], {
              cwd: root,
              maxBuffer: EXEC_MAX_BUFFER,
            });
            return { limit: n, log: truncate(stdout) };
          } catch (err) {
            const failure = asExecFailure(err);
            throw new ToolError(`git log failed: ${failure.stderr?.trim() || messageOf(failure)}`);
          }
        }),
    }),

    write_file: tool({
      description:
        (profile === 'tester'
          ? `Write a UTF-8 file. The qa-tester profile may only write under ${TESTER_WRITE_ROOT}/.`
          : 'Write a UTF-8 file inside the repo, creating parent directories as needed.') +
        (readAlso === undefined ? '' : ` The repo at ${readAlso} is READ-ONLY — never write there.`),
      inputSchema: z.object({
        path: z.string().describe('file path, relative to the repo root'),
        content: z.string().describe('full file contents'),
      }),
      execute: async ({ path: filePath, content }) =>
        guarded(async () => {
          const { abs, rel } = await resolveForWrite(filePath);
          assertWritable(profile, rel);
          await fs.promises.mkdir(path.dirname(abs), { recursive: true });
          await fs.promises.writeFile(abs, content, 'utf8');
          return { path: rel, bytes: Buffer.byteLength(content, 'utf8'), written: true };
        }),
    }),

    edit_file: tool({
      description:
        'Replace one exact, unique occurrence of `old` with `new` in a file. ' +
        'Fails when `old` occurs zero times or more than once.',
      inputSchema: z.object({
        path: z.string().describe('file path, relative to the repo root'),
        old: z.string().describe('exact text to replace; must occur exactly once'),
        new: z.string().describe('replacement text'),
      }),
      execute: async ({ path: filePath, old, new: replacement }) =>
        guarded(async () => {
          const { abs, rel } = await resolveForWrite(filePath);
          assertWritable(profile, rel);
          if (old === '') throw new ToolError(`edit_file: "old" must not be empty (${rel})`);
          const before = await fs.promises.readFile(abs, 'utf8');
          const matches = before.split(old).length - 1;
          if (matches === 0) throw new ToolError(`no match for "old" in ${rel}`);
          if (matches > 1) {
            throw new ToolError(
              `"old" is not unique in ${rel}: ${matches} matches — add surrounding context`,
            );
          }
          // Splice by index: String.replace would reinterpret `$$`, `$&`, "$`" and `$'`
          // in `replacement` as substitution patterns and silently corrupt the file.
          const at = before.indexOf(old);
          const after = before.slice(0, at) + replacement + before.slice(at + old.length);
          await fs.promises.writeFile(abs, after, 'utf8');
          return { path: rel, replaced: 1, bytes: Buffer.byteLength(after, 'utf8') };
        }),
    }),

    bash: tool({
      description:
        'Run a shell command in the repo root. Guardrail patterns (git push, rm -rf, git reset --hard, dd, mkfs, truncation redirects) are rejected.',
      inputSchema: z.object({
        command: z.string().describe('shell command'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(MAX_BASH_TIMEOUT_MS)
          .optional()
          .describe(`timeout in ms (default ${DEFAULT_BASH_TIMEOUT_MS})`),
      }),
      execute: async ({ command, timeoutMs }) =>
        guarded(async () => {
          const blocked = blockedBashPattern(command);
          if (blocked) throw new ToolError(`blocked by guardrails: ${String(blocked)}`);
          const timeout = Math.min(timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
          let run: ShellRun;
          try {
            run = await runShell(command, {
              cwd: root,
              timeoutMs: timeout,
              maxChars: EXEC_MAX_BUFFER,
            });
          } catch (err) {
            // Only a spawn failure reaches here; every exit is a resolve.
            throw new ToolError(`bash failed: ${messageOf(err)}`);
          }
          // A non-zero exit is a result the agent must see, not a tool error.
          const capped = capPair(run.stdout, run.stderr);
          if (run.timedOut) return { command, exitCode: null, timedOut: true, ...capped };
          if (run.exitCode !== null) return { command, exitCode: run.exitCode, ...capped };
          throw new ToolError(`bash failed: terminated by signal ${run.signal ?? 'unknown'}`);
        }),
    }),

    http_request: tool({
      description:
        'HTTP request against the app under test. Destructive methods (POST/PUT/PATCH/DELETE) ' +
        'to non-local hosts require --allow-destructive.',
      inputSchema: z.object({
        method: z.enum(HTTP_METHODS).describe('HTTP method'),
        url: z.string().describe('absolute URL'),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional().describe('request body (string; JSON must be stringified)'),
      }),
      execute: async ({ method, url, headers, body }) =>
        guarded(async () => {
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            throw new ToolError(`invalid url: ${url}`);
          }
          const verb = method.toUpperCase();
          if (
            DESTRUCTIVE_METHODS.has(verb) &&
            !isLocalHost(parsed.hostname) &&
            !allowDestructive
          ) {
            throw new ToolError('destructive call to non-local target requires --allow-destructive');
          }
          const response = await fetch(parsed, {
            method: verb,
            headers,
            body: verb === 'GET' || verb === 'HEAD' ? undefined : body,
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          });
          const selected: Record<string, string> = {};
          for (const name of REPORTED_HEADERS) {
            const value = response.headers.get(name);
            if (value !== null) selected[name] = value;
          }
          const text = await response.text();
          return {
            status: response.status,
            statusText: response.statusText,
            url: parsed.toString(),
            headers: selected,
            body: truncate(text, MAX_HTTP_BODY),
          };
        }),
    }),
  };

  const allowed = PROFILE_TOOLS[profile];
  if (!allowed) throw new Error(`unknown tool profile "${profile}"`);
  const picked: ToolSet = {};
  for (const name of allowed) picked[name] = all[name];
  return picked;
}
