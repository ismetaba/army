import type { LanguageModel, ToolSet } from 'ai';
import { claudeCode, createAiSdkMcpServer } from 'ai-sdk-provider-claude-code';

/**
 * The `claude-cli` bridge: run a tool-using workflow session through the developer's local
 * Claude Code login (their subscription) instead of an API key.
 *
 * Why this file exists — the provider CANNOT execute AI SDK tools the normal way. At the
 * language-model layer a provider only ever receives tool *declarations*; the `execute`
 * functions live in the `ai` package and never reach it. `ai-sdk-provider-claude-code`
 * therefore ignores the `tools` option with a warning (measured in tasks/T01.md — the model
 * answered from memory and `execute` was never called), which is why the three workflows
 * refused the provider outright until now.
 *
 * The escape hatch is the provider's own: `createAiSdkMcpServer` bridges our AI SDK tools
 * into an in-process MCP server that the Claude Code CLI executes. The `execute` functions
 * still run in THIS process, so everything the toolkit guarantees keeps holding:
 *
 *   - permission profiles (a reviewer toolset simply contains no write/bash tools),
 *   - repo-root path containment, blocked bash patterns, the destructive-HTTP gate,
 *   - tool-call logging into the run's log.txt (bridged calls surface in `result.steps`
 *     as `mcp__aw__<tool>` dynamic tool parts, so `onStepEnd` logging sees them too).
 *
 * The CLI's OWN tools are the dangerous part — a stock Claude Code session carries Bash,
 * Read, Write and friends, which would hand a "read-only" reviewer a full shell. Getting this
 * right took measuring, because the two obvious mechanisms do NOT do it:
 *
 *   - `allowedTools` is an auto-APPROVE list, not an availability list. With only
 *     `mcp__aw__*` in it, a real review still ran `[tool] Bash {"command":"cat -n …"}` and
 *     `[tool] Read` and never touched the bridged tools at all.
 *   - `canUseTool` is consulted only when the CLI would otherwise prompt. Its permission
 *     engine auto-approves read-only calls, so the callback never fired for those `Read`s.
 *     (It did fire for a `find -exec`, which is how the first run got a denial at all.)
 *
 * `disallowedTools` is what actually removes them: with the built-ins listed there, the same
 * prompt used `mcp__aw__read_file` and returned this process's stubbed content, proving the
 * bridged toolset was the one in play. `canUseTool` stays as a second line — it cannot be the
 * first, since it is not consulted for auto-approved calls.
 *
 * `BUILTIN_TOOLS` is therefore load-bearing and must be maintained: a built-in missing from it
 * is a capability the profile did not grant. `ToolSearch` was missing from the first version
 * and showed up in a session within minutes. `settingSources` is pinned empty for the same
 * reason — the repository under review must not be able to widen its own reviewer's powers.
 *
 * Loop ownership differs from the API providers: the CLI runs its own agentic loop inside
 * ONE `generateText` call, so the session must NOT pass `tools`/`stopWhen` — `maxTurns`
 * here is the step ceiling instead, mapped from the workflow's MAX_STEPS.
 */
export function claudeCliSessionModel(
  modelId: string,
  opts: { tools: ToolSet; cwd: string; maxTurns: number },
): LanguageModel {
  const allowed = new Set(mcpToolAllowlist(opts.tools));
  return claudeCode(normalizeClaudeCliModel(modelId), {
    mcpServers: { aw: createAiSdkMcpServer('aw', opts.tools as never) },
    // The lockdown. Deliberately NOT paired with `allowedTools`: the provider warns that
    // `allowedTools` wins when both are set, and `allowedTools` alone leaves the built-ins in.
    disallowedTools: [...BUILTIN_TOOLS],
    // Second line only — not consulted for calls the CLI auto-approves (see the note above).
    canUseTool: async (toolName: string, input: Record<string, unknown>) =>
      allowed.has(toolName)
        ? { behavior: 'allow' as const, updatedInput: input }
        : {
            behavior: 'deny' as const,
            message:
              `${toolName} is not available in this session. This workflow runs with a fixed ` +
              `toolset (${[...allowed].join(', ')}); use those tools instead.`,
          },
    // Do not inherit user/project/local settings: the repo under review must not be able to
    // widen the session's permissions.
    settingSources: [],
    cwd: opts.cwd,
    maxTurns: opts.maxTurns,
  });
}

/**
 * Claude Code's built-in tools, removed from every bridged session so the workflow's permission
 * profile is the whole capability surface. Keep this list current — see the note above; an
 * omission silently hands the session a tool the profile never granted.
 */
export const BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'NotebookEdit',
  'Read',
  'Skill',
  'SlashCommand',
  'Task',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/** The exact allowlist the bridge grants: our tools and nothing else. */
export function mcpToolAllowlist(tools: ToolSet): string[] {
  return Object.keys(tools).map((name) => `mcp__aw__${name}`);
}

/**
 * The CLI accepts the aliases `opus` / `sonnet` / `haiku` as well as full model ids.
 * People coming from the other providers type things like "claude-opus-5", which works
 * as-is; an empty string would make the CLI fall back silently, so require something.
 */
export function normalizeClaudeCliModel(modelId: string): string {
  const id = modelId.trim();
  if (!id) throw new Error('claude-cli needs a model: "opus", "sonnet", "haiku", or a full model id');
  return id;
}
