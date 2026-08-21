import fs from 'node:fs';
import path from 'node:path';
import { generateText, stepCountIs } from 'ai';
import type { ToolSet } from 'ai';
import { TestCase } from '../../shared/schemas';
import type { AwConfig, Severity } from '../../shared/schemas';
import { loadAgent } from '../agents';
import { loadConfig, resolveModel } from '../config';
import { getModel } from '../providers/index';
import { makeCoreTools } from '../tools/core';
import { closeBrowser, makeBrowserTools } from '../tools/browser';
import { ensureUp, isLocalUrl, probeUrl, slugify, type EnsureUpHandle } from '../util';

export interface TestFeatureOptions {
  desc: string;
  url?: string;
  allowDestructive?: boolean;
  provider?: string;
  model?: string;
  config?: string;
  workspace?: string;
}

export interface TestFeatureResult {
  reportPath: string;
  target: string;
  cases: TestCase[];
  summary: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

/** T09 step 5: the tester gets more room than the reviewer — one step per case, plus setup. */
const MAX_STEPS = 40;

/** SPEC § Agent session loop: tool calls/results are logged truncated to 2 KB. */
const LOG_CAP = 2 * 1024;

/**
 * Whole-session guard. 40 steps against a local model at 10–90 s each is ~60 min worst case,
 * so the default sits just above it. Override with `AW_TEST_TIMEOUT_MS`.
 */
const DEFAULT_TIMEOUT_MS = 3_900_000;

/** Reachability probe budget (T09 step 3). */
const PROBE_TIMEOUT_MS = 5_000;
const START_WAIT_MS = 60_000;
const START_POLL_MS = 2_000;

/**
 * The plan section is model prose — and when it comes from the session narration it is prose a
 * stuck model may have restated a dozen times. A plan longer than this is padding, not plan.
 */
const MAX_PLAN_CHARS = 4 * 1024;
/** Per-field cap for request/response text quoted into the report. */
const MAX_FIELD_CHARS = 8 * 1024;
/** Longest slug used in a report filename (leaves room for the date and a `-12` suffix). */
const MAX_SLUG_CHARS = 80;
/** SPEC § tail format: the summary is "3 lines max". */
const MAX_SUMMARY_LINES = 3;

/**
 * Consecutive identical tool calls that mean the agent is stuck rather than working.
 * Observed: a 30B local model issuing `git_log {"limit":5}` twenty times in a row until the
 * step budget ran out, producing no output at all.
 */
const LOOP_LIMIT = 5;
/** Per-line cap of the tool log replayed to the format retry. */
const EVIDENCE_LINE_CAP = 600;
/** Total cap of that log (the tail is kept: the newest evidence is the relevant evidence). */
const MAX_EVIDENCE_CHARS = 24 * 1024;
/** Cap of the model's own prose replayed to the format retry. */
const MAX_NARRATION_CHARS = 8 * 1024;

/** SPEC § Agent session loop — `claude-cli` silently ignores AI SDK tools, so refuse it. */
export const CLAUDE_CLI_REFUSAL =
  'provider "claude-cli" cannot run tool-using workflows: it does not execute AI SDK tools.\n' +
  '  Use --provider anthropic (set ANTHROPIC_API_KEY), or the Claude Code native path (.claude/ commands).';

/** C0/C1 control characters: an ANSI escape in model output can rewrite the terminal. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

/**
 * Write straight to the fd: `process.exit()` can drop output still queued on a pipe, and
 * every message this module prints is either the result or the reason for an exit.
 */
function write(fd: 1 | 2, line: string): void {
  try {
    fs.writeSync(fd, `${line}\n`);
  } catch {
    // A closed/blocked stdio stream must never mask the actual test outcome.
  }
}

/** Progress + tool logging. Always stderr, so stdout stays parseable. */
function log(line: string): void {
  write(2, line);
}

/** Print to stderr and exit 1 — a workflow failure never surfaces a stack trace. */
function fail(message: string): never {
  write(2, message);
  process.exit(1);
}

function truncate(value: string, limit = LOG_CAP): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Drop control characters but keep newlines and tabs — reports are multi-line by design. */
function clean(text: string): string {
  return text.replace(CONTROL_RE, '');
}

/** Single-line form: control characters and newlines all collapse to spaces. */
function oneLine(text: string): string {
  return clean(text).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// ===CASES=== / ===SUMMARY=== tail parser
// ---------------------------------------------------------------------------

/** A case object the model emitted that could not be validated. Never silently dropped. */
export interface RejectedCase {
  /** Index in the emitted array. */
  index: number;
  reason: string;
  /** The raw JSON of the entry, so the report can still show what the model claimed. */
  raw: string;
}

export type ParsedCases =
  | {
      ok: true;
      /** Everything the model wrote before `===CASES===` — the test plan and its narration. */
      plan: string;
      cases: TestCase[];
      /** At most 3 lines; empty when the model omitted `===SUMMARY===`. */
      summary: string;
      rejected: RejectedCase[];
      warnings: string[];
    }
  | { ok: false; reason: string; warnings: string[] };

const CASES_MARKER_RE = /^=+\s*CASES\s*=+$/i;
const SUMMARY_MARKER_RE = /^=+\s*SUMMARY\s*=+$/i;
const FENCE_RE = /^(?:```|~~~)\w*$/;

/**
 * Everything before the first `===CASES===` line. Used on the step-by-step narration that
 * backs the report's plan section, so a half-written tail in an intermediate step never
 * lands in the report as prose.
 */
export function stripTail(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const at = lines.findIndex((l) => CASES_MARKER_RE.test(undecorate(l)));
  return clean((at < 0 ? lines : lines.slice(0, at)).join('\n')).trim();
}

/** Strip the markdown decoration a model may wrap a marker line in (`**===CASES===**`). */
function undecorate(line: string): string {
  return line.trim().replace(/^[>*_`#\s-]+/, '').replace(/[*_`\s]+$/, '').trim();
}

/**
 * Small models write `"PASSED"` as often as `"PASS"`. Normalising the obvious synonyms costs
 * nothing and keeps a real result from being thrown away; anything genuinely unrecognised is
 * left alone so zod rejects the case and the caller can retry.
 */
const STATUS_ALIASES: Record<string, string> = {
  PASS: 'PASS',
  PASSED: 'PASS',
  PASSING: 'PASS',
  OK: 'PASS',
  SUCCESS: 'PASS',
  SUCCEEDED: 'PASS',
  FAIL: 'FAIL',
  FAILED: 'FAIL',
  FAILING: 'FAIL',
  FAILURE: 'FAIL',
  ERROR: 'FAIL',
  SKIP: 'SKIP',
  SKIPPED: 'SKIP',
  'NOT RUN': 'SKIP',
  'NOT-RUN': 'SKIP',
  NA: 'SKIP',
  'N/A': 'SKIP',
};

const KIND_ALIASES: Record<string, string> = {
  happy: 'happy',
  'happy path': 'happy',
  'happy-path': 'happy',
  happypath: 'happy',
  positive: 'happy',
  edge: 'edge',
  'edge case': 'edge',
  'edge-case': 'edge',
  boundary: 'edge',
  invalid: 'invalid',
  'invalid input': 'invalid',
  negative: 'invalid',
  validation: 'invalid',
  auth: 'auth',
  authn: 'auth',
  authz: 'auth',
  authentication: 'auth',
  authorization: 'auth',
  security: 'auth',
};

const SEVERITIES = new Set(['BLOCKER', 'MAJOR', 'MINOR', 'NIT']);

/**
 * Balanced `[...]` / `{...}` slice starting at the first bracket, string- and escape-aware.
 * This is what makes trailing prose after the JSON harmless: the scan stops at the closing
 * bracket instead of handing the rest of the model's chatter to `JSON.parse`.
 */
function extractJsonValue(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Remove `,` that sits directly before `}` or `]` — the most common JSON slip a model makes. */
function stripTrailingCommas(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j += 1;
      if (json[j] === '}' || json[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** Model fields arrive as objects as often as strings; keep both, never `[object Object]`. */
function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return clean(value).trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return clean(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

function asSteps(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const steps = list.map((s) => asText(s)).filter((s): s is string => Boolean(s));
  return steps.length > 0 ? steps : undefined;
}

/**
 * Parse the required tail of the tester's output.
 *
 * Contract: this function NEVER throws. Either it returns `ok: true`, or `ok: false` with a
 * `reason` the caller turns into its single format retry.
 *
 * Tolerated, because a 30B local model produces all of them and none changes the meaning:
 * CRLF line endings, markdown decoration around the markers, a ```json fence around the array,
 * prose after the closing bracket, a single case object instead of a one-element array,
 * trailing commas, and status/kind synonyms.
 *
 * Not tolerated — these fail so the caller retries rather than reporting a half-truth:
 * a missing `===CASES===` marker, unbalanced or unparseable JSON, an empty array, and a case
 * list in which every entry is invalid. A *missing* `===SUMMARY===` is only a warning: the
 * cases are the result, and the caller can always synthesise a count.
 */
export function parseCasesOutput(raw: unknown): ParsedCases {
  const warnings: string[] = [];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'the model returned no text', warnings };
  }

  // Normalise CRLF/CR first: every marker regex below is line-anchored, and a stray \r
  // would leave `===CASES===\r` matching nothing.
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  // The prompt itself shows the markers, so a model that echoes the template before doing the
  // real work emits them twice; the LAST block is the answer.
  let casesAt = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (CASES_MARKER_RE.test(undecorate(lines[i]!))) {
      casesAt = i;
      break;
    }
  }

  let summaryAt = -1;
  for (let i = casesAt + 1; i < lines.length; i += 1) {
    if (SUMMARY_MARKER_RE.test(undecorate(lines[i]!))) {
      summaryAt = i;
      break;
    }
  }

  if (casesAt < 0) {
    // Observed twice on the format retry: the model drops the marker line(s) and answers with
    // the bare JSON array. Nothing is lost by looking for the array anyway — validation below
    // is strict (every entry must be an object with a usable `status`), so prose that merely
    // contains a bracket still fails, just with a more accurate reason than "no marker".
    warnings.push(
      summaryAt < 0
        ? 'no `===CASES===` marker — parsed the whole output as the case list'
        : 'no `===CASES===` marker — read the text before `===SUMMARY===` as the cases',
    );
  }
  if (summaryAt < 0) warnings.push('no `===SUMMARY===` marker — summary generated from the counts');

  // With no `===CASES===` line there is no prose/JSON boundary to split on, so the plan is
  // empty and the caller falls back to the session narration.
  const plan = casesAt < 0 ? '' : clean(lines.slice(0, casesAt).join('\n')).trim();
  const blockLines = lines.slice(casesAt + 1, summaryAt < 0 ? lines.length : summaryAt);
  // A fenced block is fine; dropping only whole-line fences keeps ``` inside a JSON string safe.
  const block = blockLines.filter((l) => !FENCE_RE.test(l.trim())).join('\n');

  const jsonText = extractJsonValue(block);
  if (jsonText === null) {
    const where = casesAt < 0 ? 'the output' : 'the ===CASES=== block';
    return {
      ok: false,
      reason: block.trim()
        ? `${where} contains no balanced JSON array or object`
        : `${where} is empty`,
      warnings,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (firstError) {
    try {
      value = JSON.parse(stripTrailingCommas(jsonText));
      warnings.push('repaired trailing comma(s) in the ===CASES=== JSON');
    } catch {
      return {
        ok: false,
        reason: `the ===CASES=== block is not valid JSON: ${messageOf(firstError)}`,
        warnings,
      };
    }
  }

  let entries: unknown[];
  if (Array.isArray(value)) {
    entries = value;
  } else if (value !== null && typeof value === 'object') {
    entries = [value];
    warnings.push('===CASES=== held a single object instead of an array — wrapped it');
  } else {
    return { ok: false, reason: '===CASES=== is neither an array nor an object', warnings };
  }
  if (entries.length === 0) {
    return { ok: false, reason: 'the ===CASES=== array is empty — no case was reported', warnings };
  }

  const cases: TestCase[] = [];
  const rejected: RejectedCase[] = [];
  entries.forEach((entry, index) => {
    const rawEntry = truncate(JSON.stringify(entry ?? null), MAX_FIELD_CHARS);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      rejected.push({ index, reason: 'not a JSON object', raw: rawEntry });
      return;
    }
    const source = entry as Record<string, unknown>;

    const rawStatus = asText(source.status ?? source.result ?? source.outcome) ?? '';
    const status = STATUS_ALIASES[rawStatus.toUpperCase()] ?? rawStatus;
    if (!status) {
      rejected.push({ index, reason: 'no "status" field', raw: rawEntry });
      return;
    }
    if (status !== rawStatus.toUpperCase() && status !== rawStatus) {
      warnings.push(`case ${index}: status "${rawStatus}" read as ${status}`);
    }

    const rawKind = (asText(source.kind ?? source.type ?? source.category) ?? '').toLowerCase();
    let kind = KIND_ALIASES[rawKind];
    if (!kind) {
      // `kind` only groups the report; a bad one must not cost a graded result.
      kind = 'edge';
      warnings.push(
        `case ${index}: kind ${rawKind ? `"${rawKind}"` : '(missing)'} not recognised — recorded as "edge"`,
      );
    }

    const rawSeverity = (asText(source.severity) ?? '').toUpperCase();
    const severity = SEVERITIES.has(rawSeverity) ? (rawSeverity as Severity) : undefined;
    if (rawSeverity && !severity) {
      warnings.push(`case ${index}: unknown severity "${rawSeverity}" — dropped`);
    }

    const candidate = {
      id: asText(source.id ?? source.caseId) ?? `case-${index + 1}`,
      name: asText(source.name ?? source.title ?? source.description) ?? `case ${index + 1}`,
      kind,
      status,
      request: asText(source.request),
      response: asText(source.response),
      reproSteps: asSteps(source.reproSteps ?? source.repro_steps ?? source.steps),
      severity,
    };

    const parsed = TestCase.safeParse(candidate);
    if (!parsed.success) {
      rejected.push({
        index,
        reason: parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
        raw: rawEntry,
      });
      return;
    }
    cases.push(parsed.data);
  });

  if (cases.length === 0) {
    return {
      ok: false,
      reason: `all ${entries.length} case object(s) were invalid: ${rejected
        .map((r) => `[${r.index}] ${r.reason}`)
        .join('; ')}`,
      warnings,
    };
  }
  for (const r of rejected) warnings.push(`case ${r.index} dropped — ${r.reason}`);

  const summaryLines = (summaryAt < 0 ? [] : lines.slice(summaryAt + 1))
    .filter((l) => !FENCE_RE.test(l.trim()))
    .map((l) => clean(l).trim())
    .filter(Boolean);
  if (summaryLines.length > MAX_SUMMARY_LINES) {
    warnings.push(
      `summary was ${summaryLines.length} lines — kept the first ${MAX_SUMMARY_LINES}`,
    );
  }
  const summary = summaryLines.slice(0, MAX_SUMMARY_LINES).join('\n');

  return { ok: true, plan, cases, summary, rejected, warnings };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}

export function countCases(cases: readonly TestCase[]): Counts {
  return {
    passed: cases.filter((c) => c.status === 'PASS').length,
    failed: cases.filter((c) => c.status === 'FAIL').length,
    skipped: cases.filter((c) => c.status === 'SKIP').length,
    total: cases.length,
  };
}

const URL_IN_TEXT_RE = /\bhttps?:\/\/[^\s"'`<>)\]},]+/gi;

/**
 * Origins the cases claim to have called that are not the target.
 *
 * Observed with a 30B local model pointed at a dead port: rather than reporting the target as
 * unreachable, it started the real app itself and graded 8 cases against *that* — a report
 * headed "Target: http://localhost:9" whose every request said `:3001`. The evidence is not
 * wrong, it is about a different address, and only saying so keeps the report honest.
 */
export function offTargetOrigins(cases: readonly TestCase[], target: string): string[] {
  let targetOrigin: string;
  try {
    targetOrigin = new URL(target).origin;
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const c of cases) {
    for (const text of [c.request, c.response]) {
      if (!text) continue;
      for (const match of text.match(URL_IN_TEXT_RE) ?? []) {
        try {
          const origin = new URL(match).origin;
          if (origin !== targetOrigin) found.add(origin);
        } catch {
          // Not a URL after all; nothing to compare.
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * Turn the plan text into something a human will actually read: drop repeated paragraphs and
 * keep the head.
 *
 * Observed against the wrong-port target: the model re-announced "I'll create a test plan…"
 * on nearly every one of its 40 steps, and the raw narration ran to 8 KB of the same paragraph.
 * The FIRST statement of the plan is the plan; the restatements are the model spinning.
 */
export function condensePlan(text: string): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(trimmed);
  }
  return truncate(kept.join('\n\n'), MAX_PLAN_CHARS);
}

/** A fence long enough that the quoted text cannot close it early. */
function fenced(text: string): string {
  let ticks = 3;
  const runs = text.match(/`{3,}/g) ?? [];
  for (const run of runs) ticks = Math.max(ticks, run.length + 1);
  const fence = '`'.repeat(ticks);
  return `${fence}\n${text}\n${fence}`;
}

/** `YYYY-MM-DD` in local time — the report name must match the day the user ran it. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * T09 step 7: `test-reports/<slug>-<date>.md`, never overwriting — `-2`, `-3`, …
 *
 * The file is *created* here with the `wx` flag rather than probed with `existsSync` first:
 * two runs started in the same second would both see "does not exist" and the second would
 * silently clobber the first report.
 */
export function createReportFile(reportDir: string, desc: string, date = localDate()): string {
  fs.mkdirSync(reportDir, { recursive: true });
  let slug = slugify(desc).slice(0, MAX_SLUG_CHARS).replace(/-$/, '');
  if (!slug) slug = 'test';
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const file = path.join(reportDir, `${slug}-${date}${suffix}.md`);
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

export interface ReportInput {
  desc: string;
  target: string;
  provider: string;
  model: string;
  plan: string;
  cases: readonly TestCase[];
  rejected: readonly RejectedCase[];
  summary: string;
  warnings: readonly string[];
  startedAt: Date;
  autoStarted?: string;
}

/** Render the markdown report. Pure — `runTestFeature` only supplies the data. */
export function renderReport(input: ReportInput): string {
  const counts = countCases(input.cases);
  const out: string[] = [];

  out.push(`# Test report — ${oneLine(input.desc)}`);
  out.push('');
  out.push(`- **Target:** ${input.target}`);
  out.push(`- **Agent:** qa-tester (${input.provider}/${input.model})`);
  out.push(`- **Run at:** ${input.startedAt.toISOString()}`);
  out.push(
    `- **Result:** PASS ${counts.passed}/${counts.total}` +
      (counts.failed ? ` — ${counts.failed} FAIL` : '') +
      (counts.skipped ? ` — ${counts.skipped} SKIP` : ''),
  );
  if (input.autoStarted) out.push(`- **App started by this run:** \`${input.autoStarted}\``);
  const offTarget = offTargetOrigins(input.cases, input.target);
  if (offTarget.length > 0) {
    out.push(
      `- **Evidence is off target:** some cases record requests against ${offTarget
        .map((o) => `\`${o}\``)
        .join(', ')}, not \`${input.target}\`. Read the cases before trusting the result.`,
    );
  }
  out.push('');

  out.push('## Test plan');
  out.push('');
  const plan = condensePlan(input.plan);
  out.push(plan || '_The agent recorded no plan before the case list._');
  out.push('');

  out.push('## Cases');
  out.push('');
  input.cases.forEach((c, i) => {
    out.push(`### ${i + 1}. ${oneLine(c.name)} — ${c.status}`);
    out.push('');
    out.push(`- id: \`${oneLine(c.id)}\``);
    out.push(`- kind: ${c.kind}`);
    if (c.severity) out.push(`- severity: ${c.severity}`);
    out.push('');
    // SPEC/agent contract: a failure without its exact request and response is not a finding
    // anyone can act on, so the gap is stated instead of being left blank.
    const needsEvidence = c.status === 'FAIL';
    if (c.request) {
      out.push('Request:');
      out.push('');
      out.push(fenced(truncate(c.request, MAX_FIELD_CHARS)));
      out.push('');
    } else if (needsEvidence) {
      out.push('Request: _not recorded by the agent._');
      out.push('');
    }
    if (c.response) {
      out.push('Response:');
      out.push('');
      out.push(fenced(truncate(c.response, MAX_FIELD_CHARS)));
      out.push('');
    } else if (needsEvidence) {
      out.push('Response: _not recorded by the agent._');
      out.push('');
    }
    if (c.reproSteps?.length) {
      out.push('Repro steps:');
      out.push('');
      c.reproSteps.forEach((s, n) => out.push(`${n + 1}. ${oneLine(s)}`));
      out.push('');
    }
  });

  if (input.rejected.length > 0) {
    out.push('## Unparseable cases');
    out.push('');
    out.push('The agent emitted these entries; they did not match the `TestCase` shape and are');
    out.push('reproduced verbatim rather than dropped.');
    out.push('');
    for (const r of input.rejected) {
      out.push(`- entry ${r.index} — ${oneLine(r.reason)}`);
      out.push('');
      out.push(fenced(r.raw));
      out.push('');
    }
  }

  out.push('## Summary');
  out.push('');
  out.push(input.summary.trim() || `PASS ${counts.passed}/${counts.total}.`);
  out.push('');

  if (input.warnings.length > 0) {
    out.push('## Parser notes');
    out.push('');
    for (const w of input.warnings) out.push(`- ${oneLine(w)}`);
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('_Findings only — this run changed no application code._');
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// target resolution
// ---------------------------------------------------------------------------

/** Origin + path with any trailing `/` removed, so `<target><healthPath>` never doubles up. */
function normalizeTarget(url: URL): string {
  const text = `${url.origin}${url.pathname}${url.search}`;
  return text.replace(/\/+$/, '') || url.origin;
}

function joinUrl(target: string, suffix: string): string {
  if (!suffix || suffix === '/') return target || '/';
  return `${target}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
}

/** Default port for a URL that names none, so `http://host` and `http://host:80` compare equal. */
function portOf(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && portOf(a) === portOf(b);
}

/**
 * Whether the target is the backend this config knows how to start.
 *
 * This is what keeps `--url http://localhost:9` from booting the real API on 3001 and then
 * failing the run: an explicit URL that is not the configured backend is simply tested as it
 * is, and its refused connections become FAIL cases (T09 Acceptance 2).
 */
function targetsConfiguredBackend(target: URL, cfg: AwConfig): boolean {
  const backend = cfg.app?.backend;
  if (!backend) return false;
  if (portOf(target) === String(backend.port)) return true;
  const base = cfg.app?.baseUrl?.trim();
  if (!base) return false;
  try {
    return sameOrigin(target, new URL(base));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

function buildPrompt(args: {
  desc: string;
  target: string;
  healthUrl?: string;
  repoRoot: string;
  cfg: AwConfig;
  allowDestructive: boolean;
  reachable: boolean;
}): string {
  const { desc, target, healthUrl, repoRoot, cfg, allowDestructive, reachable } = args;
  const account = cfg.app?.testAccount;
  const parts = [
    'Feature or bug report to verify:',
    desc,
    '',
    `Target under test: ${target}`,
  ];
  if (healthUrl) parts.push(`Health endpoint: ${healthUrl}`);
  parts.push(`Source repository (read-only reference): ${repoRoot}`);
  if (account) {
    // SPEC § AwConfig: the password lives in an env var and is NEVER stored or echoed.
    parts.push(
      `Test account: user "${account.user}"; the password is in environment variable ` +
        `${account.passEnv} (read it inside a bash command as "$${account.passEnv}"). ` +
        'Never print the password into the report.',
    );
  } else {
    parts.push('Test account: none configured — do not invent credentials.');
  }
  if (cfg.offLimits?.length) {
    parts.push(`Off limits (never touch): ${cfg.offLimits.join(', ')}`);
  }
  parts.push(
    allowDestructive
      ? 'Destructive HTTP methods are permitted against this target (--allow-destructive).'
      : 'POST/PUT/PATCH/DELETE are blocked against non-local hosts; localhost is exempt.',
  );
  if (!reachable) {
    // Observed with the 30B local model: told the target was down, it hunted for the app on
    // other ports, started it with `npm run dev:api` through the bash tool, and graded 8 cases
    // against that address instead — a confident PASS report about a URL nobody asked about.
    parts.push(
      `NOTE: ${target} did not answer a probe before this session started. If it stays ` +
        'unreachable, that IS the result: record the exact failed request and mark the case ' +
        'FAIL. Do not start the app, do not search for it on another port, and do not test any ' +
        'other address — a report about a different URL is worthless.',
    );
  }
  parts.push(
    '',
    'First write the test plan (happy, edge, invalid, auth). Then execute each case. Finally output a JSON block:',
    '',
    '===CASES===',
    '[ { TestCase }, ... ]',
    '===SUMMARY===',
    '<3 lines max>',
    '',
    'Each TestCase object is exactly:',
    '{ "id": "c1", "name": "short case name", "kind": "happy|edge|invalid|auth",',
    '  "status": "PASS|FAIL|SKIP", "request": "METHOD URL + headers + body, verbatim",',
    '  "response": "status code + body, verbatim", "reproSteps": ["step 1", "step 2"],',
    '  "severity": "BLOCKER|MAJOR|MINOR|NIT" }',
    '',
    'Rules for the answer, no exceptions:',
    '- run every case with a real tool call (http_request, bash, or the browser tools) before grading it;',
    '- `request` and `response` are MANDATORY for every FAIL and must be the literal text you saw;',
    '- `severity` is only for FAIL cases;',
    '- you are testing, not fixing: never edit application source, and never report a fix as done;',
    `- every case must be run against ${target} — never against a different host or port;`,
    '- never start, restart or stop the app, and never run a long-running command (a dev server,',
    '  `npm run dev`, a watcher): it would outlive this session and hold the port;',
    '- the ===CASES=== line, the JSON array and the ===SUMMARY=== line are the LAST thing you write;',
    '- no markdown code fence around the JSON, no comments inside it, no text after the summary;',
    '- never ask questions.',
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// session control
// ---------------------------------------------------------------------------

/** Why a session ended early, when it did. */
type StopReason = 'steps' | 'loop' | null;

/** Identity of one step's tool calls; empty when the step called nothing. */
function stepKey(step: { toolCalls?: readonly { toolName: string; input?: unknown }[] }): string {
  return (step.toolCalls ?? [])
    .map((c) => `${c.toolName}:${JSON.stringify(c.input ?? {})}`)
    .join('|');
}

/**
 * Stop condition: the last `LOOP_LIMIT` steps all made the identical tool call.
 *
 * Without it a stuck agent burns its whole step budget — minutes of a local model — and then
 * returns an empty message, which the format retry cannot repair either. Cutting the session
 * here leaves the tool log intact, so the toolless retry can still write a real report.
 */
export function isLooping({
  steps,
}: {
  steps: readonly { toolCalls?: readonly { toolName: string; input?: unknown }[] }[];
}): boolean {
  if (steps.length < LOOP_LIMIT) return false;
  const tail = steps.slice(-LOOP_LIMIT);
  const first = stepKey(tail[0]!);
  if (!first) return false;
  return tail.every((step) => stepKey(step) === first);
}

/** Keep the END of an oversized text: the most recent evidence is the relevant evidence. */
function tailCap(text: string, limit: number): string {
  return text.length <= limit ? text : `…[earlier output dropped]\n${text.slice(-limit)}`;
}

/**
 * Prompt for the single format retry (T09 step 6).
 *
 * It carries the session's own tool log and forbids inventing anything, because the retry runs
 * without tools: the model can only re-describe what the log already proves.
 */
function buildRetryPrompt(args: {
  desc: string;
  target: string;
  evidence: readonly string[];
  narration: string;
}): string {
  const { desc, target, evidence, narration } = args;
  const parts = [
    'You already ran this test session. You have NO tools in this turn — do not attempt to run,',
    'fetch or read anything. Your only job is to re-emit the result in the required format.',
    '',
    `Feature or bug report under test: ${desc}`,
    `Target: ${target}`,
    '',
    'Log of the tool calls you made (`>` = call, `<` = result):',
    tailCap(evidence.join('\n') || '(no tool call was recorded)', MAX_EVIDENCE_CHARS),
  ];
  if (narration.trim()) {
    parts.push('', 'What you wrote during the session:', tailCap(narration.trim(), MAX_NARRATION_CHARS));
  }
  parts.push(
    '',
    'Now output ONLY this, and nothing else:',
    '',
    '===CASES===',
    '[ { "id": "c1", "name": "short case name", "kind": "happy|edge|invalid|auth",',
    '    "status": "PASS|FAIL|SKIP", "request": "METHOD URL + headers + body, verbatim",',
    '    "response": "status code + body, verbatim", "reproSteps": ["step 1"],',
    '    "severity": "BLOCKER|MAJOR|MINOR|NIT" } ]',
    '===SUMMARY===',
    '<3 lines max>',
    '',
    'Rules:',
    '- report ONLY cases the log above supports; never invent a request, a response or a status;',
    '- if the log shows no test was actually executed, emit exactly one case with',
    '  "status": "SKIP" whose name says the session produced no executed case;',
    '- no markdown code fence around the JSON, no comments, no text after the summary.',
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// workflow
// ---------------------------------------------------------------------------

function timeoutMs(): number {
  const raw = Number.parseInt(process.env.AW_TEST_TIMEOUT_MS?.trim() ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function describeModelFailure(err: unknown, provider: string): string {
  const text = messageOf(err);
  if (/ECONNREFUSED|fetch failed|Cannot connect to API/i.test(text) && provider === 'lmstudio') {
    const base = process.env.LMSTUDIO_BASE_URL?.trim() || 'http://localhost:1234/v1';
    return `LM Studio is not reachable at ${base}. Start LM Studio and enable the local server.`;
  }
  if (/abort|timed? ?out/i.test(text)) {
    return `${provider} did not finish the test run within ${timeoutMs() / 1000}s.`;
  }
  return text;
}

/**
 * T09 — `aw test-feature`: black-box test a feature or bug report against a running app and
 * write a markdown report. Fixes nothing.
 *
 * Exit codes (SPEC § exit codes): failing *tests* are findings, so a run whose cases all FAIL
 * still exits 0. Exit 1 is reserved for the run being impossible: `claude-cli`, no target, a
 * non-local target that is not the configured staging URL, an app that would not start, or
 * output that still has no parseable `===CASES===` block after one retry.
 */
export async function runTestFeature(opts: TestFeatureOptions): Promise<TestFeatureResult> {
  const startedAt = new Date();
  const desc = opts.desc?.trim() ?? '';
  if (!desc) fail('description is required: aw test-feature "<what to verify>"');

  const cfg = loadConfig(opts);

  // Checked on the raw flag *before* resolveModel: `--provider claude-cli` without `--model`
  // resolves to "model required: ..." (SPEC § Model resolution), which would mask the real
  // reason the provider is unusable here.
  if (opts.provider?.trim() === 'claude-cli') fail(CLAUDE_CLI_REFUSAL);
  const { provider, model } = resolveModel('qa-tester', opts, cfg);
  if (provider === 'claude-cli') fail(CLAUDE_CLI_REFUSAL);

  const repoRoot = cfg.repoRoot;
  if (!fs.existsSync(repoRoot)) fail(`repoRoot does not exist: ${repoRoot}`);

  // --- target (T09 step 2) ---------------------------------------------------
  const backend = cfg.app?.backend;
  const rawTarget =
    opts.url?.trim() ||
    cfg.app?.baseUrl?.trim() ||
    (backend ? `http://localhost:${backend.port}` : '');
  if (!rawTarget) fail('no target: pass --url or configure app.baseUrl');

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawTarget);
  } catch {
    return fail(`invalid target url: ${rawTarget}`);
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    fail(`invalid target url: ${rawTarget} (expected http: or https:)`);
  }
  const target = normalizeTarget(targetUrl);

  // --- safety (T09 step 4) ---------------------------------------------------
  // Before any probe: a production URL must not even be touched by a reachability fetch.
  const local = isLocalUrl(target);
  if (!local) {
    const staging = cfg.app?.stagingUrl?.trim();
    let matches = false;
    if (staging) {
      try {
        matches = normalizeTarget(new URL(staging)) === target;
      } catch {
        matches = false;
      }
    }
    if (!matches) {
      fail(
        `non-local target must match app.stagingUrl\n` +
          `  target:          ${target}\n` +
          `  app.stagingUrl:  ${staging ?? '(not configured)'}`,
      );
    }
    log(`non-local target allowed: it matches app.stagingUrl (${staging})`);
  }

  // --- reachability / auto-start (T09 step 3) --------------------------------
  const healthUrl = joinUrl(target, backend?.healthPath ?? '/');
  let handle: EnsureUpHandle | undefined;
  let reachable: boolean;
  if (local && backend?.start?.trim() && targetsConfiguredBackend(targetUrl, cfg)) {
    handle = await ensureUp({
      url: healthUrl,
      start: backend.start,
      cwd: repoRoot,
      probeTimeoutMs: PROBE_TIMEOUT_MS,
      waitMs: START_WAIT_MS,
      intervalMs: START_POLL_MS,
      log,
    });
    if (!handle.up) {
      // The app we started is already stopped by ensureUp; process.exit also fires its handler.
      fail(
        `target ${healthUrl} is still down after ${START_WAIT_MS / 1000}s.\n` +
          `  tried to start it with: ${handle.command ?? backend.start}\n` +
          `  in: ${repoRoot}\n` +
          `  last error: ${handle.lastError ?? 'unknown'}`,
      );
    }
    reachable = true;
  } else {
    const probe = await probeUrl(healthUrl, PROBE_TIMEOUT_MS);
    reachable = probe.up;
    if (!reachable) {
      log(
        `warning: ${healthUrl} did not answer (${probe.error ?? 'no response'}) — running anyway; ` +
          'an unreachable target produces FAIL cases, not a CLI error',
      );
    }
  }

  // --- agent session (T09 step 5) --------------------------------------------
  const allowDestructive = opts.allowDestructive === true;
  const agent = loadAgent('qa-tester');
  const screenshotDir = path.join(repoRoot, 'test-reports', 'tmp', 'screenshots');
  const tools: ToolSet = {
    ...makeCoreTools('tester', repoRoot, allowDestructive),
    ...makeBrowserTools({ screenshotDir, viewports: cfg.viewports }),
  };
  const prompt = buildPrompt({
    desc,
    target,
    healthUrl: backend?.healthPath ? healthUrl : undefined,
    repoRoot,
    cfg,
    allowDestructive,
    reachable,
  });

  const cleanup = async (): Promise<void> => {
    await closeBrowser().catch(() => undefined);
    if (handle?.started) await handle.stopAndWait().catch(() => undefined);
  };
  /** `fail()` after resources exist: release Chromium and the app first, then exit 1. */
  const bail = async (message: string): Promise<never> => {
    await cleanup();
    return fail(message);
  };

  log(`testing "${desc}" against ${target} — ${provider}/${model}`);

  /**
   * One model session.
   *
   * - `text` is the final message (the one that should carry the tail);
   * - `narration` is everything the model said in the steps before it. Small models usually
   *   plan *between* tool calls and then answer with the bare `===CASES===` block, so the
   *   narration is where the test plan actually lives;
   * - `evidence` is the compact tool log, which is what the reformat retry reasons over.
   *
   * `withTools: false` turns this into a single-shot call with no tools at all — used for the
   * format retry, so it reformats instead of re-running the whole test session.
   */
  const ask = async (
    text: string,
    withTools = true,
  ): Promise<{ text: string; narration: string; evidence: string[]; stop: StopReason }> => {
    const evidence: string[] = [];
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: getModel(provider, model),
        system: agent.system,
        prompt: text,
        tools: withTools ? tools : undefined,
        stopWhen: withTools ? [stepCountIs(MAX_STEPS), isLooping] : stepCountIs(1),
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(timeoutMs()),
        onStepEnd: (step) => {
          for (const call of step.toolCalls) {
            const line = `${call.toolName} ${truncate(JSON.stringify(call.input ?? {}))}`;
            log(`[tool] ${line}`);
            evidence.push(`> ${truncate(line, EVIDENCE_LINE_CAP)}`);
          }
          for (const res of step.toolResults) {
            const line = `${res.toolName} -> ${truncate(JSON.stringify(res.output ?? null))}`;
            log(`[tool] ${line}`);
            evidence.push(`< ${truncate(line, EVIDENCE_LINE_CAP)}`);
          }
        },
      });
    } catch (err) {
      // getModel() throws here for a missing API key; the SDK throws for transport failures.
      return bail(describeModelFailure(err, provider));
    }
    const stop: StopReason = !withTools
      ? null
      : result.steps.length >= MAX_STEPS
        ? 'steps'
        : isLooping({ steps: result.steps })
          ? 'loop'
          : null;
    log(`model finished in ${result.steps.length} step(s)${stop ? ` (stopped: ${stop})` : ''}`);
    if (stop === 'steps') {
      log(`warning: the agent used its whole ${MAX_STEPS}-step budget without finishing`);
    }
    if (stop === 'loop') {
      log(`warning: the agent repeated the same tool call ${LOOP_LIMIT}x — session cut short`);
    }
    const narration = result.steps
      .slice(0, -1)
      .map((step) => (step.text ?? '').trim())
      .filter(Boolean)
      .join('\n\n');
    return { text: result.text ?? '', narration, evidence, stop };
  };

  let attempt = await ask(prompt);
  let parsed = parseCasesOutput(attempt.text);
  // The text of the newest attempt — the failure message must show what the model said last,
  // and describe *that* attempt's problem, not the one before it.
  let lastRaw = attempt.text;
  let lastReason = parsed.ok ? '' : parsed.reason;
  if (!parsed.ok) {
    log(`raw model output:\n${attempt.text}`);
    log(`format retry: ${parsed.reason}`);
    // Deliberately NOT the original prompt: re-sending it makes the model run all 40 steps
    // again (observed: a 30B model looping on git_log twice in a row, ~7 min for nothing).
    // The retry gets no tools and its own tool log, so it can only reformat what it already did.
    const retry = await ask(
      buildRetryPrompt({
        desc,
        target,
        evidence: attempt.evidence,
        narration: [attempt.narration, attempt.text].filter(Boolean).join('\n\n'),
      }),
      false,
    );
    lastRaw = retry.text;
    const retryParsed = parseCasesOutput(retry.text);
    if (retryParsed.ok) {
      // Keep the FIRST attempt's narration: the retry has no session of its own to narrate.
      attempt = { ...retry, narration: attempt.narration || retry.narration };
      parsed = retryParsed;
    } else {
      lastReason = retryParsed.reason;
      log(`retry model output:\n${retry.text}`);
    }
  }
  if (!parsed.ok) {
    // Name the real cause when the session never got to an answer: "no ===CASES=== marker"
    // plus an empty dump tells the user nothing about a model that spent 40 steps looping.
    const why =
      attempt.stop === 'steps'
        ? `\nThe agent used its whole ${MAX_STEPS}-step budget without producing the block.`
        : attempt.stop === 'loop'
          ? `\nThe agent repeated one tool call ${LOOP_LIMIT}x and the session was cut short.`
          : '';
    return bail(
      `test output has no parseable ===CASES=== block after one retry: ${lastReason}${why}\n` +
        `--- raw model output (last attempt) ---\n${lastRaw}\n--- end raw model output ---`,
    );
  }

  for (const warning of parsed.warnings) log(`warning: ${warning}`);
  const offTarget = offTargetOrigins(parsed.cases, target);
  if (offTarget.length > 0) {
    log(
      `warning: cases record requests against ${offTarget.join(', ')} — not the target ${target}. ` +
        'The agent tested a different address than the one it was given.',
    );
  }

  // --- report (T09 step 7) ---------------------------------------------------
  const counts = countCases(parsed.cases);
  const summary = parsed.summary.trim() || `PASS ${counts.passed}/${counts.total}.`;
  const reportDir = path.join(repoRoot, 'test-reports');
  let reportPath: string;
  try {
    reportPath = createReportFile(reportDir, desc, localDate(startedAt));
    fs.writeFileSync(
      reportPath,
      renderReport({
        desc,
        target,
        provider,
        model,
        plan: parsed.plan || stripTail(attempt.narration),
        cases: parsed.cases,
        rejected: parsed.rejected,
        summary,
        warnings: parsed.warnings,
        startedAt,
        autoStarted: handle?.started ? handle.command : undefined,
      }),
      'utf8',
    );
  } catch (err) {
    return bail(`cannot write the report into ${reportDir}: ${messageOf(err)}`);
  }

  await cleanup();

  // --- step 8 ----------------------------------------------------------------
  write(1, reportPath);
  write(1, summary);
  write(1, `PASS ${counts.passed}/${counts.total}`);

  return {
    reportPath,
    target,
    cases: parsed.cases,
    summary,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    total: counts.total,
  };
}
