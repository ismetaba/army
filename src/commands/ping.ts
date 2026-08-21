import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { generateText } from 'ai';
import type { Command } from 'commander';
import type { AwConfig, ProviderId } from '../../shared/schemas';
import { ProviderId as ProviderIdSchema } from '../../shared/schemas';
import { ConfigError, loadConfig, resolveConfigPath } from '../config';
import { getModel } from '../providers/index';

const execFileAsync = promisify(execFileCb);

/** The one-shot prompt every provider gets. */
const PING_PROMPT = 'Reply with exactly: pong';

/** Provider used when neither `--provider` nor `config.defaults` says otherwise. */
const DEFAULT_PROVIDER: ProviderId = 'lmstudio';

/** How much of the model's answer the OK line shows (SPEC-mandated 40 chars). */
const PREVIEW_CHARS = 40;

/** `claude -p` is a whole agent turn; 60 s per T04. */
const CLAUDE_CLI_TIMEOUT_MS = 60_000;
const CLAUDE_CLI_MAX_BUFFER = 1024 * 1024;

/** Guard against a provider that accepts the request and then never answers. */
const GENERATE_TIMEOUT_MS = 120_000;

/** Overridable only so the failure path can be exercised against a stub (see T04 Deviations). */
const CLAUDE_BIN = process.env.AW_CLAUDE_BIN?.trim() || 'claude';

const CLAUDE_CLI_FIX =
  'Fix: run `claude` interactively once to log in, or use provider "anthropic" (set ANTHROPIC_API_KEY).';

/** Print to stderr and exit 1 — a ping failure must never surface a stack trace. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function lmStudioBaseUrl(): string {
  return process.env.LMSTUDIO_BASE_URL?.trim() || 'http://localhost:1234/v1';
}

/** C0/C1 control characters — an ANSI escape in model output must never reach the OK line. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Treat empty/whitespace-only flag values as "not provided" (same rule as config.ts). */
function flagValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseProviderFlag(value: string): ProviderId {
  const parsed = ProviderIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      `unknown provider "${value}" (expected one of: ${ProviderIdSchema.options.join(', ')})`,
    );
  }
  return parsed.data;
}

/**
 * One line, at most `PREVIEW_CHARS` characters — the OK line must stay a single line.
 * Control characters go first: `\s` does not cover ESC, so without this an answer containing
 * ANSI escapes would reach the terminal verbatim inside a status line that starts with `OK`.
 */
function preview(text: string): string {
  return text
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_CHARS);
}

function okLine(provider: string, model: string, ms: number, text: string): string {
  return `OK ${provider} ${model} ${ms}ms — "${preview(text)}"`;
}

/**
 * Flatten an error and everything it wraps (`cause` chains, `AggregateError.errors`) into one
 * string, so transport failures can be recognised however deeply the AI SDK nested them.
 */
function errorChainText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > 8) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const e = value as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.code === 'string') parts.push(e.code);
    visit(e.cause, depth + 1);
    if (Array.isArray(e.errors)) for (const sub of e.errors) visit(sub, depth + 1);
  };
  visit(err, 0);
  return parts.join(' | ');
}

/**
 * Node/undici transport failures that mean "nothing is listening / unreachable".
 * `Cannot connect to API` is how the AI SDK re-words any of these before rethrowing, and
 * `bad port` is what fetch says for a WHATWG-blocked port such as `:9`.
 */
const CONNECTION_FAILURE =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|fetch failed|Cannot connect to API|bad port/i;

/**
 * Did *our own* timeout fire? Decided from the signal, never from the error text: providers
 * legitimately send back messages like "Prediction timed out after 300 seconds" or
 * "Request timed out while waiting for the model to load", and reporting those as ping's own
 * 120 s client timeout throws away the only diagnostic the smoke test exists to surface.
 */
function isOwnTimeout(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Map any thrown value to the readable, provider-aware message T04 requires. */
function describeFailure(
  err: unknown,
  provider: ProviderId,
  model: string,
  signal: AbortSignal,
): string {
  const chain = errorChainText(err);
  if (provider === 'lmstudio' && CONNECTION_FAILURE.test(chain)) {
    return `LM Studio is not reachable at ${lmStudioBaseUrl()}. Start LM Studio and enable the local server.`;
  }
  if (isOwnTimeout(err, signal)) {
    return `${provider} did not answer within ${GENERATE_TIMEOUT_MS / 1000}s (model "${model}").`;
  }
  if (err instanceof Error && err.message) return err.message;
  return chain || String(err);
}

/**
 * Load `aw.config.json` only to supply defaults.
 * An explicit `--config` must exist (loadConfig reports it); an implicit `./aw.config.json`
 * that is simply absent is not an error for ping — the user just has to pass `--model`.
 */
function loadOptionalConfig(configFlag: string | undefined): AwConfig | undefined {
  if (configFlag) return loadConfig({ config: configFlag });
  if (!fs.existsSync(resolveConfigPath())) return undefined;
  return loadConfig();
}

/**
 * `claude-cli` has no AI SDK model (see providers/index.ts) — ping the real CLI instead.
 * Non-zero exit, a "Not logged in" banner, or empty output all count as failure.
 */
async function pingClaudeCli(modelLabel: string): Promise<void> {
  const t0 = Date.now();
  let stdout = '';
  let stderr = '';
  let failure: string | undefined;

  // Kill the child if ping itself is signalled: without this, a SIGINT/SIGTERM aimed at the
  // node process alone leaves `claude` running, reparented to init (T16 supervises ping).
  const pending = execFileAsync(CLAUDE_BIN, ['-p', PING_PROMPT, '--output-format', 'text'], {
    timeout: CLAUDE_CLI_TIMEOUT_MS,
    maxBuffer: CLAUDE_CLI_MAX_BUFFER,
  });
  // Registering a signal listener disables node's default "die on SIGINT", so the handler
  // has to end the process itself — with the conventional 128 + signal number exit code.
  const killChild = (signal: NodeJS.Signals): void => {
    pending.child.kill('SIGTERM');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', killChild);
  process.once('SIGTERM', killChild);

  try {
    const result = await pending;
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: unknown;
      killed?: boolean;
      signal?: string | null;
    };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    if (e.code === 'ENOENT') {
      fail(
        `claude CLI not found (looked for "${CLAUDE_BIN}" on PATH). Install Claude Code, or use provider "anthropic".`,
      );
    }
    if (e.killed || e.signal) {
      fail(`claude CLI timed out after ${CLAUDE_CLI_TIMEOUT_MS / 1000}s. ${CLAUDE_CLI_FIX}`);
    }
    failure = `claude CLI exited with status ${String(e.code)}.`;
  } finally {
    process.off('SIGINT', killChild);
    process.off('SIGTERM', killChild);
  }

  const ms = Date.now() - t0;
  const combined = `${stdout}\n${stderr}`;
  if (/not\s+logged\s+in/i.test(combined)) failure = 'claude CLI is not logged in.';
  else if (!failure && !stdout.trim()) failure = 'claude CLI returned no output.';

  if (failure) {
    const detail = preview(combined);
    fail(`${failure} ${CLAUDE_CLI_FIX}${detail ? `\n  claude output: "${detail}"` : ''}`);
  }

  console.log(okLine('claude-cli', modelLabel, ms, stdout));
}

async function runPing(flags: { provider?: string; model?: string; config?: string }): Promise<void> {
  const flagProvider = flagValue(flags.provider);
  const flagModel = flagValue(flags.model);
  const configFlag = flagValue(flags.config);

  // Only consult the *implicit* config when a flag left something unresolved (T04 step 1);
  // an explicit `--config <path>` is always loaded, so a typo'd path fails loudly instead of
  // being silently ignored just because `--provider` and `--model` happened to be complete.
  const cfg = configFlag || !(flagProvider && flagModel) ? loadOptionalConfig(configFlag) : undefined;

  const provider = flagProvider
    ? parseProviderFlag(flagProvider)
    : (cfg?.defaults.provider ?? DEFAULT_PROVIDER);

  if (provider === 'claude-cli') {
    // The CLI picks its own model; `--model` is only a label here.
    await pingClaudeCli(flagModel ?? 'default');
    return;
  }

  let model = flagModel;
  if (!model && cfg && provider === cfg.defaults.provider) model = cfg.defaults.model;
  if (!model) {
    throw new ConfigError(
      `model required: provider "${provider}" selected without a model (use --model)`,
    );
  }

  const t0 = Date.now();
  // Kept in a const so the failure path can ask the signal — not the error text — whether
  // this timeout is the one that fired.
  const timeout = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      // getModel throws the requireEnv message when the provider's API key is missing.
      model: getModel(provider, model),
      prompt: PING_PROMPT,
      // A smoke test reports the first failure; it does not retry behind the user's back.
      maxRetries: 0,
      abortSignal: timeout,
    });
  } catch (err) {
    fail(describeFailure(err, provider, model, timeout));
  }
  const ms = Date.now() - t0;
  // An empty completion is not a successful round trip — the same rule the claude-cli branch
  // applies. A reasoning-only model that puts everything in `reasoning_content` would
  // otherwise print a green OK line with no answer in it.
  const text = result.text ?? '';
  if (!text.trim()) {
    fail(
      `${provider} returned no text (model "${model}"). The request succeeded but the answer was empty — ` +
        'check that the loaded model is a chat model and not reasoning-only.',
    );
  }
  console.log(okLine(provider, model, ms, text));
}

/** T04 — `aw ping`: one prompt, one round trip, one readable line either way. */
export function registerPing(program: Command): void {
  program
    .command('ping')
    .description('Smoke-test a provider with a single one-prompt round trip')
    .option('-p, --provider <p>', `provider id (default: config defaults, else ${DEFAULT_PROVIDER})`)
    .option('-m, --model <m>', 'model id (required unless it comes from config defaults)')
    .option('-c, --config <path>', 'path to aw.config.json (default: ./aw.config.json)')
    .action(async (opts: { provider?: string; model?: string; config?: string }) => {
      try {
        await runPing(opts);
      } catch (err) {
        // Anything reaching here is a resolution problem (bad provider, no model) — the
        // round trip itself already mapped its own failures inside runPing.
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}
