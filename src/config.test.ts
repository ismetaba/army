import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AwConfig, migrateConfig, parseAwConfig, targetUrl } from '../shared/schemas';
import { ConfigError, resolveModel } from './config';

/** Minimal valid config; `agents` filled in per test. Built inline — no fs. */
function cfg(agents?: AwConfig['agents']): AwConfig {
  return AwConfig.parse({
    workspace: 'test-ws',
    backend: { repoRoot: '/tmp/target-repo' },
    defaults: { provider: 'lmstudio', model: 'qwen3-30b-a3b' },
    ...(agents ? { agents } : {}),
  });
}

describe('resolveModel — precedence', () => {
  it('uses defaults when nothing else is set', () => {
    expect(resolveModel('qa-tester', {}, cfg())).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
  });

  it('agent entry wins over defaults', () => {
    const c = cfg({ 'code-reviewer': { provider: 'anthropic', model: 'claude-sonnet-5' } });
    expect(resolveModel('code-reviewer', {}, c)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    // ...and only for that agent
    expect(resolveModel('qa-tester', {}, c)).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
  });

  it('flags win over the agent entry', () => {
    const c = cfg({ 'code-reviewer': { provider: 'anthropic', model: 'claude-sonnet-5' } });
    expect(resolveModel('code-reviewer', { provider: 'openai', model: 'gpt-5' }, c)).toEqual({
      provider: 'openai',
      model: 'gpt-5',
    });
  });

  it('resolves provider and model independently (--model only keeps the entry provider)', () => {
    const c = cfg({ 'ui-designer': { provider: 'openai', model: 'gpt-5' } });
    expect(resolveModel('ui-designer', { model: 'gpt-5-mini' }, c)).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
    });
  });

  it('an agent entry may override the model only, keeping the defaults provider', () => {
    const c = cfg({ 'qa-tester': { model: 'qwen3-8b' } });
    expect(resolveModel('qa-tester', {}, c)).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-8b',
    });
  });

  it('treats empty flag strings as absent', () => {
    expect(resolveModel('qa-tester', { provider: '', model: '  ' }, cfg())).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
  });
});

describe('resolveModel — "same or higher precedence level" rule', () => {
  // (a) flag provider (level 1) + agent-entry model (level 2) => error
  it('(a) errors for a flag provider whose model only comes from the agent entry', () => {
    const c = cfg({ 'code-reviewer': { model: 'claude-sonnet-5' } });
    expect(() => resolveModel('code-reviewer', { provider: 'anthropic' }, c)).toThrow(
      'model required: provider "anthropic" selected without a model (use --model or agents.code-reviewer.model)',
    );
  });

  // (b) agent-entry provider (level 2) + agent-entry model (level 2) => ok
  it('(b) accepts an agent-entry provider paired with an agent-entry model', () => {
    const c = cfg({ 'code-reviewer': { provider: 'anthropic', model: 'claude-sonnet-5' } });
    expect(resolveModel('code-reviewer', {}, c)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
  });

  // (c) agent-entry provider (level 2) + defaults-only model (level 3) => error
  it('(c) errors for an agent-entry provider whose model only comes from defaults', () => {
    const c = cfg({ 'code-reviewer': { provider: 'anthropic' } });
    expect(() => resolveModel('code-reviewer', {}, c)).toThrow(
      'model required: provider "anthropic" selected without a model (use --model or agents.code-reviewer.model)',
    );
  });

  // (d) provider from defaults (level 3) => never errors
  it('(d) never errors when the provider comes from defaults', () => {
    expect(resolveModel('ui-designer', {}, cfg())).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
    expect(resolveModel('ui-designer', {}, cfg({ 'ui-designer': {} }))).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
    expect(resolveModel('ui-designer', { model: 'qwen3-8b' }, cfg())).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-8b',
    });
  });

  it('a flag provider with a flag model is fine (same level)', () => {
    expect(resolveModel('qa-tester', { provider: 'openai', model: 'gpt-5' }, cfg())).toEqual({
      provider: 'openai',
      model: 'gpt-5',
    });
  });

  it('a provider equal to defaults.provider never errors, whatever its level', () => {
    const c = cfg({ 'qa-tester': { provider: 'lmstudio' } });
    expect(resolveModel('qa-tester', {}, c)).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
    expect(resolveModel('qa-tester', { provider: 'lmstudio' }, cfg())).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
  });

  it('throws a ConfigError (message only, no raw stack for the CLI to print)', () => {
    const c = cfg({ 'code-reviewer': { provider: 'anthropic' } });
    expect(() => resolveModel('code-reviewer', {}, c)).toThrow(ConfigError);
  });

  it('rejects an unknown --provider value', () => {
    expect(() => resolveModel('qa-tester', { provider: 'ollama' }, cfg())).toThrow(
      'unknown provider "ollama" (expected one of: lmstudio, openai, anthropic, claude-cli)',
    );
  });
});

describe('aw.config.example.json', () => {
  it('parses with AwConfig', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const file = path.join(here, '..', 'aw.config.example.json');
    const parsed = AwConfig.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    expect(parsed.workspace).toBe('example');
    expect(parsed.defaults).toEqual({ provider: 'lmstudio', model: 'qwen3-30b-a3b' });
    expect(parsed.agents?.['code-reviewer']).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(parsed.viewports.mobile).toEqual({ width: 375, height: 812 });
    // resolution against the shipped example behaves as documented
    expect(resolveModel('code-reviewer', {}, parsed)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    expect(resolveModel('qa-tester', {}, parsed)).toEqual({
      provider: 'lmstudio',
      model: 'qwen3-30b-a3b',
    });
  });

  it('applies the viewports default when the key is omitted', () => {
    const parsed = AwConfig.parse({
      workspace: 'w',
      backend: { repoRoot: '/tmp/r' },
      defaults: { provider: 'lmstudio', model: 'm' },
    });
    expect(parsed.viewports).toEqual({
      mobile: { width: 375, height: 812 },
      desktop: { width: 1440, height: 900 },
    });
  });

  it('rejects an invalid config (readable issues, no throw from loadConfig itself)', () => {
    const result = AwConfig.safeParse({ workspace: 'w', defaults: { provider: 'nope' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('defaults.provider');
    }
    // The missing-target refinement runs once the shape itself is fine.
    const noTarget = AwConfig.safeParse({ workspace: 'w', defaults: { provider: 'lmstudio', model: 'm' } });
    expect(noTarget.success).toBe(false);
    if (!noTarget.success) {
      expect(noTarget.error.issues.map((i) => i.path.join('.'))).toContain('backend');
    }
  });
});

// ---------------------------------------------------------------------------
// T23 — legacy-config migration
// ---------------------------------------------------------------------------

describe('migrateConfig / parseAwConfig (T23)', () => {
  const DEFAULTS = { defaults: { provider: 'lmstudio', model: 'm' } };

  it('maps repoRoot + app.backend + app.frontend + baseUrl onto the two targets', () => {
    const parsed = parseAwConfig({
      workspace: 'fixture',
      repoRoot: '/repo',
      ...DEFAULTS,
      app: {
        backend: { start: 'npm run dev:api', port: 3001, healthPath: '/health' },
        frontend: { start: 'npm run dev', port: 5173 },
        baseUrl: 'http://localhost:3001',
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.backend).toEqual({
      repoRoot: '/repo',
      start: 'npm run dev:api',
      port: 3001,
      healthPath: '/health',
      url: 'http://localhost:3001',
    });
    expect(parsed.data.frontend).toEqual({ repoRoot: '/repo', start: 'npm run dev', port: 5173 });
    expect(parsed.data.repoRoot).toBe('/repo');
  });

  it('a bare repoRoot (no app) becomes a review-only backend', () => {
    const parsed = parseAwConfig({ workspace: 'w', repoRoot: '/repo', ...DEFAULTS });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.backend).toEqual({ repoRoot: '/repo' });
    expect(parsed.data.frontend).toBeUndefined();
  });

  it('repoRoot + app.frontend only stays a frontend-only workspace', () => {
    const parsed = parseAwConfig({
      workspace: 'ui',
      repoRoot: '/ui-repo',
      ...DEFAULTS,
      app: { frontend: { start: 'npm start', port: 4200 } },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.backend).toBeUndefined();
    expect(parsed.data.frontend).toEqual({ repoRoot: '/ui-repo', start: 'npm start', port: 4200 });
    expect(parsed.data.repoRoot).toBe('/ui-repo');
  });

  it('moves app.testAccount and app.stagingUrl to the top level', () => {
    const parsed = parseAwConfig({
      workspace: 'w',
      repoRoot: '/repo',
      ...DEFAULTS,
      app: {
        testAccount: { user: 'qa@example.com', passEnv: 'AW_TEST_PASSWORD' },
        stagingUrl: 'https://staging.example.com',
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.testAccount).toEqual({ user: 'qa@example.com', passEnv: 'AW_TEST_PASSWORD' });
    expect(parsed.data.stagingUrl).toBe('https://staging.example.com');
    // testAccount/stagingUrl alone are not a target; the bare repoRoot still becomes one.
    expect(parsed.data.backend).toEqual({ repoRoot: '/repo' });
  });

  it('new-shape keys win over what the legacy keys would produce', () => {
    const parsed = parseAwConfig({
      workspace: 'w',
      repoRoot: '/old',
      backend: { repoRoot: '/new-backend', port: 8080 },
      ...DEFAULTS,
      app: { backend: { start: 'old', port: 1 } },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.backend).toEqual({ repoRoot: '/new-backend', port: 8080 });
    expect(parsed.data.repoRoot).toBe('/new-backend');
  });

  it('a config with no target at all fails loudly', () => {
    const parsed = parseAwConfig({ workspace: 'w', ...DEFAULTS });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((i) => i.path.join('.'))).toContain('backend');
  });

  it('hands back the SAME reference when there is nothing legacy to migrate', () => {
    const modern = {
      workspace: 'w',
      backend: { repoRoot: '/b' },
      frontend: { repoRoot: '/f', port: 4200 },
      ...DEFAULTS,
    };
    expect(migrateConfig(modern)).toBe(modern);
  });

  it('derives repoRoot as backend ?? frontend', () => {
    const both = parseAwConfig({
      workspace: 'w',
      backend: { repoRoot: '/b' },
      frontend: { repoRoot: '/f' },
      ...DEFAULTS,
    });
    expect(both.success && both.data.repoRoot).toBe('/b');
    const frontendOnly = parseAwConfig({
      workspace: 'w',
      frontend: { repoRoot: '/f' },
      ...DEFAULTS,
    });
    expect(frontendOnly.success && frontendOnly.data.repoRoot).toBe('/f');
  });
});

describe('targetUrl (T23)', () => {
  it('prefers the explicit url, then derives from the port, else undefined', () => {
    expect(targetUrl({ repoRoot: '/r', url: 'http://api.local:9', port: 3001 })).toBe('http://api.local:9');
    expect(targetUrl({ repoRoot: '/r', port: 4200 })).toBe('http://localhost:4200');
    expect(targetUrl({ repoRoot: '/r' })).toBeUndefined();
    expect(targetUrl(undefined)).toBeUndefined();
  });
});
