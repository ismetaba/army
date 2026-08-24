import fs from 'node:fs';
import type { LanguageModel, ToolSet } from 'ai';
import type { ProviderId } from '../../shared/schemas';
import { getModel } from '../providers';
import { claudeCliSessionModel } from '../providers/claude-cli';
import { noteRunFailure } from '../store';

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
 * SPEC § Agent session loop (amended 2026-08-22) — `claude-cli` runs tool-using sessions
 * through the MCP bridge in `src/providers/claude-cli.ts`. One shared resolver so the three
 * workflows cannot drift apart on how the two session shapes differ:
 *
 *   - API providers: our loop — pass `tools` and `stopWhen` to `generateText`.
 *   - claude-cli: the CLI's loop — tools travel inside the model via MCP, `maxTurns` is the
 *     step ceiling, and `tools`/`stopWhen` must NOT be passed (the provider would ignore the
 *     tools with a warning and the extra declarations would only confuse the session).
 */
export function sessionModel(
  provider: ProviderId,
  modelId: string,
  opts: { tools: ToolSet; cwd: string; maxSteps: number },
): { model: LanguageModel; viaCli: boolean } {
  if (provider === 'claude-cli') {
    return {
      model: claudeCliSessionModel(modelId, {
        tools: opts.tools,
        cwd: opts.cwd,
        maxTurns: opts.maxSteps,
      }),
      viaCli: true,
    };
  }
  return { model: getModel(provider, modelId), viaCli: false };
}

/**
 * T16: where a copy of everything a workflow prints also goes — the run's `log.txt`.
 *
 * A sink rather than an argument threaded through every call site: `log()` is called from ~80
 * places across the three workflows, and the run directory is not known at any of them. The
 * workflow sets the sink once when its run starts and clears it when the run ends.
 */
let logSink: ((line: string) => void) | null = null;

export function setLogSink(sink: ((line: string) => void) | null): void {
  logSink = sink;
}

function toRunLog(line: string): void {
  if (!logSink) return;
  try {
    logSink(line);
  } catch {
    // A failing log must never take down the run that was producing it.
  }
}

/**
 * Write straight to the fd: `process.exit()` can drop output still queued on a pipe, and
 * every message a workflow prints is either the result or the reason for an exit.
 *
 * fd 1 is mirrored into the run log too — the result is the most important line a run produces,
 * and `log.txt` would be a transcript with the ending torn out without it.
 */
export function write(fd: 1 | 2, line: string): void {
  try {
    fs.writeSync(fd, `${line}\n`);
  } catch {
    // A closed/blocked stdio stream must never mask the actual outcome.
  }
  if (fd === 1) toRunLog(line);
}

/** Progress + tool logging. Always stderr, so stdout stays parseable. */
export function log(line: string): void {
  write(2, line);
  toRunLog(line);
}

/** Print to stderr and exit 1 — a workflow failure never surfaces a stack trace. */
export function fail(message: string): never {
  write(2, message);
  toRunLog(message);
  // `process.exit()` unwinds nothing, so the workflow's own catch never sees this. Hand the
  // reason to the store first: the run's exit guard records it as the run's `error`.
  noteRunFailure(message);
  process.exit(1);
}

/**
 * The command line a run was started with, for `RunManifest.input.args`.
 *
 * Rebuilt from the resolved options rather than read from `process.argv`, because a workflow is
 * also called directly (tests, the dashboard later) where argv belongs to something else.
 */
export function formatArgs(
  command: string,
  positionals: readonly (string | undefined)[] = [],
  flags: Readonly<Record<string, string | boolean | undefined>> = {},
): string {
  const parts = [command];
  for (const value of positionals) if (value?.trim()) parts.push(quoteArg(value));
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined || value === false || value === '') continue;
    parts.push(`--${name}`);
    if (typeof value === 'string') parts.push(quoteArg(value));
  }
  return parts.join(' ');
}

/** Shell-safe rendering of one argument, so `input.args` is a line the user can paste back. */
function quoteArg(value: string): string {
  const text = oneLine(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function truncate(value: string, limit = LOG_CAP): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Longest provider response body quoted into an error message. */
const MAX_RESPONSE_BODY_CHARS = 600;

/**
 * What an OpenAI-compatible server said in its error response, when it said anything.
 *
 * The AI SDK turns a 4xx into `AI_APICallError` whose `message` is the bare HTTP reason —
 * "Bad Request" — while the server's own explanation sits in `responseBody`. Reporting only the
 * reason phrase is what made the T14 review failure undiagnosable: LM Studio had said exactly
 * what it disliked and none of it reached the user.
 */
export function providerDetail(err: unknown): string {
  if (err === null || typeof err !== 'object') return '';
  const e = err as { statusCode?: unknown; responseBody?: unknown };
  const status = typeof e.statusCode === 'number' ? `HTTP ${e.statusCode}` : '';
  let body = typeof e.responseBody === 'string' ? e.responseBody.trim() : '';
  if (body) {
    // The body is usually `{"error":"…"}`; the message alone reads better than the envelope.
    try {
      const parsed: unknown = JSON.parse(body);
      const inner = (parsed as { error?: unknown })?.error;
      const text =
        typeof inner === 'string'
          ? inner
          : typeof (inner as { message?: unknown })?.message === 'string'
            ? ((inner as { message: string }).message)
            : '';
      if (text) body = text;
    } catch {
      // Not JSON; quote it as it came.
    }
  }
  // With the standard `{"error":{"message":…}}` envelope the AI SDK has already put that text in
  // `err.message`, and repeating it verbatim under it just stutters — keep only the status then.
  const detail = truncate(oneLine(body), MAX_RESPONSE_BODY_CHARS);
  const alreadySaid = detail !== '' && oneLine(messageOf(err)).includes(detail);
  const parts = [status, alreadySaid ? '' : detail].filter(Boolean);
  return parts.length > 0 ? `\n  provider said: ${parts.join(' — ')}` : '';
}

/**
 * True when the provider rejected the request because the prompt does not fit its context.
 *
 * Local servers say this in the response body, not in the HTTP reason phrase — LM Studio with an
 * 8192-token context answers a 26 KB diff with `400` and "The number of tokens to keep from the
 * initial prompt is greater than the context length". A caller that can send less (the reviewer
 * can cap the diff harder) uses this to retry instead of giving up.
 */
export function isContextOverflowError(err: unknown): boolean {
  const e = err as { statusCode?: unknown; responseBody?: unknown };
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 0;
  if (status !== 0 && status !== 400 && status !== 413 && status !== 422) return false;
  const text = `${messageOf(err)} ${typeof e?.responseBody === 'string' ? e.responseBody : ''}`;
  return /context (?:length|window)|too many tokens|maximum context|prompt is too long|reduce the length/i.test(
    text,
  );
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
  // Anything else is the provider refusing the request: quote what it said, or the message is
  // just "Bad Request" and the user has nothing to act on.
  return `${text}${providerDetail(err)}`;
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
