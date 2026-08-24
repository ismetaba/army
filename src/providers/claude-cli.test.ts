import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { BUILTIN_TOOLS, mcpToolAllowlist, normalizeClaudeCliModel } from './claude-cli';

const stub = (description: string) =>
  tool({
    description,
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => ({ path }),
  });

describe('mcpToolAllowlist', () => {
  it('names every tool under the bridge server prefix, and nothing else', () => {
    const names = mcpToolAllowlist({ read_file: stub('read'), glob: stub('glob') });
    expect(names).toEqual(['mcp__aw__read_file', 'mcp__aw__glob']);
  });

  it('is empty for an empty toolset — a tool-less session grants nothing', () => {
    expect(mcpToolAllowlist({})).toEqual([]);
  });
});

describe('BUILTIN_TOOLS', () => {
  /*
   * This list is the lockdown (see the module header): `disallowedTools` is what actually
   * removes Claude Code's own tools from a bridged session, because `allowedTools` only
   * auto-approves and `canUseTool` is not consulted for calls the CLI auto-approves. A built-in
   * missing from here is a capability the workflow's permission profile never granted — which is
   * exactly how `ToolSearch` slipped into a measured session before it was added.
   */
  it('covers the tools that would break a permission profile if they leaked in', () => {
    // The write/exec ones matter most: the read-only `code-reviewer` profile ships none of them.
    for (const name of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Task', 'SlashCommand']) {
      expect(BUILTIN_TOOLS).toContain(name);
    }
    // Read-ish built-ins matter too: they bypass the toolkit's repo-root containment.
    for (const name of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ToolSearch']) {
      expect(BUILTIN_TOOLS).toContain(name);
    }
  });

  it('has no duplicates and no bridged names', () => {
    expect(new Set(BUILTIN_TOOLS).size).toBe(BUILTIN_TOOLS.length);
    expect(BUILTIN_TOOLS.some((n) => n.startsWith('mcp__'))).toBe(false);
  });
});

describe('normalizeClaudeCliModel', () => {
  it('passes CLI aliases and full model ids through unchanged', () => {
    expect(normalizeClaudeCliModel('sonnet')).toBe('sonnet');
    expect(normalizeClaudeCliModel('claude-opus-5')).toBe('claude-opus-5');
    expect(normalizeClaudeCliModel('  opus  ')).toBe('opus');
  });

  it('refuses an empty model instead of letting the CLI pick one silently', () => {
    // A blank model would make the session run on whatever the CLI defaults to, and the run
    // manifest would record a model the run did not actually use.
    expect(() => normalizeClaudeCliModel('   ')).toThrow(/claude-cli needs a model/);
  });
});
