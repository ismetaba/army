import fs from 'node:fs';

/**
 * Scaffolding shared by every workflow in this directory (`review`, `test-feature`,
 * `design-loop`).
 *
 * Each of the three used to carry its own byte-identical copy of the `claude-cli` refusal and
 * of the write/log/fail/truncate/describeModelFailure helpers. Three copies meant three places
 * to forget when the refusal text or the stderr discipline changes, so they live here instead.
 * Nothing in this module knows which workflow is calling it.
 */

/** SPEC § Agent session loop: tool calls/results are logged truncated to 2 KB. */
export const LOG_CAP = 2 * 1024;

/**
 * SPEC § Agent session loop — `claude-cli` silently ignores AI SDK tools, so every tool-using
 * workflow refuses it up front. One declaration: the wording is a user-facing contract and the
 * three commands must not be able to drift apart.
 */
export const CLAUDE_CLI_REFUSAL =
  'provider "claude-cli" cannot run tool-using workflows: it does not execute AI SDK tools.\n' +
  '  Use --provider anthropic (set ANTHROPIC_API_KEY), or the Claude Code native path (.claude/ commands).';

/**
 * Write straight to the fd: `process.exit()` can drop output still queued on a pipe, and
 * every message a workflow prints is either the result or the reason for an exit.
 */
export function write(fd: 1 | 2, line: string): void {
  try {
    fs.writeSync(fd, `${line}\n`);
  } catch {
    // A closed/blocked stdio stream must never mask the actual outcome.
  }
}

/** Progress + tool logging. Always stderr, so stdout stays parseable. */
export function log(line: string): void {
  write(2, line);
}

/** Print to stderr and exit 1 — a workflow failure never surfaces a stack trace. */
export function fail(message: string): never {
  write(2, message);
  process.exit(1);
}

export function truncate(value: string, limit = LOG_CAP): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a provider/transport failure into a sentence that names the actual problem.
 *
 * `activity` is the workflow's own noun phrase ("the review", "the test run", "the design
 * session"), and `timeoutMs` its own budget — the only two things that differed between the
 * three copies this replaces.
 */
export function describeModelFailure(
  err: unknown,
  provider: string,
  opts: { activity: string; timeoutMs: number },
): string {
  const text = messageOf(err);
  if (/ECONNREFUSED|fetch failed|Cannot connect to API/i.test(text) && provider === 'lmstudio') {
    const base = process.env.LMSTUDIO_BASE_URL?.trim() || 'http://localhost:1234/v1';
    return `LM Studio is not reachable at ${base}. Start LM Studio and enable the local server.`;
  }
  if (/abort|timed? ?out/i.test(text)) {
    return `${provider} did not finish ${opts.activity} within ${opts.timeoutMs / 1000}s.`;
  }
  return text;
}

// ---------------------------------------------------------------------------
// text hygiene shared by the report/presentation writers
// ---------------------------------------------------------------------------

/** C0/C1 control characters: an ANSI escape in model output can rewrite the terminal. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Drop control characters but keep newlines and tabs — reports are multi-line by design. */
export function clean(text: string): string {
  return text.replace(CONTROL_RE, '');
}

/** Single-line form: control characters and newlines all collapse to spaces. */
export function oneLine(text: string): string {
  return clean(text).replace(/\s+/g, ' ').trim();
}
