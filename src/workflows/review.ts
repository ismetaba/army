import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { generateText, stepCountIs } from 'ai';
import type { Finding, Severity, Verdict } from '../../shared/schemas';
import { loadAgent } from '../agents';
import { loadConfig, resolveModel } from '../config';
import { getModel } from '../providers/index';
import { makeCoreTools } from '../tools/core';
import {
  CLAUDE_CLI_REFUSAL,
  describeModelFailure,
  fail,
  isContextOverflowError,
  log,
  messageOf,
  truncate,
  write,
} from './common';

// The `claude-cli` refusal is one shared constant (src/workflows/common.ts); re-exported here
// so importers of this workflow keep seeing it where it has always been.
export { CLAUDE_CLI_REFUSAL };

const execFileAsync = promisify(execFileCb);

export interface ReviewOptions {
  base: string;
  provider?: string;
  model?: string;
  config?: string;
  workspace?: string;
}

export interface ReviewResult {
  verdict: Verdict;
  findings: Finding[];
  /** The model's raw text — the accepted attempt, whether that was the first or the retry. */
  raw: string;
}

/** SPEC § Agent session loop: `stopWhen: stepCountIs(25)`. */
const MAX_STEPS = 25;

/** T08 step 3: the diff handed to the model is capped at 60 KB. */
const MAX_DIFF_BYTES = 60 * 1024;

/**
 * Floor for the automatic shrink below: under this there is not enough diff left for a review
 * worth printing, so the run fails with the provider's own explanation instead.
 */
const MIN_DIFF_BUDGET_BYTES = 2 * 1024;
/** How many times the diff budget may be halved when the provider says the prompt is too long. */
const MAX_DIFF_SHRINKS = 3;

const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Hard cap on a whole reviewer session: 25 steps against a local model at 10–90 s each is
 * ~37 min in the worst case, so the guard sits above that. Override with `AW_REVIEW_TIMEOUT_MS`.
 */
const DEFAULT_TIMEOUT_MS = 2_700_000;

/**
 * Below this, a head slice of an oversized per-file diff is too small to be worth sending;
 * the file is listed as omitted instead.
 */
const MIN_SLICE_BYTES = 2 * 1024;

/** Line numbers above this are not a real location — the model hallucinated or ran digits together. */
const MAX_LINE_NUMBER = 10_000_000;

/** Appended verbatim to the prompt for the single format retry (T08 step 5). */
const RETRY_NOTE = 'Your previous output violated the format. Output only the required format.';

const NOT_PROVIDED = '(not provided)';

/** SPEC § Review output contract, verbatim. */
const VERDICT_RE = /^VERDICT: (APPROVE|APPROVE WITH NITS|REQUEST CHANGES)$/;
const FINDING_RE = /^\[(BLOCKER|MAJOR|MINOR|NIT)\] (.+?):(\d+) — (.+)$/;
/** A line that *looks* like a finding header but is not one — reported, never silently dropped. */
const NEAR_MISS_RE = /^\[[^\]\n]{1,24}\]/;
/** Any line naming a SPEC severity in brackets is a finding attempt, wherever the token sits. */
const SEVERITY_TOKEN_RE = /\[(?:BLOCKER|MAJOR|MINOR|NIT)\]/;
const RISK_RE = /^Risk:\s*(.*)$/;
const FIX_RE = /^Fix:\s*(.*)$/;
/**
 * Leading markdown block decoration a model may put in front of a finding:
 * `- `, `* `, `1. `, `2) ` (lists), `### ` (headings), `> ` (block quotes).
 */
const BLOCK_MARKER_RE = /^(?:>+\s*|#{1,6}\s+|(?:[-*+]|\d{1,3}[.)])\s+)/;
/** `**bold**` / `__bold__` / `*italic*` wrapping the line or just its first span. */
const EMPHASIS_RE = /^(\*\*|__|\*)(.+?)\1/;
/** C0/C1 control characters: never part of a finding, and an ANSI escape can rewrite stdout. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

const SEVERITY_ORDER: Record<Severity, number> = { BLOCKER: 0, MAJOR: 1, MINOR: 2, NIT: 3 };

/**
 * Remove control characters from text that is re-rendered to stdout. The model's output is
 * derived from an untrusted diff, and an ANSI escape in a finding title can blank or overwrite
 * the lines printed before it.
 */
function sanitize(text: string): string {
  return text.replace(CONTROL_RE, ' ').trim();
}

/**
 * Strip markdown decoration a model may wrap a finding line in — list markers, headings,
 * block quotes and `**bold**` — so the SPEC regexes see the line the model meant to write.
 * Without this, `**[BLOCKER] a.ts:1 — x**` matches nothing and the BLOCKER disappears.
 */
function undecorate(line: string): string {
  let s = line;
  for (let i = 0; i < 6; i += 1) {
    const before = s;
    s = s.replace(BLOCK_MARKER_RE, '');
    const emphasis = EMPHASIS_RE.exec(s);
    if (emphasis) s = `${emphasis[2]!}${s.slice(emphasis[0].length)}`;
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export type ParsedReview =
  | { ok: true; verdict: Verdict; findings: Finding[]; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

/**
 * Parse the reviewer's plain-text output into a verdict + findings.
 *
 * Contract: this function NEVER throws. Either it returns `ok: true`, or it returns
 * `ok: false` with a human-readable `reason` that the caller turns into a format retry.
 *
 * Strictness, deliberately asymmetric:
 * - the VERDICT and finding lines must match SPEC's regexes exactly (em dash included);
 * - the VERDICT line may appear anywhere and findings are collected from the whole output,
 *   not just from after it: small models like to lead with prose or to put the verdict last,
 *   and the printed output is re-rendered from the parsed structure so it stays exact anyway;
 * - a line that looks like a finding but does not match is a warning — unless it is the only
 *   kind of finding line present, in which case parsing fails so the caller can retry rather
 *   than silently reporting "no findings".
 */
export function parseReviewOutput(raw: unknown): ParsedReview {
  const warnings: string[] = [];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'the model returned no text', warnings };
  }

  // Normalise CRLF/CR line endings; a stray \r would break every `$`-anchored regex.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());

  let verdictAt = -1;
  let verdict: Verdict | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const m = VERDICT_RE.exec(lines[i]!);
    if (m) {
      verdict = m[1] as Verdict;
      verdictAt = i;
      break;
    }
  }
  if (verdict === undefined || verdictAt < 0) {
    return {
      ok: false,
      reason: 'no line matching `VERDICT: <APPROVE|APPROVE WITH NITS|REQUEST CHANGES>`',
      warnings,
    };
  }

  const findings: Finding[] = [];
  let nearMisses = 0;
  // Which field of the current finding trailing text belongs to; null between findings.
  let open: 'risk' | 'fix' | null = null;
  // Non-empty lines before the verdict that no finding block claimed — pure prose.
  let prose = 0;

  const append = (field: 'risk' | 'fix', text: string): void => {
    const last = findings[findings.length - 1];
    if (!last) return;
    last[field] = last[field] ? `${last[field]} ${text}` : text;
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (i === verdictAt) {
      open = null;
      continue;
    }
    // Markdown decoration is stripped before matching: a bulleted, bolded or headed finding
    // is still a finding, and dropping it silently would understate the review.
    const line = undecorate(lines[i]!);
    if (line === '') {
      open = null;
      continue;
    }

    const finding = FINDING_RE.exec(line);
    if (finding) {
      const lineNo = Number.parseInt(finding[3]!, 10);
      // An absurd line number is not a location; re-rendering it would also change the digits
      // (float precision), so report it as malformed instead of emitting a different number.
      if (!Number.isSafeInteger(lineNo) || lineNo > MAX_LINE_NUMBER) {
        nearMisses += 1;
        warnings.push(`ignored finding with an implausible line number: ${truncate(line, 120)}`);
        open = null;
        continue;
      }
      findings.push({
        severity: finding[1] as Severity,
        file: sanitize(finding[2]!),
        line: lineNo,
        title: sanitize(finding[4]!),
        risk: '',
        fix: '',
      });
      open = null;
      continue;
    }

    if (findings.length > 0) {
      const risk = RISK_RE.exec(line);
      if (risk) {
        append('risk', sanitize(risk[1]!));
        open = 'risk';
        continue;
      }
      const fix = FIX_RE.exec(line);
      if (fix) {
        append('fix', sanitize(fix[1]!));
        open = 'fix';
        continue;
      }
    }

    // Anything carrying a severity token that did not match FINDING_RE is a failed finding,
    // never prose: absorbing it silently is how a BLOCKER goes missing.
    if (NEAR_MISS_RE.test(line) || SEVERITY_TOKEN_RE.test(line)) {
      nearMisses += 1;
      warnings.push(`ignored malformed finding line: ${truncate(line, 120)}`);
      open = null;
      continue;
    }

    // A wrapped Risk:/Fix: continuation line belongs to the field it continues.
    if (open) append(open, sanitize(line));
    else if (i < verdictAt) prose += 1;
  }
  if (prose > 0) warnings.push(`ignored ${prose} line(s) of prose before the VERDICT line`);

  if (findings.length === 0 && nearMisses > 0) {
    return {
      ok: false,
      reason: `${nearMisses} finding line(s) did not match \`[SEVERITY] file:line — title\` and no valid finding was parsed`,
      warnings,
    };
  }

  for (const f of findings) {
    if (!f.risk) warnings.push(`finding ${f.file}:${f.line} has no Risk: line`);
    if (!f.fix) warnings.push(`finding ${f.file}:${f.line} has no Fix: line`);
  }
  if (verdict === 'APPROVE' && findings.length > 0) {
    warnings.push(`verdict APPROVE contradicts ${findings.length} reported finding(s)`);
  }

  // Stable sort, BLOCKER → NIT (SPEC § Review output contract).
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return { ok: true, verdict, findings, warnings };
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * The coverage note printed on STDOUT under the verdict, or `null` when the whole diff was sent.
 *
 * The capping and auto-shrinking warnings are stderr progress lines, and every documented
 * headless usage (`claude -p`, `aw review > out.txt`, a pre-push hook) throws stderr away. A run
 * that reviewed 4 of 11 files then printed a bare `VERDICT: APPROVE` and exited 0 is
 * indistinguishable from a full review — so the part the verdict does NOT cover has to appear
 * next to the verdict itself, on the same stream.
 */
export function coverageNote(args: {
  files: readonly string[];
  omitted: readonly string[];
  truncated: readonly string[];
  sentBytes: number;
  fullBytes: number;
}): string | null {
  const { files, omitted, truncated, sentBytes, fullBytes } = args;
  if (omitted.length === 0 && truncated.length === 0) return null;
  const whole = files.length - omitted.length - truncated.length;
  const lines = [
    `REVIEWED: ${whole} of ${files.length} changed file(s) in full — ` +
      `${kb(sentBytes)} of ${kb(fullBytes)} of the diff was sent to the model.`,
  ];
  if (truncated.length > 0) lines.push(`  cut short: ${truncated.join(', ')}`);
  if (omitted.length > 0) lines.push(`  not sent: ${omitted.join(', ')}`);
  lines.push('  The verdict above does not cover the files listed here.');
  return lines.join('\n');
}

/** Re-render the contract format from parsed data, so stdout is exact even if the model drifted. */
export function formatReview(verdict: Verdict, findings: readonly Finding[]): string {
  const out = [`VERDICT: ${verdict}`];
  for (const f of findings) {
    // Sanitised again here: `formatReview` is exported and its output goes straight to a
    // terminal, so it must not pass control characters through even for findings it did not parse.
    out.push('');
    out.push(`[${f.severity}] ${sanitize(f.file)}:${f.line} — ${sanitize(f.title)}`);
    out.push(`Risk: ${sanitize(f.risk) || NOT_PROVIDED}`);
    out.push(`Fix: ${sanitize(f.fix) || NOT_PROVIDED}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

/**
 * `core.quotePath=false` is not optional: with git's default, a path containing any non-ASCII
 * byte comes back C-quoted (`"src/\303\274r\303\274n.ts"`), which matches nothing as a pathspec
 * and is unusable as a `read_file` argument in the prompt.
 */
async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repoRoot,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  return stdout;
}

function byteLen(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Head slice of `text` that fits in `maxBytes`, cut on a line boundary and never in the
 * middle of a UTF-8 sequence (`String.prototype.slice` counts UTF-16 units, not bytes).
 */
function sliceBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  const cut = buf.subarray(0, end).toString('utf8');
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > 0 ? cut.slice(0, lastNewline + 1) : cut;
}

function gitStderr(err: unknown): string {
  const e = err as { stderr?: string };
  return (e.stderr ?? '').trim() || messageOf(err);
}

/**
 * Indices of the per-file diffs that fit whole in `maxBytes`, chosen smallest first (T14).
 *
 * Order matters only for *selection* — the diff is still emitted in file order. Filling the
 * budget in `git diff --name-only` order means alphabetically early files win, and in the T14
 * acceptance run that was 13 KB of generated `.claude/*.md` crowding out every `src/` file:
 * the reviewer never saw `src/App.tsx` and reported a confident finding about a route handler
 * that was in the part it had not been sent. Smallest-first maximises how many complete file
 * diffs the model actually gets.
 *
 * The returned indices are ascending, so the caller can pack in place.
 */
export function fitWhole(sizes: readonly number[], maxBytes: number): number[] {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]! || a - b);
  const picked: number[] = [];
  let used = 0;
  for (const i of order) {
    if (sizes[i]! <= maxBytes - used) {
      picked.push(i);
      used += sizes[i]!;
    }
  }
  return picked.sort((a, b) => a - b);
}

interface CollectedDiff {
  text: string;
  /** Files whose diff is not in `text` at all. */
  omitted: string[];
  /** Files present in `text` but cut short. */
  truncated: string[];
  /** Byte size of the complete `git diff`, before any capping. */
  fullBytes: number;
}

/**
 * Build the diff text handed to the model, capped at 60 KB (T08 step 3).
 *
 * The budget is *filled*, not abandoned: whole per-file diffs are included while they fit,
 * and the first file that does not fit contributes a head slice of its own diff instead of
 * being dropped. Dropping it (the previous behaviour) meant one 80 KB file could reduce the
 * reviewed material to a few hundred bytes while the workflow still returned a confident verdict.
 */
async function collectDiff(
  repoRoot: string,
  base: string,
  files: string[],
  maxBytes: number = MAX_DIFF_BYTES,
): Promise<CollectedDiff> {
  const full = await git(repoRoot, ['diff', `${base}...HEAD`]);
  const fullBytes = byteLen(full);
  if (fullBytes <= maxBytes) {
    return { text: full, omitted: [], truncated: [], fullBytes };
  }

  const chunks: { file: string; text: string; size: number }[] = [];
  for (const file of files) {
    const text = await git(repoRoot, ['diff', `${base}...HEAD`, '--', file]);
    // No per-file diff (a mode-only change): nothing to include and nothing left out either,
    // so it is not reported as an omission.
    if (!text) continue;
    chunks.push({ file, text, size: byteLen(text) });
  }

  const packed: (string | null)[] = chunks.map(() => null);
  const omitted: string[] = [];
  const truncated: string[] = [];
  let used = 0;

  // Pass 1: as many whole per-file diffs as the budget holds, smallest first. Done before any
  // truncation so that one oversized file cannot push the small files behind it out of the review.
  for (const i of fitWhole(chunks.map((c) => c.size), maxBytes)) {
    packed[i] = chunks[i]!.text;
    used += chunks[i]!.size;
  }
  // Pass 2: spend whatever budget is left on head slices of the files that did not fit.
  chunks.forEach((chunk, i) => {
    if (packed[i] !== null) return;
    const remaining = maxBytes - used;
    if (remaining < MIN_SLICE_BYTES) {
      omitted.push(chunk.file);
      return;
    }
    // The marker itself costs bytes; leave room for it inside the budget.
    const head = sliceBytes(chunk.text, remaining - 64);
    packed[i] = `${head}…[diff for ${chunk.file} truncated]\n`;
    used += byteLen(head);
    truncated.push(chunk.file);
  });
  const parts = packed.filter((p): p is string => p !== null);

  // Nothing could be packed per file (e.g. a single oversized file): send a head of the whole
  // diff rather than nothing. Those files are truncated, not omitted.
  if (parts.length === 0) {
    return {
      text: `${sliceBytes(full, maxBytes)}…[diff truncated]`,
      omitted: [],
      truncated: [...files],
      fullBytes,
    };
  }
  return { text: parts.join(''), omitted, truncated, fullBytes };
}

function buildPrompt(args: {
  repoRoot: string;
  base: string;
  files: string[];
  diff: string;
  omitted: string[];
  truncated: string[];
  maxBytes?: number;
}): string {
  const { repoRoot, base, files, diff, omitted, truncated, maxBytes = MAX_DIFF_BYTES } = args;
  const parts = [
    `Repository: ${repoRoot}`,
    `Base ref: ${base} (the diff below is \`git diff ${base}...HEAD\`)`,
    '',
    `Changed files (${files.length}):`,
    ...files.map((f) => `- ${f}`),
  ];
  if (omitted.length > 0 || truncated.length > 0) {
    parts.push('', `Diff capped at ${Math.round(maxBytes / 1024)} KB.`);
  }
  if (truncated.length > 0) {
    parts.push(
      'Included below but cut short — read the rest with read_file/git_diff before judging them:',
      ...truncated.map((f) => `- ${f}`),
    );
  }
  if (omitted.length > 0) {
    parts.push(
      'Not included below at all (use read_file/git_diff if you need them):',
      ...omitted.map((f) => `- ${f}`),
    );
  }
  parts.push(
    '',
    '```diff',
    diff.trimEnd(),
    '```',
    '',
    'Review this diff. Use read_file/grep to read surrounding context of changed files',
    'before judging. Then output in the exact VERDICT format:',
    '',
    'VERDICT: <APPROVE | APPROVE WITH NITS | REQUEST CHANGES>',
    '',
    '[SEVERITY] path/to/file.ts:LINE — one-line title',
    'Risk: why this matters in practice.',
    'Fix: concrete change.',
    '',
    'Rules for the answer, no exceptions:',
    '- the first line is the VERDICT line; no preamble, summary, markdown headings or code fences;',
    '- the separator between `file:line` and the title is an em dash ("—"), not a hyphen;',
    '- severity is one of BLOCKER, MAJOR, MINOR, NIT, in square brackets;',
    '- every finding is exactly three lines: the header, then `Risk:`, then `Fix:`;',
    '- REQUEST CHANGES requires at least one finding in that format — prose findings do not count;',
    '- never ask questions.',
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

function timeoutMs(): number {
  const raw = Number.parseInt(process.env.AW_REVIEW_TIMEOUT_MS?.trim() ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * T08 — `aw review`: diff a branch against its base and have the code-reviewer agent
 * judge it. Headless-safe: reads nothing from stdin, prints the contract format to stdout
 * and everything else to stderr.
 *
 * Terminal shortcuts (they exit the process rather than returning):
 * - `claude-cli` selected → exit 1, no model call is made;
 * - unusable base ref / not a repo → exit 1;
 * - empty diff → prints `nothing to review`, exit 0;
 * - format still broken after one retry → exit 1, printing the raw text.
 */
export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const cfg = loadConfig(opts);

  // Checked on the raw flag *before* resolveModel: `--provider claude-cli` without `--model`
  // resolves to "model required: ..." (SPEC § Model resolution), which would mask the real
  // reason the provider is unusable here. Refused before any diff, model call or cost.
  if (opts.provider?.trim() === 'claude-cli') fail(CLAUDE_CLI_REFUSAL);
  const { provider, model } = resolveModel('code-reviewer', opts, cfg);
  if (provider === 'claude-cli') fail(CLAUDE_CLI_REFUSAL);

  const repoRoot = cfg.repoRoot;
  if (!fs.existsSync(repoRoot)) fail(`repoRoot does not exist: ${repoRoot}`);
  try {
    await git(repoRoot, ['rev-parse', '--git-dir']);
  } catch (err) {
    fail(`not a git repository: ${repoRoot} (${gitStderr(err)})`);
  }

  let base = opts.base?.trim() || 'main';
  try {
    await git(repoRoot, ['rev-parse', '--verify', `${base}^{commit}`]);
  } catch {
    // A shallow/single-branch CI clone has `origin/main` but no local `main`, and `main` is
    // the default base — try the remote-tracking ref once before giving up, and say so.
    let recovered = false;
    if (!base.includes('/')) {
      try {
        await git(repoRoot, ['rev-parse', '--verify', `origin/${base}^{commit}`]);
        log(`base ref "${base}" not found locally — using "origin/${base}"`);
        base = `origin/${base}`;
        recovered = true;
      } catch {
        recovered = false;
      }
    }
    if (!recovered) {
      fail(
        `unknown base ref "${base}" in ${repoRoot} — pass an existing branch or commit with --base`,
      );
    }
  }

  let files: string[];
  let diff: CollectedDiff;
  try {
    // `-z` gives NUL-separated raw paths, so a non-ASCII path is never C-quoted.
    files = (await git(repoRoot, ['diff', '--name-only', '-z', `${base}...HEAD`]))
      .split('\0')
      .map((f) => f.trim())
      .filter(Boolean);
    diff = await collectDiff(repoRoot, base, files);
  } catch (err) {
    return fail(`git diff ${base}...HEAD failed in ${repoRoot}: ${gitStderr(err)}`);
  }

  if (diff.text.trim() === '') {
    write(1, 'nothing to review');
    process.exit(0);
  }

  const agent = loadAgent('code-reviewer');
  const tools = makeCoreTools('reviewer', repoRoot);

  /** Current diff budget; halved below when the provider says the prompt does not fit. */
  let budget = MAX_DIFF_BYTES;
  let prompt = buildPrompt({
    repoRoot,
    base,
    files,
    diff: diff.text,
    omitted: diff.omitted,
    truncated: diff.truncated,
    maxBytes: budget,
  });

  const announce = (): void => {
    const sentBytes = byteLen(diff.text);
    log(
      `reviewing ${files.length} file(s) against ${base} — ${provider}/${model}, ` +
        `${sentBytes} B of diff` +
        (diff.fullBytes > sentBytes ? ` (of ${diff.fullBytes} B total)` : ''),
    );
    // A near-blind review must be visible to the caller, not hidden inside a byte count.
    if (diff.truncated.length > 0) {
      log(
        `warning: diff over ${Math.round(budget / 1024)} KB — cut short: ${diff.truncated.join(', ')}`,
      );
    }
    if (diff.omitted.length > 0) {
      log(
        `warning: diff over ${Math.round(budget / 1024)} KB — not sent: ${diff.omitted.join(', ')}`,
      );
    }
  };
  announce();

  /** One model call. Returns the error instead of exiting, so the caller can shrink and retry. */
  const attempt = async (
    text: string,
  ): Promise<{ ok: true; text: string } | { ok: false; err: unknown }> => {
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: getModel(provider, model),
        system: agent.system,
        prompt: text,
        tools,
        stopWhen: stepCountIs(MAX_STEPS),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(timeoutMs()),
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
      return { ok: false, err };
    }
    log(`model finished in ${result.steps.length} step(s)`);
    return { ok: true, text: result.text ?? '' };
  };

  /**
   * Ask, and if the provider rejects the prompt as too long for its context, halve the diff
   * budget and ask again (T14).
   *
   * A 60 KB cap is a cap, not a promise that the model can read 60 KB: LM Studio serving a
   * 30B model with an 8192-token context answered this branch's 25 KB diff with a bare
   * `400 Bad Request`, and the whole review was lost. Shrinking is strictly better than that —
   * the prompt already tells the reviewer which files were cut short, and it has `read_file`
   * and `git_diff` to fetch the rest itself.
   */
  const ask = async (suffix = ''): Promise<string> => {
    for (let shrinks = 0; ; shrinks += 1) {
      const result = await attempt(`${prompt}${suffix}`);
      if (result.ok) return result.text;

      const room = Math.min(budget, diff.fullBytes);
      const canShrink =
        isContextOverflowError(result.err) &&
        shrinks < MAX_DIFF_SHRINKS &&
        Math.floor(room / 2) >= MIN_DIFF_BUDGET_BYTES;
      if (!canShrink) {
        return fail(
          describeModelFailure(result.err, provider, {
            activity: 'the review',
            timeoutMs: timeoutMs(),
          }) +
            (isContextOverflowError(result.err)
              ? // The bytes actually sent, not the budget: the last attempt usually carries less
                // than its cap, and quoting the cap overstates what the model was asked to read.
                `\n  The diff does not fit this model's context even at ${byteLen(diff.text)} B.` +
                '\n  Load the model with a larger context length, or review a narrower range with --base.'
              : ''),
        );
      }
      budget = Math.floor(room / 2);
      log(
        `warning: ${provider} rejected the prompt as too long for its context — ` +
          `retrying with the diff capped at ${Math.round(budget / 1024)} KB`,
      );
      try {
        diff = await collectDiff(repoRoot, base, files, budget);
      } catch (err) {
        return fail(`git diff ${base}...HEAD failed in ${repoRoot}: ${gitStderr(err)}`);
      }
      prompt = buildPrompt({
        repoRoot,
        base,
        files,
        diff: diff.text,
        omitted: diff.omitted,
        truncated: diff.truncated,
        maxBytes: budget,
      });
      announce();
    }
  };

  let raw = await ask();
  let parsed = parseReviewOutput(raw);

  // T08 step 5: exactly one format retry. "REQUEST CHANGES with nothing to change" counts as
  // a format problem too — the model described its findings in prose instead of emitting them.
  const unusable = (p: ParsedReview): string | null => {
    if (!p.ok) return p.reason;
    if (p.verdict === 'REQUEST CHANGES' && p.findings.length === 0) {
      return 'verdict REQUEST CHANGES with no parseable finding';
    }
    return null;
  };

  // The text of the newest attempt, whether it was accepted or not — the failure message
  // below must show what the model actually said last, not the attempt before it.
  let lastRaw = raw;
  const firstProblem = unusable(parsed);
  if (firstProblem) {
    log(`raw model output:\n${raw}`);
    log(`format retry: ${firstProblem}`);
    const retryRaw = await ask(`\n\n${RETRY_NOTE}`);
    lastRaw = retryRaw;
    const retryParsed = parseReviewOutput(retryRaw);
    const retryProblem = unusable(retryParsed);
    if (retryProblem) log(`retry model output:\n${retryRaw}`);
    // Never throw away a usable first answer for a worse retry.
    if (!retryProblem || (retryParsed.ok && !parsed.ok)) {
      raw = retryRaw;
      parsed = retryParsed;
    }
  }

  if (!parsed.ok) {
    fail(
      `review output does not match the required format after one retry: ${parsed.reason}\n` +
        `--- raw model output (last attempt) ---\n${lastRaw}\n--- end raw model output ---`,
    );
  }
  const remaining = unusable(parsed);
  if (remaining) log(`warning: accepted after retry — ${remaining}`);

  for (const warning of parsed.warnings) log(`warning: ${warning}`);
  if (parsed.verdict === 'APPROVE' && hasBlocker(parsed.findings)) {
    log('warning: verdict APPROVE overrides the reported BLOCKER — exit code stays 0');
  }
  console.log(formatReview(parsed.verdict, parsed.findings));

  // On stdout, under the verdict: a partial review must not read like a complete one.
  const coverage = coverageNote({
    files,
    omitted: diff.omitted,
    truncated: diff.truncated,
    sentBytes: byteLen(diff.text),
    fullBytes: diff.fullBytes,
  });
  if (coverage) {
    console.log('');
    console.log(coverage);
  }

  return { verdict: parsed.verdict, findings: parsed.findings, raw };
}

/** SPEC § exit codes: `2` when the review found a BLOCKER. */
export function hasBlocker(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'BLOCKER');
}
