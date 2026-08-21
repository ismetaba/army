import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateText, stepCountIs } from 'ai';
import type { ToolSet } from 'ai';
import type { AwConfig } from '../../shared/schemas';
import { loadAgent } from '../agents';
import { loadConfig, resolveModel } from '../config';
import { getModel } from '../providers/index';
import { makeCoreTools } from '../tools/core';
import { closeBrowser, makeBrowserTools } from '../tools/browser';
import { ensureUp, slugify, type EnsureUpHandle } from '../util';
import {
  CLAUDE_CLI_REFUSAL,
  clean,
  describeModelFailure,
  fail,
  log,
  messageOf,
  oneLine,
  truncate,
  write,
} from './common';
// The stuck-agent stop condition written for T09. Same failure mode here (a local model that
// re-issues one tool call until the step budget is gone), so it is reused, not re-implemented.
import { isLooping } from './test-feature';

// The `claude-cli` refusal is one shared constant (src/workflows/common.ts); re-exported here
// so importers of this workflow keep seeing it where it has always been.
export { CLAUDE_CLI_REFUSAL };

const execFileAsync = promisify(execFileCb);

export interface DesignLoopOptions {
  /** Feature description, or a path to a spec file holding one. */
  feature: string;
  /** Feedback for a second (or later) pass over an existing implementation. */
  iterate?: string;
  provider?: string;
  model?: string;
  config?: string;
  workspace?: string;
}

export interface DesignLoopResult {
  slug: string;
  /** The ≤5-line plan, as printed. */
  plan: string;
  /** Absolute paths of every PNG under `screenshots/<slug>/`. */
  screenshots: string[];
  /** False when the tree was already clean (T10 step 7: skip cleanly). */
  committed: boolean;
  /** Short sha of the checkpoint commit, when one was made. */
  commit?: string;
  changedFiles: string[];
  judgmentCalls: string[];
}

/** T10 step 5: the designer implements *and* verifies, so it gets the largest budget. */
const MAX_STEPS = 60;

/**
 * The nudge only re-opens the browser: goto + screenshot + console errors for a handful of
 * screens. A small cap is what stops it turning into a second implementation pass.
 */
const NUDGE_MAX_STEPS = 12;

/**
 * Slack allowed between a file's mtime and the session start before it counts as stale.
 * Filesystem mtimes are coarser than a millisecond on some filesystems.
 */
const FRESH_SLACK_MS = 2_000;

/**
 * Whole-session guard. 60 steps against a local model at 10–90 s each is ~90 min worst case,
 * so the default sits just above it. Override with `AW_DESIGN_TIMEOUT_MS`.
 */
const DEFAULT_TIMEOUT_MS = 5_700_000;

/** The plan is one toolless turn; it never needs the session budget. */
const PLAN_TIMEOUT_MS = 600_000;

/** T10 step 3: poll a freshly started dev server for up to 60 s. */
const PROBE_TIMEOUT_MS = 5_000;
const START_WAIT_MS = 60_000;
const START_POLL_MS = 2_000;

/** T10 step 4: "a UI plan in at most 5 lines". Anything past that is padding, and is dropped. */
const MAX_PLAN_LINES = 5;
const MAX_PLAN_LINE_CHARS = 300;

/** A spec file larger than this is not a spec; refusing beats silently truncating one. */
const MAX_SPEC_BYTES = 64 * 1024;

/** Longest slug used as a directory name under `screenshots/`. */
export const MAX_SLUG_CHARS = 60;

/** Frontend file list handed to the plan step; a repo with more files sends the first N. */
const MAX_LISTED_FILES = 200;

/** Judgment calls are a list for a human to read, not a transcript. */
const MAX_JUDGMENT_CALLS = 20;
const MAX_JUDGMENT_CHARS = 400;

const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/** T10 step 6 — the guard that makes "I implemented it" unacceptable on its own. */
export const NO_SCREENSHOTS = 'agent finished without screenshots — not acceptable';

/** Leading markdown decoration: `- `, `* `, `1. `, `> `, `### `. */
const BLOCK_MARKER_RE = /^(?:>+\s*|#{1,6}\s+|(?:[-*+•]|\d{1,3}[.)])\s+)/;

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function undecorate(line: string): string {
  let s = line.trim();
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(BLOCK_MARKER_RE, '').trim();
    // `**bold**` / `__bold__` / `*italic*` wrapping the whole line.
    const emphasis = /^(\*\*|__|\*)([\s\S]+?)\1$/.exec(s);
    if (emphasis) s = emphasis[2]!.trim();
    if (s === before) break;
  }
  return s;
}

// ---------------------------------------------------------------------------
// feature / slug (T10 step 2)
// ---------------------------------------------------------------------------

export interface ResolvedFeature {
  /** The text handed to the model: the spec file's contents, or the argument itself. */
  description: string;
  /** Absolute path of the spec file, when the argument named one. */
  specPath?: string;
}

/**
 * T10 step 2: an argument that names an existing file is a spec; anything else is the
 * description itself. A directory is never a spec — it is a description that happens to
 * look like a path, and reading it would throw EISDIR.
 */
export function resolveFeature(feature: string, cwd = process.cwd()): ResolvedFeature {
  const given = feature.trim();
  const candidate = path.resolve(cwd, given);
  let isFile = false;
  try {
    isFile = fs.statSync(candidate).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return { description: given };

  const size = fs.statSync(candidate).size;
  if (size > MAX_SPEC_BYTES) {
    fail(`spec file is too large: ${candidate} (${size} bytes, max ${MAX_SPEC_BYTES})`);
  }
  const text = clean(fs.readFileSync(candidate, 'utf8')).trim();
  if (!text) fail(`spec file is empty: ${candidate}`);
  return { description: text, specPath: candidate };
}

/**
 * T10 step 2: `slugify(description first 6 words)`.
 * Markdown decoration is stripped first so a spec starting with `# Feature:` does not
 * spend three of its six words on punctuation.
 */
export function slugForFeature(description: string): string {
  const words = clean(description)
    .replace(/[`*_#>[\]()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const slug = slugify(words.join(' ')).slice(0, MAX_SLUG_CHARS).replace(/-+$/, '');
  return slug || 'design';
}

/**
 * The exact resume line of T10 step 8. `feature` is echoed inside double quotes, so a quote or
 * backslash in it is escaped — otherwise the printed command would not be runnable as printed.
 */
export function resumeLine(feature: string): string {
  const quoted = oneLine(feature).replace(/([\\"$`])/g, '\\$1');
  return `--- STOPPING FOR FEEDBACK — resume with: aw design-loop "${quoted}" --iterate "<your feedback>" ---`;
}

// ---------------------------------------------------------------------------
// plan + summary text
// ---------------------------------------------------------------------------

/** Keep the first `MAX_PLAN_LINES` non-empty, non-fence lines: the plan, and nothing else. */
export function limitPlan(text: string, maxLines = MAX_PLAN_LINES): string {
  return clean(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^(?:```|~~~)\w*$/.test(l))
    .slice(0, maxLines)
    .map((l) => truncate(l, MAX_PLAN_LINE_CHARS))
    .join('\n');
}

/** "Judgment calls:", "Judgement call —", "**Judgment Calls**" — heading plus anything inline. */
const JUDGMENT_HEADING_RE = /^judge?ment calls?\b\s*[:\-—]?\s*(.*)$/i;

/**
 * Pull the "judgment calls" the agent reported (its instructions require them) out of free text.
 *
 * Deliberately lenient about shape — heading + bullets, heading + prose, or all on one line —
 * because the only alternative is a second model call to reformat prose that a human is about
 * to read anyway. Returns `[]` when the agent reported none; the caller says so explicitly
 * rather than printing an empty section.
 */
export function extractJudgmentCalls(text: unknown): string[] {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const lines = clean(text).replace(/\r\n?/g, '\n').split('\n');

  const items: string[] = [];
  const push = (value: string): void => {
    const item = oneLine(undecorate(value));
    if (!item) return;
    if (items.length >= MAX_JUDGMENT_CALLS) return;
    items.push(truncate(item, MAX_JUDGMENT_CHARS));
  };

  for (let i = 0; i < lines.length; i += 1) {
    const heading = JUDGMENT_HEADING_RE.exec(undecorate(lines[i]!).replace(/^\*+|\*+$/g, ''));
    if (!heading) continue;

    // "Judgment calls: kept the existing card padding." — the whole answer on the heading line.
    const inline = (heading[1] ?? heading[2] ?? '').trim();
    if (inline) push(inline);

    let sawBlank = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j]!;
      if (raw.trim() === '') {
        // One blank line between the heading and its list is normal; a blank after items ends it.
        if (items.length > 0 || sawBlank) break;
        sawBlank = true;
        continue;
      }
      const bulleted = BLOCK_MARKER_RE.test(raw.trim());
      // Prose continuation is only accepted while nothing has been collected yet: once the
      // list has started, an unbulleted line is the next section, not another judgment call.
      if (!bulleted && items.length > 0) break;
      // A new markdown heading always ends the section.
      if (/^#{1,6}\s+/.test(raw.trim()) || /^[A-Z][\w ]{0,30}:\s*$/.test(raw.trim())) break;
      push(raw);
      if (!bulleted) break;
    }
    if (items.length > 0) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// screenshots (T10 step 6)
// ---------------------------------------------------------------------------

export interface FoundScreenshot {
  path: string;
  mtimeMs: number;
  bytes: number;
}

/** Every `*.png` under `dir`, recursively (browser_screenshot nests on `/` in a screen name). */
export function findScreenshots(dir: string): FoundScreenshot[] {
  const out: FoundScreenshot[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findScreenshots(full));
      continue;
    }
    if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue;
    try {
      const stat = fs.statSync(full);
      out.push({ path: full, mtimeMs: stat.mtimeMs, bytes: stat.size });
    } catch {
      // Vanished between readdir and stat; nothing to report.
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// git (T10 step 7)
// ---------------------------------------------------------------------------

/** `core.quotePath=false`: a non-ASCII path must come back usable, not C-quoted. */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repoRoot,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return stdout;
}

function gitStderr(err: unknown): string {
  const e = err as { stderr?: string };
  return (e.stderr ?? '').trim() || messageOf(err);
}

export interface CheckpointResult {
  committed: boolean;
  commit?: string;
  files: string[];
  error?: string;
}

/**
 * T10 step 7: `git add -A && git commit -m "design-loop(<slug>): checkpoint"`, skipped cleanly
 * when the tree is already clean. NEVER pushes — nothing in this module runs a remote command.
 *
 * "Clean" is decided *after* staging, not before: `git add -A` is what resolves a change that
 * only affects the index (mode bits, an intent-to-add), and `git status --porcelain` before
 * staging would also report ignored-but-untracked noise the commit will not contain.
 */
export async function checkpoint(repoRoot: string, slug: string): Promise<CheckpointResult> {
  try {
    await git(repoRoot, ['add', '-A']);
  } catch (err) {
    return { committed: false, files: [], error: `git add -A failed: ${gitStderr(err)}` };
  }

  let staged: string[];
  try {
    staged = (await git(repoRoot, ['diff', '--cached', '--name-only', '-z']))
      .split('\0')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch (err) {
    return { committed: false, files: [], error: `git diff --cached failed: ${gitStderr(err)}` };
  }
  if (staged.length === 0) return { committed: false, files: [] };

  try {
    await git(repoRoot, ['commit', '-m', `design-loop(${slug}): checkpoint`]);
  } catch (err) {
    return { committed: false, files: staged, error: `git commit failed: ${gitStderr(err)}` };
  }

  let commit = '';
  try {
    commit = (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
  } catch {
    // The commit landed; not being able to name it is cosmetic.
  }
  // The commit's own file list, so the printed block describes the commit rather than the
  // staging area it was built from.
  let files = staged;
  try {
    files = (await git(repoRoot, ['show', '--pretty=format:', '--name-only', 'HEAD']))
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    // Fall back to the staged list.
  }
  return { committed: true, commit: commit || undefined, files };
}

// ---------------------------------------------------------------------------
// prompts (T10 steps 4 and 5)
// ---------------------------------------------------------------------------

const FRONTEND_DIR_RE = /^(?:src|app|pages|components|styles|public|assets|ui|web|client|frontend)\//i;
const FRONTEND_FILE_RE = /\.(?:tsx|jsx|vue|svelte|css|scss|sass|less|html|astro)$/i;

/** Files the plan step is shown: the repo's frontend surface, from `git ls-files`. */
export function frontendFiles(all: readonly string[]): string[] {
  const picked = all.filter((f) => FRONTEND_DIR_RE.test(f) || FRONTEND_FILE_RE.test(f));
  return (picked.length > 0 ? picked : [...all]).slice(0, MAX_LISTED_FILES);
}

async function listFrontendFiles(repoRoot: string): Promise<string[]> {
  try {
    const all = (await git(repoRoot, ['ls-files', '-z']))
      .split('\0')
      .map((f) => f.trim())
      .filter(Boolean);
    return frontendFiles(all);
  } catch (err) {
    log(`warning: git ls-files failed in ${repoRoot} (${gitStderr(err)}) — planning without a file list`);
    return [];
  }
}

export function buildPlanPrompt(args: {
  description: string;
  specPath?: string;
  iterate?: string;
  files: readonly string[];
  frontendUrl: string;
}): string {
  const { description, specPath, iterate, files, frontendUrl } = args;
  const parts: string[] = [];
  parts.push(specPath ? `Feature spec (${specPath}):` : 'Feature to implement:', description, '');
  if (iterate) parts.push(`Feedback on the existing implementation: ${iterate}`, '');
  parts.push(`The app is running at ${frontendUrl}.`, '');
  if (files.length > 0) {
    parts.push(`Frontend files in this repository (${files.length}):`, ...files.map((f) => `- ${f}`), '');
  }
  parts.push(
    'Output a UI plan in at most 5 lines: screens, components, states.',
    'No preamble, no code, no markdown headings — at most 5 short lines.',
  );
  return parts.join('\n');
}

export function buildSessionPrompt(args: {
  plan: string;
  description: string;
  specPath?: string;
  iterate?: string;
  frontendUrl: string;
  repoRoot: string;
  screenshotDir: string;
  cfg: AwConfig;
}): string {
  const { plan, description, specPath, iterate, frontendUrl, repoRoot, screenshotDir, cfg } = args;
  const parts: string[] = [];

  // T10 step 5: the feedback goes FIRST, so a model that reads only the head of a long prompt
  // still sees that this is an iteration on existing code rather than a fresh build.
  if (iterate) {
    parts.push(
      `Apply this feedback to the existing implementation, re-verify ONLY the affected screens: ${iterate}`,
      '',
    );
  }
  parts.push('Plan:', plan || '(no plan was produced)', '');
  parts.push(specPath ? `Feature spec (${specPath}):` : 'Feature to implement:', description, '');
  parts.push(
    `Frontend base URL (already running, do not start it): ${frontendUrl}`,
    `Repository root (all paths are relative to it): ${repoRoot}`,
    `Screenshots you take are saved under: ${screenshotDir}`,
  );
  if (cfg.app?.baseUrl) parts.push(`Backend base URL: ${cfg.app.baseUrl}`);
  if (cfg.offLimits?.length) parts.push(`Off limits (never touch): ${cfg.offLimits.join(', ')}`);
  parts.push(
    '',
    'Implement, then run your self-review checklist loop from your instructions on every touched',
    'screen at both viewports. Save final screenshots named <screen>-<viewport>. End with the',
    'required summary.',
    '',
    'How to work here, no exceptions:',
    '- edit files with write_file/edit_file; the dev server hot-reloads, so no build step is needed;',
    '- browser_goto the URL above, then browser_screenshot with `screen` (e.g. "about") and',
    '  `viewport` ("mobile" and "desktop") — the file name is derived from those two, so never',
    '  pass a path or a ".png" suffix, and never put the viewport in `screen` ("about", not',
    '  "about-mobile"): the viewport is appended for you;',
    '- at least one screenshot per touched screen per viewport is MANDATORY: work with no',
    '  screenshot is treated as unfinished and the run fails;',
    '- check browser_console_errors on every screen you touched before you finish;',
    '- never start, restart or stop a server (no `npm run dev`, no watcher): the app is already',
    '  running and a long-running command would outlive this session and hold the port;',
    '- never run `git commit`, `git add` or `git push` — this workflow makes the checkpoint',
    '  commit for you after you finish;',
    '- never ask questions; when a product decision is genuinely open, pick the option that',
    '  matches the existing app and record it as a judgment call.',
    '',
    // Recency matters to a small local model: the T14 acceptance run read every file, edited two
    // of them and then wrote its summary without ever opening the browser, because the screenshot
    // rule sat in the middle of a long bullet list. The same rule as an ordered procedure, last,
    // is what it actually follows.
    'Before you write that summary, do this for EVERY screen you touched, in this order:',
    '  1. browser_goto {"url":"<that screen\'s URL, hash route included>","viewport":"mobile"}',
    '  2. browser_screenshot {"screen":"<screen>","viewport":"mobile"}',
    '  3. browser_goto {"url":"<the same URL>","viewport":"desktop"}',
    '  4. browser_screenshot {"screen":"<screen>","viewport":"desktop"}',
    '  5. browser_console_errors for each of the two viewports',
    'The two viewports are two separate browser windows: a screenshot of one you never navigated',
    'is a blank page, and the tool refuses it. A summary written before those calls is a failed',
    'run: there is nothing for the human to review.',
    '',
    'Finish with exactly these three sections, as plain text:',
    'Changed: <one line per file you edited or created>',
    'Screenshots: <the paths browser_screenshot returned>',
    'Judgment calls: <one bullet per call, or "none">',
  );
  return parts.join('\n');
}

/**
 * The one nudge sent when a session produced no screenshot of its own (T14).
 *
 * Same shape as the single format retry in `review` and `test-feature`: the model is not asked
 * to redo the work, only to finish the step it skipped. It keeps the browser tools — a screenshot
 * needs them — plus the read-only core profile, and nothing else: with no write_file/edit_file/bash
 * in its tool set the nudge *cannot* turn into a second implementation pass, and its step budget
 * is NUDGE_MAX_STEPS rather than the session's. Its own summary is replayed back so it knows
 * which screens it claims to have touched.
 */
export function buildNudgePrompt(args: {
  frontendUrl: string;
  screenshotDir: string;
  answer: string;
}): string {
  const { frontendUrl, screenshotDir, answer } = args;
  const parts = [
    'You finished without taking a single screenshot, so nothing you did has been verified and',
    'there is nothing for the human to review. Do NOT edit any file now and do NOT re-implement',
    'anything: the code is already written. Take the screenshots.',
    '',
    `The app is running at ${frontendUrl}. Screenshots are saved under ${screenshotDir}.`,
    '',
    'For EVERY screen you touched, in this order:',
    '  1. browser_goto {"url":"<that screen\'s URL, hash route included>","viewport":"mobile"}',
    '  2. browser_screenshot {"screen":"<screen>","viewport":"mobile"}',
    '  3. browser_goto {"url":"<the same URL>","viewport":"desktop"}',
    '  4. browser_screenshot {"screen":"<screen>","viewport":"desktop"}',
    '  5. browser_console_errors for each of the two viewports',
    'The two viewports are two separate browser windows: each needs its own browser_goto, or the',
    'screenshot is a blank page and the tool refuses it.',
    '`screen` is a bare name ("about"), never a path and never a ".png" — the viewport is',
    'appended for you.',
  ];
  if (answer.trim()) {
    parts.push('', 'This is what you said you changed:', truncate(answer.trim(), 4 * 1024));
  }
  parts.push(
    '',
    'Then finish with exactly these three sections, as plain text:',
    'Changed: <one line per file you edited or created>',
    'Screenshots: <the paths browser_screenshot returned>',
    'Judgment calls: <one bullet per call, or "none">',
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// app start (T10 step 3)
// ---------------------------------------------------------------------------

function joinUrl(base: string, suffix: string): string {
  const root = base.replace(/\/+$/, '');
  if (!suffix || suffix === '/') return root || base;
  return `${root}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
}

// ---------------------------------------------------------------------------
// workflow
// ---------------------------------------------------------------------------

function timeoutMs(): number {
  const raw = Number.parseInt(process.env.AW_DESIGN_TIMEOUT_MS?.trim() ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * T10 — `aw design-loop`: implement UI, verify it in a real browser, screenshot both viewports,
 * checkpoint the work in git, then stop for human feedback.
 *
 * Exit 1 (never a stack trace) when: the provider is `claude-cli`, the config/repo is unusable,
 * no frontend URL is configured, a dev server this run started never came up, or the agent
 * finished without producing a single screenshot. Everything this run started — Chromium and
 * any dev server — is stopped on every path out, including the failure paths.
 */
export async function runDesignLoop(opts: DesignLoopOptions): Promise<DesignLoopResult> {
  const featureArg = opts.feature?.trim() ?? '';
  if (!featureArg) fail('feature is required: aw design-loop "<feature|spec-path>"');
  const iterate = opts.iterate?.trim() || undefined;
  if (opts.iterate !== undefined && !iterate) {
    log('warning: --iterate was empty — running as a first pass');
  }

  const cfg = loadConfig(opts);

  // Checked on the raw flag *before* resolveModel: `--provider claude-cli` without `--model`
  // resolves to "model required: ..." (SPEC § Model resolution), which would mask the real
  // reason the provider is unusable here.
  if (opts.provider?.trim() === 'claude-cli') fail(CLAUDE_CLI_REFUSAL);
  const { provider, model } = resolveModel('ui-designer', opts, cfg);
  if (provider === 'claude-cli') fail(CLAUDE_CLI_REFUSAL);

  const repoRoot = cfg.repoRoot;
  if (!fs.existsSync(repoRoot)) fail(`repoRoot does not exist: ${repoRoot}`);
  try {
    await git(repoRoot, ['rev-parse', '--git-dir']);
  } catch (err) {
    fail(`not a git repository: ${repoRoot} (${gitStderr(err)})`);
  }

  const { description, specPath } = resolveFeature(featureArg);
  const slug = slugForFeature(description);
  const screenshotDir = path.join(repoRoot, 'screenshots', slug);

  // --- where the UI lives ----------------------------------------------------
  const frontend = cfg.app?.frontend;
  const frontendUrl = frontend
    ? `http://localhost:${frontend.port}`
    : (cfg.app?.baseUrl?.trim() ?? '');
  if (!frontendUrl) {
    fail(
      'no frontend URL: configure app.frontend.port (or app.baseUrl) in aw.config.json — ' +
        'design-loop must be able to open the UI in a browser',
    );
  }

  // --- start the app (T10 step 3) --------------------------------------------
  const handles: EnsureUpHandle[] = [];
  /** Stop only what this run started; a server the developer already had running is left alone. */
  const stopStarted = async (): Promise<void> => {
    for (const handle of handles) {
      if (handle.started) await handle.stopAndWait().catch(() => undefined);
    }
    handles.length = 0;
  };
  const cleanup = async (): Promise<void> => {
    await closeBrowser().catch(() => undefined);
    await stopStarted();
  };
  /** `fail()` after resources exist: release Chromium and the dev servers first, then exit 1. */
  const bail = async (message: string): Promise<never> => {
    await cleanup();
    return fail(message);
  };

  const start = async (label: string, url: string, command?: string): Promise<void> => {
    const handle = await ensureUp({
      url,
      start: command,
      cwd: repoRoot,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      waitMs: START_WAIT_MS,
      intervalMs: START_POLL_MS,
      log: (line) => log(`[${label}] ${line}`),
    });
    handles.push(handle);
    if (handle.up) {
      if (handle.started) log(`${label} started by this run: ${handle.command}`);
      return;
    }
    if (!command?.trim()) {
      log(`warning: ${label} at ${url} is not answering and no start command is configured`);
      return;
    }
    await bail(
      `${label} at ${url} is still down after ${START_WAIT_MS / 1000}s.\n` +
        `  tried to start it with: ${handle.command ?? command}\n` +
        `  in: ${repoRoot}\n` +
        `  last error: ${handle.lastError ?? 'unknown'}`,
    );
  };

  const backend = cfg.app?.backend;
  if (backend) {
    const backendBase = cfg.app?.baseUrl?.trim() || `http://localhost:${backend.port}`;
    await start('backend', joinUrl(backendBase, backend.healthPath ?? '/'), backend.start);
  }
  if (frontend) {
    await start('frontend', joinUrl(frontendUrl, '/'), frontend.start);
  } else {
    log(`note: no app.frontend configured — using ${frontendUrl} as the UI base URL`);
  }

  // --- the session -----------------------------------------------------------
  const agent = loadAgent('ui-designer');
  const browserTools = makeBrowserTools({ screenshotDir, viewports: cfg.viewports });
  const tools: ToolSet = {
    ...makeCoreTools('designer', repoRoot),
    ...browserTools,
  };
  /**
   * The nudge's tool set: the same browser tools (same screenshot namer, so a re-shot screen
   * keeps its file) plus the read-only core profile. No write_file/edit_file/bash, so "do not
   * edit anything now" is enforced by the tool list rather than by a sentence in the prompt.
   */
  const nudgeTools: ToolSet = {
    ...makeCoreTools('reviewer', repoRoot),
    ...browserTools,
  };

  const ask = async (
    prompt: string,
    withTools: ToolSet | undefined,
    limitMs: number,
    maxSteps: number = MAX_STEPS,
  ): Promise<{ text: string; steps: number }> => {
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: getModel(provider, model),
        system: agent.system,
        prompt,
        tools: withTools,
        stopWhen: withTools ? [stepCountIs(maxSteps), isLooping] : stepCountIs(1),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(limitMs),
        onStepEnd: (step) => {
          for (const call of step.toolCalls) {
            log(`[tool] ${call.toolName} ${truncate(JSON.stringify(call.input ?? {}))}`);
          }
          for (const res of step.toolResults) {
            log(`[tool] ${res.toolName} -> ${truncate(JSON.stringify(res.output ?? null))}`);
          }
        },
      });
    } catch (err) {
      // getModel() throws here for a missing API key; the SDK throws for transport failures.
      // bail() stops Chromium and every dev server this run started before exiting.
      return bail(
        describeModelFailure(err, provider, {
          activity: 'the design session',
          timeoutMs: timeoutMs(),
        }),
      );
    }
    // The final message is often empty on a local model that narrated between tool calls;
    // fall back to the last step that said anything.
    let text = (result.text ?? '').trim();
    if (!text) {
      for (let i = result.steps.length - 1; i >= 0 && !text; i -= 1) {
        text = (result.steps[i]?.text ?? '').trim();
      }
    }
    return { text, steps: result.steps.length };
  };

  // --- PLAN (T10 step 4) -----------------------------------------------------
  log(
    `design-loop "${oneLine(featureArg)}" — ${provider}/${model}, slug "${slug}"` +
      (iterate ? ' (iterate)' : ''),
  );
  const files = await listFrontendFiles(repoRoot);
  const planPrompt = buildPlanPrompt({ description, specPath, iterate, files, frontendUrl });
  const planned = await ask(planPrompt, undefined, PLAN_TIMEOUT_MS);
  const plan = limitPlan(planned.text);
  // The plan is a result, not progress: it goes to stdout, and the run continues without waiting.
  write(1, 'PLAN:');
  write(1, plan || '(the model produced no plan)');
  write(1, '');

  // --- IMPLEMENT + VERIFY (T10 step 5) ---------------------------------------
  const sessionPrompt = buildSessionPrompt({
    plan,
    description,
    specPath,
    iterate,
    frontendUrl,
    repoRoot,
    screenshotDir,
    cfg,
  });
  const startedAtMs = Date.now();
  log(`session: implementing and verifying at ${frontendUrl} (up to ${MAX_STEPS} steps)`);
  let session = await ask(sessionPrompt, tools, timeoutMs());
  log(`model finished in ${session.steps} step(s)`);
  if (session.steps >= MAX_STEPS) {
    log(`warning: the agent used its whole ${MAX_STEPS}-step budget without finishing`);
  }

  // --- screenshots (T10 step 6) ----------------------------------------------
  const isFresh = (s: { mtimeMs: number }): boolean => s.mtimeMs >= startedAtMs - FRESH_SLACK_MS;
  let shots = findScreenshots(screenshotDir);
  // Freshness, not existence, is what the nudge is for. `--iterate` reuses the slug, so the
  // directory already holds the first pass's PNGs: gating on `shots.length === 0` meant the
  // nudge could never fire on the one run whose evidence actually failed in T14, and the
  // previous pass's screenshots were presented as verification of the revision.
  if (shots.filter(isFresh).length === 0) {
    // One nudge before giving up. Observed in the T14 acceptance run: the model read the repo,
    // wrote the page, edited the router — and then summarised without ever opening the browser.
    // The work is on disk and correct; only the verification step was skipped, and re-running
    // the whole workflow would re-implement code that already exists.
    log(
      `warning: the session produced no new screenshot${shots.length > 0 ? ' (only PNGs from an earlier run)' : ''}` +
        ' — asking the agent once to verify in the browser',
    );
    const nudge = await ask(
      buildNudgePrompt({ frontendUrl, screenshotDir, answer: session.text }),
      nudgeTools,
      timeoutMs(),
      NUDGE_MAX_STEPS,
    );
    log(`nudge finished in ${nudge.steps} step(s)`);
    session = {
      // Both answers are kept: the first names the changed files, the second the screenshots,
      // and `extractJudgmentCalls` reads whichever of the two reported them.
      text: [session.text, nudge.text].filter(Boolean).join('\n\n'),
      steps: session.steps + nudge.steps,
    };
    shots = findScreenshots(screenshotDir);
  }
  if (shots.length === 0) {
    // Not a warning: an unverified UI change is exactly what this workflow exists to prevent.
    await bail(`${NO_SCREENSHOTS}\n  expected at least one PNG under ${screenshotDir}`);
  }
  const stale = shots.filter((s) => !isFresh(s));
  if (stale.length === shots.length) {
    log(
      `warning: every PNG under ${screenshotDir} predates this session — the agent presented ` +
        'screenshots from an earlier run',
    );
  } else if (stale.length > 0) {
    // Per file, not only when ALL are stale: an iteration that re-shot two of eight screens was
    // still presenting the other six as evidence for changes they never showed.
    log(
      `warning: ${stale.length} of ${shots.length} screenshot(s) predate this session and are ` +
        `marked stale below: ${stale.map((s) => s.path).join(', ')}`,
    );
  }
  const staleSet = new Set(stale.map((s) => s.path));
  const empty = shots.filter((s) => s.bytes === 0);
  if (empty.length > 0) {
    log(`warning: ${empty.length} screenshot(s) are 0 bytes: ${empty.map((s) => s.path).join(', ')}`);
  }

  // --- checkpoint (T10 step 7) -----------------------------------------------
  const result = await checkpoint(repoRoot, slug);
  if (result.error) {
    log(`warning: ${result.error}`);
  } else if (result.committed) {
    log(`checkpoint commit ${result.commit ?? '(unknown)'} — ${result.files.length} file(s)`);
  } else {
    log('nothing to commit — no checkpoint was made');
  }

  // Chromium and the dev servers are released before the block is printed: the presentation is
  // the last thing the user sees, and it must not be interleaved with shutdown noise.
  await cleanup();

  // --- present and stop (T10 step 8) -----------------------------------------
  const judgmentCalls = extractJudgmentCalls(session.text);
  write(1, 'CHANGED FILES:');
  if (result.files.length > 0) for (const f of result.files) write(1, `  ${f}`);
  else write(1, '  (none — the working tree was already clean)');
  write(1, '');
  write(1, 'SCREENSHOTS:');
  for (const shot of shots) {
    // The label is on stdout with the path: a stale PNG presented unmarked is evidence for a
    // change it does not show.
    write(1, `  ${shot.path}${staleSet.has(shot.path) ? '  (stale — not taken in this run)' : ''}`);
  }
  write(1, '');
  write(1, 'JUDGMENT CALLS:');
  if (judgmentCalls.length > 0) for (const call of judgmentCalls) write(1, `  - ${call}`);
  else write(1, '  (none reported)');
  write(1, '');
  write(1, resumeLine(featureArg));

  if (result.error) {
    // The work and the screenshots survive on disk; the checkpoint did not, and pretending
    // otherwise would make the resume line a lie.
    fail(`checkpoint commit failed: ${result.error}`);
  }

  return {
    slug,
    plan,
    screenshots: shots.map((s) => s.path),
    committed: result.committed,
    commit: result.commit,
    changedFiles: result.files,
    judgmentCalls,
  };
}
