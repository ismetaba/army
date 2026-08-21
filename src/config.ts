import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { AgentName, AwConfig, ProviderId, WorkspacesFile } from '../shared/schemas';
import { awHome } from './util';

/** Thrown for user-facing configuration mistakes. Callers print `.message`, not a stack. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Print to stderr and exit 1 — never let a raw stack reach the user. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length ? issue.path.join('.') : '(root)';
      return `  - ${where}: ${issue.message}`;
    })
    .join('\n');
}

function readJsonFile(file: string, label: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') fail(`${label} not found: ${file}`);
    fail(`cannot read ${label}: ${file} (${(err as Error).message})`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    return fail(`${label} is not valid JSON: ${file}\n  - ${(err as Error).message}`);
  }
}

/**
 * Resolve which `aw.config.json` to read.
 * `opts.workspace` wins: look the workspace up in `$AW_HOME/workspaces.json` (SPEC § Storage)
 * and use `<repoRoot>/aw.config.json`. Otherwise use `opts.config ?? './aw.config.json'`.
 */
export function resolveConfigPath(opts: { config?: string; workspace?: string } = {}): string {
  const workspace = opts.workspace?.trim();
  if (workspace) {
    const registryPath = path.join(awHome(), 'workspaces.json');
    const parsed = WorkspacesFile.safeParse(readJsonFile(registryPath, 'workspaces.json'));
    if (!parsed.success) {
      fail(`invalid workspaces file: ${registryPath}\n${formatIssues(parsed.error)}`);
    }
    const entry = parsed.data.workspaces.find((w) => w.name === workspace);
    if (!entry) {
      const known = parsed.data.workspaces.map((w) => w.name).join(', ') || '(none registered)';
      fail(`unknown workspace "${workspace}" in ${registryPath}\n  known workspaces: ${known}`);
    }
    return path.join(entry.repoRoot, 'aw.config.json');
  }
  return path.resolve(opts.config?.trim() || './aw.config.json');
}

/**
 * Load and validate an `aw.config.json`.
 * On any problem: readable message on stderr + `process.exit(1)`. Never throws a raw stack.
 */
export function loadConfig(opts: { config?: string; workspace?: string } = {}): AwConfig {
  const configPath = resolveConfigPath(opts);
  const raw = readJsonFile(configPath, 'config');
  const parsed = AwConfig.safeParse(raw);
  if (!parsed.success) {
    fail(`invalid config: ${configPath}\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Precedence level of a resolved field — lower number = higher precedence.
 * 1 = CLI flag, 2 = `config.agents[<agent>]`, 3 = `config.defaults`.
 */
type Level = 1 | 2 | 3;

/** Treat empty/whitespace-only flag values as "not provided". */
function flagValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseProviderFlag(value: string): ProviderId {
  const parsed = ProviderId.safeParse(value);
  if (!parsed.success) {
    throw new ConfigError(
      `unknown provider "${value}" (expected one of: ${ProviderId.options.join(', ')})`,
    );
  }
  return parsed.data;
}

/**
 * SPEC § Model resolution.
 *
 * Precedence, field by field:
 *   1. CLI flags `--provider` / `--model`
 *   2. `config.agents[<agentName>].provider` / `.model`
 *   3. `config.defaults`
 *
 * Rule: if the resolved provider differs from `defaults.provider` and no model was given at
 * the same or higher precedence level (i.e. modelLevel > providerLevel), fail with
 * `model required: provider "<p>" selected without a model (use --model or agents.<name>.model)`.
 */
export function resolveModel(
  agent: AgentName,
  flags: { provider?: string; model?: string },
  cfg: AwConfig,
): { provider: ProviderId; model: string } {
  const entry = cfg.agents?.[agent];
  const flagProvider = flagValue(flags.provider);
  const flagModel = flagValue(flags.model);

  let provider: ProviderId;
  let providerLevel: Level;
  if (flagProvider !== undefined) {
    provider = parseProviderFlag(flagProvider);
    providerLevel = 1;
  } else if (entry?.provider !== undefined) {
    provider = entry.provider;
    providerLevel = 2;
  } else {
    provider = cfg.defaults.provider;
    providerLevel = 3;
  }

  let model: string;
  let modelLevel: Level;
  if (flagModel !== undefined) {
    model = flagModel;
    modelLevel = 1;
  } else if (entry?.model !== undefined) {
    model = entry.model;
    modelLevel = 2;
  } else {
    model = cfg.defaults.model;
    modelLevel = 3;
  }

  // A model inherited from a *lower* precedence level than the provider belongs to a
  // different provider, so it cannot be used with the selected one.
  if (provider !== cfg.defaults.provider && modelLevel > providerLevel) {
    throw new ConfigError(
      `model required: provider "${provider}" selected without a model (use --model or agents.${agent}.model)`,
    );
  }

  return { provider, model };
}
