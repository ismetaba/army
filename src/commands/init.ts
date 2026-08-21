/**
 * T13 — `aw init`: point the toolkit at any target repo in one command.
 *
 * Everything this command touches already belongs to somebody else: the target repo's
 * `aw.config.json`, its `CLAUDE.md`, its `.gitignore`, its `.claude/` layer, and the shared
 * `$AW_HOME/workspaces.json`. So the rule throughout is *merge, never clobber*:
 *
 * - `aw.config.json` — a hand-written config is kept; only missing keys are added (and keys
 *   this schema does not know about survive, because the merged raw JSON is what gets written,
 *   not the zod-parsed copy, which would strip them).
 * - `CLAUDE.md` — only the text between `<!-- aw:start -->` and `<!-- aw:end -->` is ours.
 *   Anything outside it is copied through byte for byte, and a malformed marker pair aborts the
 *   whole run instead of guessing where the block ends.
 * - `.gitignore` — missing lines are appended, existing ones are matched loosely enough that
 *   `/screenshots` does not become a second `screenshots/`.
 * - `.claude/*` — an existing same-named file is never overwritten; it is reported as
 *   `kept existing: <path>`.
 *
 * The run is planned in full before a single byte is written (see `planInit`/`applyPlan`), so a
 * failure in step 4 cannot leave step 1 half-applied.
 *
 * A password is never asked for, never printed and never written: only the NAME of the env var
 * that holds it (`app.testAccount.passEnv`) ever reaches disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { z } from 'zod';
import { AwConfig, ProviderId, Workspace, WorkspacesFile } from '../../shared/schemas';
import { loadGuardrails } from '../agents';
import { awHome } from '../util';
import { fail, write } from '../workflows/common';

type WorkspaceEntry = z.infer<typeof Workspace>;

/** Thrown for user-facing problems. Callers print `.message` and exit 1 — never a stack. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** Root of THIS repo (the agent-workflows checkout) — the source of the `.claude/` layer. */
export const AW_REPO_ROOT = path.join(here, '..', '..');

/** Markers delimiting the block `aw init` owns inside the target's `CLAUDE.md`. */
export const AW_START = '<!-- aw:start -->';
export const AW_END = '<!-- aw:end -->';

/** Lines the target's `.gitignore` must contain (T13 step 2.5). */
export const GITIGNORE_LINES: readonly string[] = ['screenshots/', 'test-reports/', '.env'];

const DEFAULT_PROVIDER: ProviderId = 'lmstudio';
/** Only a placeholder: the real id is whatever LM Studio shows (SPEC § aw.config.example.json). */
const DEFAULT_MODEL = 'qwen3-30b-a3b';
const DEFAULT_BACKEND_PORT = 3001;
const DEFAULT_FRONTEND_PORT = 3000;
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_PASS_ENV = 'AW_TEST_PASSWORD';

/** Progress/notes go to stderr so the summary on stdout stays parseable. */
function note(line: string): void {
  write(2, line);
}

function out(line: string): void {
  write(1, line);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('\n');
}

function readFileOrUndefined(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return undefined;
    // `AW_HOME=/some/file` fails here as a bare ENOTDIR that never names AW_HOME as the cause.
    if ((e.code === 'ENOTDIR' || e.code === 'EISDIR') && path.dirname(file) === awHome()) {
      throw new InitError(
        `AW_HOME must be a directory, but ${awHome()} is not one — ${file} is unreadable (${e.message}).\n` +
          '  Point AW_HOME at a directory (or unset it to use ~/.agent-workflows). Nothing was written.',
      );
    }
    throw new InitError(`cannot read ${file} (${e.message})`);
  }
}

/** Quote a path for the copy-pasteable "next" line — this repo's own path contains a space. */
function shellQuote(value: string): string {
  return /[\s"'\\$`]/.test(value) ? `"${value.replace(/(["\\$`])/g, '\\$1')}"` : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Do two paths name the same directory? `path.resolve` first (deviation 14: recorded paths are
 * resolved, not realpath'd), then `realpath` as a fallback so `/tmp/x` and `/private/tmp/x` are
 * not reported as a mismatch on macOS.
 */
export function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Why `target` cannot be written, or `undefined` when it can.
 *
 * Walks up to the nearest path component that exists, so it catches both a read-only file and an
 * ancestor that is a regular file (`.claude` as a file makes `mkdir .claude/agents` ENOTDIR).
 * This runs during planning: a write that is going to fail must fail before any other write has
 * happened, not halfway through the run.
 */
export function writabilityProblem(target: string): string | undefined {
  const resolved = path.resolve(target);
  let current = resolved;
  for (;;) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return `${current}: ${(err as Error).message}`;
      }
      const parent = path.dirname(current);
      if (parent === current) return `${resolved}: no existing parent directory`;
      current = parent;
      continue;
    }
    if (current !== resolved) {
      if (!stat.isDirectory()) {
        // The target is deliberately left out: six planned files behind one bad `.claude` are
        // one problem, and naming the blocker alone lets `checkWritable` collapse them.
        return `${current} is a file, but this run needs it to be a directory`;
      }
    } else if (stat.isDirectory()) {
      return `${resolved} is a directory, but a file must be written there`;
    }
    try {
      fs.accessSync(current, fs.constants.W_OK);
    } catch {
      return `${current} is not writable (check its permissions)`;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// aw.config.json — keep what is there, add what is missing
// ---------------------------------------------------------------------------

/**
 * Deep-merge `generated` into `existing` with **existing winning every conflict**: only keys
 * absent from `existing` are added, and the dotted path of each addition is collected.
 *
 * Recursion stops as soon as either side is not a plain object, so an existing scalar, array or
 * `null` is never rewritten into an object — a hand-written config keeps the shape its author
 * gave it, even where that shape is wrong (zod reports it afterwards; init does not "fix" it).
 */
export function addMissingKeys(
  existing: unknown,
  generated: unknown,
  prefix = '',
  added: string[] = [],
): { value: unknown; added: string[] } {
  if (!isPlainObject(existing) || !isPlainObject(generated)) return { value: existing, added };
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(generated)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (!(key in merged)) {
      merged[key] = value;
      added.push(dotted);
      continue;
    }
    merged[key] = addMissingKeys(merged[key], value, dotted, added).value;
  }
  return { value: merged, added };
}

/** Flatten to `dotted.path -> JSON scalar`, for the diff-style summary. */
function flatten(
  value: unknown,
  prefix = '',
  acc: Map<string, string> = new Map(),
): Map<string, string> {
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, acc);
    }
  } else {
    acc.set(prefix, JSON.stringify(value));
  }
  return acc;
}

/** `+ added`, `~ changed`, `- only in the existing file` — shown before asking to overwrite. */
export function diffSummary(existing: unknown, generated: unknown): string[] {
  const before = flatten(existing);
  const after = flatten(generated);
  const lines: string[] = [];
  for (const [key, value] of after) {
    if (!before.has(key)) lines.push(`  + ${key} = ${value}`);
    else if (before.get(key) !== value) lines.push(`  ~ ${key} = ${before.get(key)} → ${value}`);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) lines.push(`  - ${key} (only in the existing file — kept either way)`);
  }
  return lines.length ? lines : ['  (no differences)'];
}

// ---------------------------------------------------------------------------
// CLAUDE.md — replace our block, never touch anything else
// ---------------------------------------------------------------------------

function occurrences(text: string, marker: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + marker.length)) {
    found.push(i);
  }
  return found;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export type ClaudeMdAction = 'created' | 'appended' | 'replaced';

/**
 * Merge `block` (a full `<!-- aw:start -->…<!-- aw:end -->` chunk) into `existing`.
 *
 * Exactly three shapes are accepted: no file at all, a file with neither marker, and a file with
 * exactly one well-ordered marker pair. Anything else — an unclosed start, an orphan end, a
 * second pair — throws, because every other reading of a broken pair means guessing which text
 * is the developer's and which is ours, and a wrong guess silently deletes their notes.
 *
 * Whitespace around the block is preserved verbatim on replace, which is what makes a second
 * `aw init` byte-identical to the first.
 */
export function mergeClaudeMd(
  existing: string | undefined,
  block: string,
  header = '',
): { content: string; action: ClaudeMdAction } {
  const body = block.trim();
  if (existing === undefined) {
    return { content: `${header}${body}\n`, action: 'created' };
  }
  const starts = occurrences(existing, AW_START);
  const ends = occurrences(existing, AW_END);

  if (starts.length === 0 && ends.length === 0) {
    const base = existing.replace(/\s*$/, '');
    return { content: base ? `${base}\n\n${body}\n` : `${body}\n`, action: 'appended' };
  }

  const problem = describeMarkerProblem(existing, starts, ends);
  if (problem) {
    throw new InitError(
      `CLAUDE.md has a malformed agent-workflows block: ${problem}\n` +
        `  Repair or delete the "${AW_START}" / "${AW_END}" pair by hand, then run init again.\n` +
        '  Nothing was written.',
    );
  }

  return {
    content: existing.slice(0, starts[0]) + body + existing.slice(ends[0] + AW_END.length),
    action: 'replaced',
  };
}

function describeMarkerProblem(
  text: string,
  starts: readonly number[],
  ends: readonly number[],
): string | undefined {
  if (starts.length === 0) {
    return `"${AW_END}" on line ${lineOf(text, ends[0])} has no matching "${AW_START}"`;
  }
  if (ends.length === 0) {
    return `"${AW_START}" on line ${lineOf(text, starts[0])} is never closed by "${AW_END}"`;
  }
  if (starts.length > 1 || ends.length > 1) {
    return `${starts.length} "${AW_START}" and ${ends.length} "${AW_END}" markers (expected one of each)`;
  }
  if (ends[0] < starts[0]) {
    return `"${AW_END}" (line ${lineOf(text, ends[0])}) comes before "${AW_START}" (line ${lineOf(text, starts[0])})`;
  }
  return undefined;
}

export interface ClaudeBlockInput {
  workspace: string;
  awRepoRoot: string;
  /** Where runs are stored; defaults to `awHome()`, which honours `$AW_HOME`. */
  awHome?: string;
  /** Name of the env var holding the test-account password — never the password itself. */
  passEnv?: string;
}

/** The block `aw init` owns in the target's `CLAUDE.md`. Deterministic: no dates, no counters. */
export function renderClaudeBlock(input: ClaudeBlockInput): string {
  const cli = `npx tsx ${shellQuote(path.join(input.awRepoRoot, 'src/cli.ts'))}`;
  const lines = [
    AW_START,
    '## Agent workflows (aw)',
    '',
    `This repo is the \`${input.workspace}\` workspace of agent-workflows`,
    `(\`${input.awRepoRoot}\` — that checkout path is local to whoever ran \`aw init\`).`,
    `Settings: \`aw.config.json\`. Runs are stored under`,
    `\`${path.join(input.awHome ?? awHome(), input.workspace, 'runs')}/\`.`,
    '',
    '### Commands',
    '',
    'From the agent-workflows checkout:',
    '',
    `- \`${cli} review --workspace ${input.workspace} --base main\` — strict senior review of the branch diff (exit 2 on a BLOCKER)`,
    `- \`${cli} test-feature "<description>" --workspace ${input.workspace}\` — black-box test, writes a report`,
    `- \`${cli} design-loop "<feature>" --workspace ${input.workspace}\` — implement UI, verify it in a browser, stop for feedback`,
    '',
    'In a Claude Code session started in THIS repo: `/review [base]`, `/test-feature <description>`,',
    '`/design-loop <feature>` — the commands and subagents in `.claude/` were copied here by `aw init`.',
    '',
    '### Artifacts and conventions',
    '',
    '- Screenshots: `screenshots/<feature-slug>/<screen>-<viewport>.png`',
    '- Test reports: `test-reports/<slug>-<YYYY-MM-DD>.md`',
    '- Both directories are gitignored: present the paths for review, never commit the files.',
    ...(input.passEnv
      ? [
          `- Test-account password: read from \`$${input.passEnv}\`. It is never stored in this repo,`,
          '  never printed, and never committed.',
        ]
      : []),
    '',
    '### Guardrails',
    '',
    loadGuardrails().trim(),
    AW_END,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// .gitignore — append what is missing, byte-preserve the rest
// ---------------------------------------------------------------------------

/**
 * Loose equality for ignore patterns: leading `/` and a trailing `/` are stripped, so an
 * existing `/screenshots` or `screenshots/` both count as present. A negation (`!screenshots/`)
 * deliberately does NOT match — it means the opposite of the line being requested.
 */
function normalizeIgnore(line: string): string {
  return line.trim().replace(/^\//, '').replace(/\/$/, '');
}

/** Append the missing lines; return the existing content untouched when nothing is missing. */
export function mergeGitignore(
  existing: string | undefined,
  needed: readonly string[] = GITIGNORE_LINES,
): { content: string; added: string[] } {
  const present = new Set(
    (existing ?? '')
      .split(/\r?\n/)
      .map(normalizeIgnore)
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  const added = needed.filter((line) => !present.has(normalizeIgnore(line)));
  if (added.length === 0) return { content: existing ?? '', added };
  // `replace(/\n*$/, '\n')` fixes a missing final newline without touching any other byte.
  const base = existing === undefined || existing.trim() === '' ? '' : existing.replace(/\n*$/, '\n');
  return { content: `${base}${added.join('\n')}\n`, added };
}

// ---------------------------------------------------------------------------
// workspaces.json — replace the same-name entry, keep every other one
// ---------------------------------------------------------------------------

export interface WorkspaceUpsert {
  file: z.infer<typeof WorkspacesFile>;
  replaced: boolean;
  /** Set when the file on disk was unusable and had to be rebuilt; worth a `warning:` line. */
  recovered?: string;
}

/**
 * Register `entry`, tolerating a missing file, invalid JSON, or a file whose shape drifted.
 *
 * A corrupt registry must not stop `init` (it is a cache of pointers, not the user's data), but
 * it must not silently lose the other workspaces either: individually valid entries are salvaged
 * out of a partially broken file, and the caller backs the original up before overwriting.
 *
 * `createdAt` of an existing same-name entry is kept — re-running init re-points a workspace, it
 * does not re-create it, and preserving the timestamp is what makes the rewrite byte-identical.
 */
export function upsertWorkspace(raw: string | undefined, entry: WorkspaceEntry): WorkspaceUpsert {
  let workspaces: WorkspaceEntry[] = [];
  let recovered: string | undefined;

  if (raw !== undefined && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err) {
      recovered = `not valid JSON (${(err as Error).message})`;
    }
    if (recovered === undefined) {
      const strict = WorkspacesFile.safeParse(parsed);
      if (strict.success) {
        workspaces = strict.data.workspaces;
      } else if (isPlainObject(parsed) && Array.isArray(parsed.workspaces)) {
        const kept = parsed.workspaces
          .map((w) => Workspace.safeParse(w))
          .filter((r) => r.success)
          .map((r) => r.data);
        const dropped = parsed.workspaces.length - kept.length;
        workspaces = kept;
        recovered = `dropped ${dropped} unreadable entr${dropped === 1 ? 'y' : 'ies'}`;
      } else {
        recovered = 'unrecognised shape (expected { "workspaces": [...] })';
      }
    }
  }

  const index = workspaces.findIndex((w) => w.name === entry.name);
  const replaced = index !== -1;
  const merged = replaced ? { ...entry, createdAt: workspaces[index].createdAt } : entry;
  const next = replaced
    ? workspaces.map((w, i) => (i === index ? merged : w))
    : [...workspaces, merged];
  return { file: { workspaces: next }, replaced, recovered };
}

// ---------------------------------------------------------------------------
// prompting — never blocks, by construction
// ---------------------------------------------------------------------------

/**
 * Asks questions only when it is genuinely interactive. `--yes` and a non-TTY stdin both flip
 * `enabled` off, and no readline interface is created at all in that case — so `init --yes`
 * under `< /dev/null` cannot block on a read that will never be answered.
 */
class Prompter {
  private rl?: Interface;

  constructor(private readonly enabled: boolean) {}

  async ask(question: string, fallback: string): Promise<string> {
    if (!this.enabled) return fallback;
    this.rl ??= createInterface({ input: process.stdin, output: process.stderr });
    const answer = await this.rl.question(`${question} [${fallback}]: `);
    return answer.trim() || fallback;
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    if (!this.enabled) return fallback;
    const answer = await this.ask(`${question} (y/n)`, fallback ? 'y' : 'n');
    return /^y(es)?$/i.test(answer.trim());
  }

  close(): void {
    this.rl?.close();
  }
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

export interface InitFlags {
  repo?: string;
  name?: string;
  backendStart?: string;
  backendPort?: string;
  healthPath?: string;
  frontendStart?: string;
  frontendPort?: string;
  baseUrl?: string;
  testUser?: string;
  passEnv?: string;
  stagingUrl?: string;
  provider?: string;
  model?: string;
  yes?: boolean;
}

type Status = 'created' | 'updated' | 'unchanged' | 'kept existing';

interface PlannedWrite {
  file: string;
  content: string;
}

interface PlannedCopy {
  src: string;
  dest: string;
}

interface Plan {
  repoRoot: string;
  workspace: string;
  writes: PlannedWrite[];
  copies: PlannedCopy[];
  registryPath: string;
  registryEntry: WorkspaceEntry;
  registryContent: string;
  configAdded: string[];
  /** The stale `repoRoot` an existing config carried, when it had to be corrected. */
  repoRootFixed?: string;
  gitignoreAdded: string[];
  claudeMdAction: ClaudeMdAction;
  passEnv?: string;
}

function flag(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePort(raw: string | undefined, label: string, fallback: number): number {
  const value = flag(raw);
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InitError(`${label}: "${value}" is not a valid port (1–65535)`);
  }
  return port;
}

/** A workspace name becomes a directory under `$AW_HOME` — keep it a single safe segment. */
function checkWorkspaceName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '.' || name === '..') {
    throw new InitError(
      `invalid workspace name "${name}" — use letters, digits, ".", "-" or "_" (it becomes a directory under ${awHome()})`,
    );
  }
  return name;
}

/** The env var NAME, never a value. A string that does not look like an identifier is a smell. */
function checkPassEnv(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new InitError(
      `invalid --pass-env "${value}": pass the NAME of the environment variable holding the password ` +
        '(e.g. AW_TEST_PASSWORD), never the password itself.',
    );
  }
  return value;
}

/**
 * The six files of this repo's generated `.claude/` layer, paired with where they go in the
 * target. Sorted and fixed in order so two inits print the same summary.
 */
function planClaudeCopies(repoRoot: string): PlannedCopy[] {
  const copies: PlannedCopy[] = [];
  for (const sub of ['agents', 'commands']) {
    const dir = path.join(AW_REPO_ROOT, '.claude', sub);
    let entries: string[];
    try {
      entries = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch {
      throw new InitError(
        `${dir} is missing — run \`npm run sync-claude\` in ${AW_REPO_ROOT} first, then init again.`,
      );
    }
    if (entries.length === 0) {
      throw new InitError(
        `${dir} contains no .md files — run \`npm run sync-claude\` in ${AW_REPO_ROOT} first.`,
      );
    }
    for (const entry of entries) {
      copies.push({
        src: path.join(dir, entry),
        dest: path.join(repoRoot, '.claude', sub, entry),
      });
    }
  }
  return copies;
}

/**
 * Ask/derive everything, read every file that matters, and produce the complete set of writes.
 * Nothing on disk changes here — a failure at any point leaves the target repo exactly as found.
 */
async function planInit(flags: InitFlags, prompter: Prompter): Promise<Plan> {
  const repoInput = flag(flags.repo) ?? (await prompter.ask('target repo path', process.cwd()));
  const repoRoot = path.resolve(repoInput);
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new InitError(`not a git repository: ${repoRoot} (no .git found)`);
  }

  const requestedName = checkWorkspaceName(
    flag(flags.name) ?? (await prompter.ask('workspace name', path.basename(repoRoot))),
  );

  const providerRaw = flag(flags.provider) ?? (await prompter.ask('provider', DEFAULT_PROVIDER));
  const provider = ProviderId.safeParse(providerRaw);
  if (!provider.success) {
    throw new InitError(
      `unknown provider "${providerRaw}" (expected one of: ${ProviderId.options.join(', ')})`,
    );
  }
  const modelFlag = flag(flags.model);
  const model = modelFlag ?? (await prompter.ask('model id', DEFAULT_MODEL));
  // The "no --model" warning is NOT emitted here: an existing config usually wins the merge, and
  // warning before that merge announces a value that was never written. See below, after zod.

  const backendStart =
    flag(flags.backendStart) ??
    flag(await prompter.ask('backend start command (empty = none)', ''));
  if (!backendStart && flag(flags.backendPort)) {
    throw new InitError('--backend-port needs --backend-start (a port alone cannot start an app)');
  }
  const backendPort = backendStart
    ? parsePort(
        flag(flags.backendPort) ??
          (await prompter.ask('backend port', String(DEFAULT_BACKEND_PORT))),
        '--backend-port',
        DEFAULT_BACKEND_PORT,
      )
    : undefined;
  const healthPath = backendStart
    ? (flag(flags.healthPath) ?? (await prompter.ask('backend health path', DEFAULT_HEALTH_PATH)))
    : undefined;

  const frontendStart =
    flag(flags.frontendStart) ??
    flag(await prompter.ask('frontend start command (empty = none)', ''));
  if (!frontendStart && flag(flags.frontendPort)) {
    throw new InitError('--frontend-port needs --frontend-start');
  }
  const frontendPort = frontendStart
    ? parsePort(
        flag(flags.frontendPort) ??
          (await prompter.ask('frontend port', String(DEFAULT_FRONTEND_PORT))),
        '--frontend-port',
        DEFAULT_FRONTEND_PORT,
      )
    : undefined;

  const baseUrlDefault = backendPort ? `http://localhost:${backendPort}` : '';
  const baseUrl = flag(flags.baseUrl) ?? flag(await prompter.ask('base URL', baseUrlDefault));

  const testUser = flag(flags.testUser) ?? flag(await prompter.ask('test account user (empty = none)', ''));
  // The password is NOT asked for here, and there is no flag that could carry one.
  const passEnv = testUser
    ? checkPassEnv(
        flag(flags.passEnv) ??
          (await prompter.ask('env var holding its password (name only)', DEFAULT_PASS_ENV)),
      )
    : undefined;

  const stagingUrl =
    flag(flags.stagingUrl) ?? flag(await prompter.ask('staging URL (empty = none)', ''));

  const app: Record<string, unknown> = {};
  if (backendStart) {
    app.backend = { start: backendStart, port: backendPort, healthPath };
  }
  if (frontendStart) app.frontend = { start: frontendStart, port: frontendPort };
  if (baseUrl) app.baseUrl = baseUrl;
  if (testUser && passEnv) app.testAccount = { user: testUser, passEnv };
  if (stagingUrl) app.stagingUrl = stagingUrl;

  // Key order mirrors SPEC § aw.config.example.json.
  const generated: Record<string, unknown> = {
    workspace: requestedName,
    repoRoot,
    defaults: { provider: provider.data, model },
    ...(Object.keys(app).length > 0 ? { app } : {}),
    viewports: {
      mobile: { width: 375, height: 812 },
      desktop: { width: 1440, height: 900 },
    },
  };

  // --- aw.config.json -------------------------------------------------------
  const configPath = path.join(repoRoot, 'aw.config.json');
  const existingConfigRaw = readFileOrUndefined(configPath);
  let toWrite: unknown = generated;
  let configAdded: string[] = [];

  if (existingConfigRaw !== undefined) {
    let existingConfig: unknown;
    try {
      existingConfig = JSON.parse(existingConfigRaw) as unknown;
    } catch (err) {
      throw new InitError(
        `${configPath} is not valid JSON: ${(err as Error).message}\n` +
          '  Fix or delete it and run init again. Nothing was written.',
      );
    }
    note(`aw.config.json already exists: ${configPath}`);
    for (const line of diffSummary(existingConfig, generated)) note(line);
    const overwrite = await prompter.confirm(
      'overwrite it with the values above? (n = keep it and only add missing keys)',
      false,
    );
    if (overwrite) {
      toWrite = generated;
      configAdded = ['(overwritten)'];
    } else {
      const merged = addMissingKeys(existingConfig, generated);
      toWrite = merged.value;
      configAdded = merged.added;
    }
  }

  // `repoRoot` is derived from the invocation, not authored by the developer: it is an absolute,
  // machine-specific path inside a file that gets committed, so any clone, move or second machine
  // arrives here with a value that points somewhere else. Letting the file win that conflict (as
  // every other key does) registers the workspace against a repo that was not the one inited —
  // `review --workspace <ws>` then reviews the wrong tree, or fails with "config not found".
  let repoRootFixed: string | undefined;
  if (isPlainObject(toWrite)) {
    const declared = toWrite.repoRoot;
    if (typeof declared === 'string' && !samePath(declared, repoRoot)) {
      repoRootFixed = declared;
      toWrite = { ...toWrite, repoRoot };
      note(`note: ${configPath} repoRoot pointed at ${declared} — updated to ${repoRoot}`);
    }
  }

  const validated = AwConfig.safeParse(toWrite);
  if (!validated.success) {
    throw new InitError(
      `the resulting config is invalid: ${configPath}\n${formatIssues(validated.error)}\n` +
        '  Nothing was written.',
    );
  }
  // The zod-parsed copy is only the validation; the RAW merged object is what gets written, so
  // keys this schema does not know about survive an init of a hand-extended config.
  //
  // A config that needs nothing added is handed back byte for byte instead of being
  // re-serialised: `JSON.stringify(…, 2)` would explode a hand-written one-line
  // `"defaults": { … }` into five lines and show up as a diff in a repo where init changed
  // nothing. Reformatting is not a merge result.
  const configContent =
    existingConfigRaw === undefined
      ? `${JSON.stringify(validated.data, null, 2)}\n`
      : configAdded.length === 0 && repoRootFixed === undefined
        ? existingConfigRaw
        : `${JSON.stringify(toWrite, null, 2)}\n`;

  // Now that the merge has decided: warn only if the model that will actually be written is the
  // placeholder AND nobody asked for it. Warning earlier (before the merge) fires on every
  // re-init of a repo whose config already names a real model.
  if (!modelFlag && validated.data.defaults.model === DEFAULT_MODEL) {
    note(
      `warning: no --model given — defaults.model set to "${DEFAULT_MODEL}". ` +
        "Replace it with the id shown in LM Studio's UI before running a workflow.",
    );
  }

  // The config on disk owns the workspace identity: registering any other name would produce a
  // `--workspace` entry pointing at a config that disagrees with it.
  const workspace = checkWorkspaceName(validated.data.workspace);
  if (workspace !== requestedName) {
    note(
      `note: ${configPath} declares workspace "${workspace}" — registering that name, not "${requestedName}".`,
    );
  }
  const effectivePassEnv = validated.data.app?.testAccount?.passEnv;

  // --- workspaces.json ------------------------------------------------------
  const registryPath = path.join(awHome(), 'workspaces.json');
  // The directory that was actually inited — never the path the config happened to carry.
  const registryEntry: WorkspaceEntry = {
    name: workspace,
    repoRoot,
    createdAt: new Date().toISOString(),
  };
  const registry = upsertWorkspace(readFileOrUndefined(registryPath), registryEntry);

  // --- CLAUDE.md ------------------------------------------------------------
  const claudeMdPath = path.join(repoRoot, 'CLAUDE.md');
  const existingClaudeMd = readFileOrUndefined(claudeMdPath);
  const header = `# ${path.basename(repoRoot)}\n\nProject notes for Claude Code. Anything above the agent-workflows block below is yours;\n\`aw init\` only ever rewrites what is between the two markers.\n\n`;
  const claudeMd = mergeClaudeMd(
    existingClaudeMd,
    renderClaudeBlock({ workspace, awRepoRoot: AW_REPO_ROOT, passEnv: effectivePassEnv }),
    header,
  );

  // --- .gitignore -----------------------------------------------------------
  const gitignorePath = path.join(repoRoot, '.gitignore');
  const gitignore = mergeGitignore(readFileOrUndefined(gitignorePath));

  const writes: PlannedWrite[] = [
    { file: configPath, content: configContent },
    { file: claudeMdPath, content: claudeMd.content },
  ];
  if (gitignore.added.length > 0) writes.push({ file: gitignorePath, content: gitignore.content });

  const copies = planClaudeCopies(repoRoot);
  const registryContent = `${JSON.stringify(registry.file, null, 2)}\n`;

  // Last planning step: prove every destination that is actually going to change can be written.
  // Without this, the first EACCES/ENOTDIR aborts the run mid-apply, and the user is told
  // "EACCES: permission denied" by a command whose every other failure says "Nothing was written."
  checkWritable([
    ...writes.filter((w) => !sameContent(w.file, w.content)).map((w) => w.file),
    ...copies.filter((c) => !fs.existsSync(c.dest)).map((c) => c.dest),
    ...(sameContent(registryPath, registryContent) ? [] : [registryPath]),
  ]);

  return {
    repoRoot,
    workspace,
    writes,
    copies,
    registryPath,
    registryEntry,
    registryContent,
    configAdded,
    repoRootFixed,
    gitignoreAdded: gitignore.added,
    claudeMdAction: claudeMd.action,
    passEnv: effectivePassEnv,
  };
}

/** Cheap "would `writeIfChanged` actually write?" test; an unreadable file counts as different. */
function sameContent(file: string, content: string): boolean {
  try {
    return fs.readFileSync(file, 'utf8') === content;
  } catch {
    return false;
  }
}

function checkWritable(targets: readonly string[]): void {
  // Deduplicated: six planned `.claude/*` files behind one `.claude` that is a regular file are
  // one problem to fix, not six lines to read.
  const seen = new Set<string>();
  for (const target of targets) {
    const problem = writabilityProblem(target);
    if (problem) seen.add(problem);
  }
  const problems = [...seen];
  if (problems.length === 0) return;
  throw new InitError(
    `cannot write ${problems.length === 1 ? 'a file' : `${problems.length} files`} this run needs to change:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n  Fix the permissions (or move what is in the way) and run init again. Nothing was written.',
  );
}

// ---------------------------------------------------------------------------
// applying
// ---------------------------------------------------------------------------

interface Change {
  file: string;
  status: Status;
}

function writeIfChanged(file: string, content: string): Status {
  const existing = readFileOrUndefined(file);
  if (existing === content) return 'unchanged';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return existing === undefined ? 'created' : 'updated';
}

/**
 * `tmp + rename` so a reader never sees a half-written registry, and so two inits racing on
 * `$AW_HOME` cannot interleave their writes inside one file. The file is left alone when the
 * bytes already match, which is what keeps a second `aw init` byte-identical.
 */
function writeRegistry(file: string, content: string): void {
  if (sameContent(file, content)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

interface Applied {
  changes: Change[];
  registryReplaced: boolean;
}

function applyPlan(plan: Plan): Applied {
  const changes: Change[] = [];
  /** What is already on disk when a later step fails — the user must be told, not left guessing. */
  const applied: string[] = [];

  /** Turn any write error into an InitError that names the file, the step and the damage. */
  const step = <T>(label: string, file: string, action: () => T): T => {
    try {
      return action();
    } catch (err) {
      throw new InitError(
        `${label} failed: ${file}\n  ${(err as Error).message}\n` +
          (applied.length === 0
            ? '  Nothing was written.'
            : `  Already written before this failure:\n${applied.map((f) => `    - ${f}`).join('\n')}\n` +
              '  The target repo is partially configured; fix the problem above and run init again ' +
              '(it is safe to re-run — it only adds what is missing).'),
      );
    }
  };

  for (const { file, content } of plan.writes) {
    const status = step('writing', file, () => writeIfChanged(file, content));
    if (status !== 'unchanged') applied.push(file);
    changes.push({ file, status });
  }

  for (const { src, dest } of plan.copies) {
    if (fs.existsSync(dest)) {
      // Required by T13 step 2.3: a file the target repo already has is never overwritten.
      out(`kept existing: ${dest}`);
      changes.push({ file: dest, status: 'kept existing' });
      continue;
    }
    step('copying the .claude layer into', dest, () => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    });
    applied.push(dest);
    changes.push({ file: dest, status: 'created' });
  }

  // Re-read and re-upsert instead of writing the copy captured at plan time: another init may
  // have registered a workspace in between, and the plan-time snapshot would erase it.
  const registry = step('registering the workspace in', plan.registryPath, () => {
    fs.mkdirSync(path.dirname(plan.registryPath), { recursive: true });
    const fresh = upsertWorkspace(readFileOrUndefined(plan.registryPath), plan.registryEntry);
    if (fresh.recovered) {
      const backup = `${plan.registryPath}.corrupt-${Date.now()}`;
      fs.copyFileSync(plan.registryPath, backup);
      note(`warning: ${plan.registryPath}: ${fresh.recovered}; original copied to ${backup}`);
    }
    writeRegistry(plan.registryPath, `${JSON.stringify(fresh.file, null, 2)}\n`);
    return fresh;
  });

  return { changes, registryReplaced: registry.replaced };
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

interface TreeNode {
  children: Map<string, TreeNode>;
  status?: Status;
}

/** `<root>` + a `├──`/`└──` tree of the touched paths, each annotated with what happened. */
export function renderTree(root: string, changes: readonly Change[]): string[] {
  const rootNode: TreeNode = { children: new Map() };
  const sorted = [...changes].sort((a, b) => a.file.localeCompare(b.file, 'en'));
  for (const change of sorted) {
    let node = rootNode;
    for (const part of path.relative(root, change.file).split(path.sep)) {
      let next = node.children.get(part);
      if (!next) {
        next = { children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    }
    node.status = change.status;
  }

  const lines = [root];
  const walk = (node: TreeNode, prefix: string): void => {
    const entries = [...node.children.entries()];
    entries.forEach(([name, child], index) => {
      const last = index === entries.length - 1;
      const label = child.children.size > 0 ? `${name}/` : name;
      lines.push(
        `${prefix}${last ? '└── ' : '├── '}${label}${child.status ? `  (${child.status})` : ''}`,
      );
      walk(child, `${prefix}${last ? '    ' : '│   '}`);
    });
  };
  walk(rootNode, '');
  return lines;
}

function printSummary(plan: Plan, applied: Applied): void {
  out('');
  for (const line of renderTree(plan.repoRoot, applied.changes)) out(line);
  out('');
  if (plan.configAdded.length > 0) {
    out(`config keys added: ${plan.configAdded.join(', ')}`);
  }
  if (plan.repoRootFixed !== undefined) {
    out(`config repoRoot corrected: ${plan.repoRootFixed} → ${plan.repoRoot}`);
  }
  out(`CLAUDE.md block: ${plan.claudeMdAction}`);
  out(
    plan.gitignoreAdded.length > 0
      ? `.gitignore lines added: ${plan.gitignoreAdded.join(' ')}`
      : '.gitignore: already complete',
  );
  out(
    `workspace "${plan.workspace}" ${applied.registryReplaced ? 're-registered' : 'registered'} ` +
      `in ${plan.registryPath} → ${plan.registryEntry.repoRoot}`,
  );
  if (plan.passEnv) {
    out(`test-account password: set ${plan.passEnv} in your shell/.env — it is never stored here`);
  }
  out('');
  out(
    `next: npx tsx ${shellQuote(path.join(AW_REPO_ROOT, 'src/cli.ts'))} review --workspace ${plan.workspace} --base main`,
  );
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

async function runInit(flags: InitFlags): Promise<void> {
  const interactive = !flags.yes && Boolean(process.stdin.isTTY);
  if (!flags.yes && !interactive) {
    note('note: stdin is not a TTY — running non-interactively with the defaults (as with --yes)');
  }
  const prompter = new Prompter(interactive);
  let plan: Plan;
  try {
    plan = await planInit(flags, prompter);
  } finally {
    // Always: an open readline interface keeps stdin referenced and the process alive.
    prompter.close();
  }
  printSummary(plan, applyPlan(plan));
}

/** T13 — `aw init`: register a target repo as a workspace and install the `.claude/` layer. */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Set up a target repo as an agent-workflows workspace')
    .option('-r, --repo <path>', 'target repo (must contain .git; default: cwd)')
    .option('-n, --name <ws>', 'workspace name (default: the repo directory name)')
    .option('--backend-start <cmd>', 'command that starts the backend')
    .option('--backend-port <port>', `backend port (default: ${DEFAULT_BACKEND_PORT})`)
    .option('--health-path <path>', `backend health path (default: ${DEFAULT_HEALTH_PATH})`)
    .option('--frontend-start <cmd>', 'command that starts the frontend')
    .option('--frontend-port <port>', `frontend port (default: ${DEFAULT_FRONTEND_PORT})`)
    .option('--base-url <url>', 'base URL under test (default: http://localhost:<backend-port>)')
    .option('--test-user <user>', 'test-account user (the password is NEVER asked for or stored)')
    .option('--pass-env <VAR>', `env var NAME holding its password (default: ${DEFAULT_PASS_ENV})`)
    .option('--staging-url <url>', 'staging URL (default: none)')
    .option('-p, --provider <p>', `default provider (default: ${DEFAULT_PROVIDER})`)
    .option('-m, --model <m>', 'default model id')
    .option('-y, --yes', 'non-interactive: take every default, skip unanswered optionals')
    .action(async (opts: InitFlags) => {
      try {
        await runInit(opts);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}
