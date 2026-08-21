import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentName } from '../shared/schemas';
import {
  AGENTS_DIR,
  AgentError,
  loadAgent,
  loadAllAgents,
  loadGuardrails,
} from './agents';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardrails = fs.readFileSync(path.join(repoRoot, 'agents', '_guardrails.md'), 'utf8');

/** Scratch `agents/` dir for the malformed-input cases; never touches the real one. */
const tmpDirs: string[] = [];
function scratchAgents(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-agents-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, '_guardrails.md'), guardrails);
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadAgent / loadAllAgents', () => {
  it('resolves agents/ at the repo root', () => {
    expect(AGENTS_DIR).toBe(path.join(repoRoot, 'agents'));
  });

  it('loads all three agents declared by AgentName', () => {
    const agents = loadAllAgents();
    expect(agents.map((a) => a.name)).toEqual([...AgentName.options]);
    expect(agents).toHaveLength(3);
    for (const agent of agents) {
      expect(agent.description.length).toBeGreaterThan(0);
      expect(agent.tools.length).toBeGreaterThan(0);
      expect(agent.system.length).toBeGreaterThan(0);
    }
  });

  it('maps each agent to its permission profile', () => {
    expect(loadAgent('ui-designer').profile).toBe('designer');
    expect(loadAgent('qa-tester').profile).toBe('tester');
    expect(loadAgent('code-reviewer').profile).toBe('reviewer');
  });

  it('parses the tools list into trimmed entries', () => {
    expect(loadAgent('code-reviewer').tools).toEqual([
      'read_file',
      'glob',
      'grep',
      'git_diff',
      'git_log',
    ]);
    expect(loadAgent('ui-designer').tools).toContain('browser_screenshot');
    expect(loadAgent('qa-tester').tools).toContain('http_request');
  });

  it('gives every system prompt the markdown body followed by the guardrails', () => {
    for (const agent of loadAllAgents()) {
      expect(agent.system.endsWith(guardrails)).toBe(true);
      expect(agent.system.startsWith('You are ')).toBe(true);
      // the guardrails appear exactly once, separated from the body by a blank line
      expect(agent.system.split('GUARDRAILS (non-negotiable):')).toHaveLength(2);
      expect(agent.system).toContain('\n\nGUARDRAILS (non-negotiable):');
      // frontmatter is stripped, not smuggled into the prompt
      expect(agent.system).not.toContain('profile:');
    }
  });

  it('keeps the reviewer read-only: no write, bash or browser tools', () => {
    const { tools } = loadAgent('code-reviewer');
    const forbidden = tools.filter(
      (t) => /^(write_file|edit_file|bash|http_request)$/.test(t) || t.startsWith('browser_'),
    );
    expect(forbidden).toEqual([]);
  });
});

describe('loadAgent — readable errors', () => {
  it('reports a missing agent file', () => {
    const dir = scratchAgents({});
    expect(() => loadAgent('qa-tester', dir)).toThrow(AgentError);
    expect(() => loadAgent('qa-tester', dir)).toThrow(
      `agent file not found: ${path.join(dir, 'qa-tester.md')}`,
    );
  });

  it('reports a missing guardrails file', () => {
    const dir = scratchAgents({ 'qa-tester.md': fs.readFileSync(path.join(repoRoot, 'agents', 'qa-tester.md'), 'utf8') });
    fs.rmSync(path.join(dir, '_guardrails.md'));
    expect(() => loadAgent('qa-tester', dir)).toThrow(
      `agent file not found: ${path.join(dir, '_guardrails.md')}`,
    );
  });

  it('reports a YAML syntax error as an AgentError naming the file', () => {
    const dir = scratchAgents({
      'qa-tester.md': '---\nname: qa-tester\ndescription: "unterminated\nprofile: tester\n---\nBody.\n',
    });
    expect(() => loadAgent('qa-tester', dir)).toThrow(AgentError);
    expect(() => loadAgent('qa-tester', dir)).toThrow(/qa-tester\.md: invalid frontmatter \(/);
  });

  it('reports a missing frontmatter field', () => {
    const dir = scratchAgents({
      'qa-tester.md': '---\nname: qa-tester\nprofile: tester\ntools: read_file\n---\nBody.\n',
    });
    expect(() => loadAgent('qa-tester', dir)).toThrow(
      'qa-tester.md: missing frontmatter field "description"',
    );
  });

  it('rejects an unknown profile', () => {
    const dir = scratchAgents({
      'qa-tester.md':
        '---\nname: qa-tester\ndescription: d\nprofile: superuser\ntools: read_file\n---\nBody.\n',
    });
    expect(() => loadAgent('qa-tester', dir)).toThrow(
      'qa-tester.md: unknown profile "superuser" (expected one of: designer, tester, reviewer)',
    );
  });

  it('rejects a frontmatter name that disagrees with the file name', () => {
    const dir = scratchAgents({
      'qa-tester.md':
        '---\nname: ui-designer\ndescription: d\nprofile: tester\ntools: read_file\n---\nBody.\n',
    });
    expect(() => loadAgent('qa-tester', dir)).toThrow(
      'qa-tester.md: frontmatter name "ui-designer" does not match the file name "qa-tester"',
    );
  });

  it('rejects an empty body', () => {
    const dir = scratchAgents({
      'qa-tester.md': '---\nname: qa-tester\ndescription: d\nprofile: tester\ntools: read_file\n---\n\n',
    });
    expect(() => loadAgent('qa-tester', dir)).toThrow('qa-tester.md: agent body (prompt) is empty');
  });

  it('rejects an agent name outside AgentName', () => {
    expect(() => loadAgent('security-auditor' as never)).toThrow(
      'unknown agent "security-auditor" (expected one of: ui-designer, qa-tester, code-reviewer)',
    );
  });
});

describe('loadGuardrails', () => {
  it('returns the file verbatim', () => {
    expect(loadGuardrails()).toBe(guardrails);
  });
});
