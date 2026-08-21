import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { AgentName } from '../shared/schemas';

/** Permission profile an agent runs under (SPEC § Tools and permission profiles). */
export const AGENT_PROFILES = ['designer', 'tester', 'reviewer'] as const;
export type AgentProfile = (typeof AGENT_PROFILES)[number];

/** One agent definition, parsed from `agents/<name>.md`. */
export interface Agent {
  name: AgentName;
  description: string;
  profile: AgentProfile;
  tools: string[];
  /** Markdown body + `\n\n` + the verbatim contents of `agents/_guardrails.md`. */
  system: string;
}

/** Thrown for malformed/missing agent definition files. Callers print `.message`. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** `agents/` at the repo root — the single source of truth for CLI and `.claude/` (T11). */
export const AGENTS_DIR = path.join(here, '..', 'agents');

export const GUARDRAILS_FILE = '_guardrails.md';

function readAgentFile(dir: string, file: string): string {
  const full = path.join(dir, file);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AgentError(`agent file not found: ${full}`);
    throw new AgentError(`cannot read agent file: ${full} (${(err as Error).message})`);
  }
}

/** Verbatim contents of `agents/_guardrails.md`; appended to every agent's system prompt. */
export function loadGuardrails(dir: string = AGENTS_DIR): string {
  return readAgentFile(dir, GUARDRAILS_FILE);
}

function requireString(
  data: Record<string, unknown>,
  field: string,
  file: string,
): string {
  const value = data[field];
  if (value === undefined || value === null) {
    throw new AgentError(`${file}: missing frontmatter field "${field}"`);
  }
  if (typeof value !== 'string') {
    throw new AgentError(
      `${file}: frontmatter field "${field}" must be a string (got ${typeof value})`,
    );
  }
  const trimmed = value.trim();
  if (!trimmed) throw new AgentError(`${file}: frontmatter field "${field}" is empty`);
  return trimmed;
}

/**
 * Load one agent definition.
 * `system` is the markdown body followed by the guardrails, so a caller can pass it
 * straight to `generateText({ system })` without remembering to append anything.
 */
export function loadAgent(name: AgentName, dir: string = AGENTS_DIR): Agent {
  const parsedName = AgentName.safeParse(name);
  if (!parsedName.success) {
    throw new AgentError(
      `unknown agent "${String(name)}" (expected one of: ${AgentName.options.join(', ')})`,
    );
  }

  const file = `${parsedName.data}.md`;
  const raw = readAgentFile(dir, file);
  let parsed: ReturnType<typeof matter>;
  try {
    // The `{}` is deliberate: gray-matter's global cache stores the file object
    // *before* parsing, so a second parse of malformed content silently yields
    // `data: {}` instead of throwing. Passing options bypasses that cache.
    parsed = matter(raw, {});
  } catch (err) {
    // js-yaml reports a line/column but never the file — name it, like every other error here.
    throw new AgentError(`${file}: invalid frontmatter (${(err as Error).message})`);
  }
  const data = (parsed.data ?? {}) as Record<string, unknown>;

  const declaredName = requireString(data, 'name', file);
  if (declaredName !== parsedName.data) {
    throw new AgentError(
      `${file}: frontmatter name "${declaredName}" does not match the file name "${parsedName.data}"`,
    );
  }

  const description = requireString(data, 'description', file);

  const profile = requireString(data, 'profile', file) as AgentProfile;
  if (!AGENT_PROFILES.includes(profile)) {
    throw new AgentError(
      `${file}: unknown profile "${profile}" (expected one of: ${AGENT_PROFILES.join(', ')})`,
    );
  }

  const tools = requireString(data, 'tools', file)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tools.length === 0) throw new AgentError(`${file}: frontmatter field "tools" is empty`);

  const body = parsed.content.trim();
  if (!body) throw new AgentError(`${file}: agent body (prompt) is empty`);

  return {
    name: parsedName.data,
    description,
    profile,
    tools,
    system: `${body}\n\n${loadGuardrails(dir)}`,
  };
}

/** All three agents, in the order declared by `AgentName`. */
export function loadAllAgents(dir: string = AGENTS_DIR): Agent[] {
  return AgentName.options.map((name) => loadAgent(name, dir));
}
