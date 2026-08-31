/**
 * T13 — the merge logic of `aw init`.
 *
 * Every function under test rewrites a file that already belongs to the developer, so the cases
 * here are mostly about what must NOT happen: no duplicated block, no lost text outside the
 * markers, no duplicated ignore line, no lost workspace entry, no clobbered config value.
 *
 * The last describe drives the real CLI against a throwaway git repo, because "never overwrite an
 * existing `.claude/` file" and "running it twice changes nothing" are properties of the whole
 * command, not of any single pure function.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwConfig, WorkspacesFile } from '../../shared/schemas';
import {
  AW_END,
  AW_START,
  GITIGNORE_LINES,
  InitError,
  addMissingKeys,
  mergeClaudeMd,
  mergeGitignore,
  renderClaudeBlock,
  upsertWorkspace,
  writabilityProblem,
} from './init';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmpDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const BLOCK = `${AW_START}\n## Agent workflows (aw)\n\nrun the things\n${AW_END}`;

// ---------------------------------------------------------------------------
// CLAUDE.md
// ---------------------------------------------------------------------------

describe('mergeClaudeMd', () => {
  it('creates the file from the header + block when there is none', () => {
    const { content, action } = mergeClaudeMd(undefined, BLOCK, '# target\n\nnotes\n\n');
    expect(action).toBe('created');
    expect(content).toBe(`# target\n\nnotes\n\n${BLOCK}\n`);
  });

  it('appends the block to a CLAUDE.md that has no marker, keeping the original text', () => {
    const existing = '# my repo\n\nrun `make dev`.\n';
    const { content, action } = mergeClaudeMd(existing, BLOCK);
    expect(action).toBe('appended');
    expect(content).toBe(`# my repo\n\nrun \`make dev\`.\n\n${BLOCK}\n`);
    expect(content.startsWith(existing)).toBe(true);
  });

  it('replaces an existing block instead of duplicating it', () => {
    const first = mergeClaudeMd('# my repo\n\nnotes\n', BLOCK).content;
    const newBlock = `${AW_START}\n## Agent workflows (aw)\n\nnew body\n${AW_END}`;
    const { content, action } = mergeClaudeMd(first, newBlock);
    expect(action).toBe('replaced');
    expect(content.split(AW_START)).toHaveLength(2);
    expect(content.split(AW_END)).toHaveLength(2);
    expect(content).toContain('new body');
    expect(content).not.toContain('run the things');
    expect(content).toContain('# my repo\n\nnotes\n');
  });

  it('is byte-identical when merged twice with the same block (idempotent)', () => {
    const once = mergeClaudeMd('# my repo\n\nnotes\n', BLOCK).content;
    const twice = mergeClaudeMd(once, BLOCK).content;
    expect(twice).toBe(once);
    // ...and from the "created" path too.
    const created = mergeClaudeMd(undefined, BLOCK, '# t\n\n').content;
    expect(mergeClaudeMd(created, BLOCK).content).toBe(created);
  });

  it('leaves developer text on BOTH sides of the block untouched', () => {
    const existing = `# repo\n\nabove — keep me.\n\n${BLOCK}\n\n## Deploy\n\nbelow — keep me too.\n`;
    const newBlock = `${AW_START}\nreplaced\n${AW_END}`;
    const { content } = mergeClaudeMd(existing, newBlock);
    expect(content).toBe(
      `# repo\n\nabove — keep me.\n\n${newBlock}\n\n## Deploy\n\nbelow — keep me too.\n`,
    );
  });

  it('fails readably on an unclosed start marker, naming the line', () => {
    const broken = `# repo\n\n${AW_START}\nhalf a block\n`;
    expect(() => mergeClaudeMd(broken, BLOCK)).toThrow(InitError);
    expect(() => mergeClaudeMd(broken, BLOCK)).toThrow(/is never closed/);
    expect(() => mergeClaudeMd(broken, BLOCK)).toThrow(/line 3/);
    expect(() => mergeClaudeMd(broken, BLOCK)).toThrow(/Nothing was written/);
  });

  it('fails on an orphan end marker', () => {
    expect(() => mergeClaudeMd(`# repo\n\n${AW_END}\n`, BLOCK)).toThrow(/has no matching/);
  });

  it('fails on a duplicated block rather than picking one', () => {
    expect(() => mergeClaudeMd(`${BLOCK}\n\n${BLOCK}\n`, BLOCK)).toThrow(
      /2 ".*aw:start.*" and 2 ".*aw:end.*" markers/,
    );
  });

  it('fails when the end marker comes before the start marker', () => {
    expect(() => mergeClaudeMd(`${AW_END}\nupside down\n${AW_START}\n`, BLOCK)).toThrow(
      /comes before/,
    );
  });
});

describe('renderClaudeBlock', () => {
  const block = renderClaudeBlock({
    workspace: 'scratch',
    awRepoRoot: '/aw',
    passEnv: 'AW_TEST_PASSWORD',
  });

  it('is a single well-formed marker pair carrying commands and guardrails', () => {
    expect(block.startsWith(AW_START)).toBe(true);
    expect(block.endsWith(AW_END)).toBe(true);
    expect(block.split(AW_START)).toHaveLength(2);
    expect(block).toContain('review --workspace scratch');
    expect(block).toContain('screenshots/<feature-slug>/<screen>-<viewport>.png');
    expect(block).toContain('GUARDRAILS (non-negotiable)');
    expect(block).toContain('Never run `git push`');
  });

  it('names the password env var and says it is never stored', () => {
    expect(block).toContain('$AW_TEST_PASSWORD');
    expect(block).toContain('never stored in this repo');
  });

  it('is deterministic and omits the password line when no test account is configured', () => {
    expect(renderClaudeBlock({ workspace: 'scratch', awRepoRoot: '/aw' })).toBe(
      renderClaudeBlock({ workspace: 'scratch', awRepoRoot: '/aw' }),
    );
    expect(renderClaudeBlock({ workspace: 'scratch', awRepoRoot: '/aw' })).not.toContain(
      'password',
    );
  });
});

// ---------------------------------------------------------------------------
// .gitignore
// ---------------------------------------------------------------------------

describe('mergeGitignore', () => {
  it('creates the file with exactly the required lines', () => {
    expect(mergeGitignore(undefined)).toEqual({
      content: 'screenshots/\ntest-reports/\n.env\n',
      added: [...GITIGNORE_LINES],
    });
  });

  it('appends only the missing lines and keeps the existing content verbatim', () => {
    const existing = 'node_modules/\n.env\n';
    const { content, added } = mergeGitignore(existing);
    expect(added).toEqual(['screenshots/', 'test-reports/']);
    expect(content).toBe('node_modules/\n.env\nscreenshots/\ntest-reports/\n');
    expect(content.startsWith(existing)).toBe(true);
  });

  it('changes nothing when every line is already present', () => {
    const existing = 'node_modules/\ndist/\n.env\nscreenshots/\ntest-reports/\n';
    expect(mergeGitignore(existing)).toEqual({ content: existing, added: [] });
  });

  it('is idempotent', () => {
    const once = mergeGitignore('node_modules/\n').content;
    expect(mergeGitignore(once)).toEqual({ content: once, added: [] });
  });

  it('accepts equivalent spellings (leading / and trailing /) instead of duplicating', () => {
    const { added } = mergeGitignore('/screenshots\ntest-reports\n.env/\n');
    expect(added).toEqual([]);
  });

  it('does not treat a negation or a comment as the line being present', () => {
    expect(mergeGitignore('!screenshots/\n# test-reports/\n').added).toEqual([...GITIGNORE_LINES]);
  });

  it('repairs a missing final newline without clobbering the last line', () => {
    const { content } = mergeGitignore('node_modules/');
    expect(content).toBe('node_modules/\nscreenshots/\ntest-reports/\n.env\n');
  });

  it('treats an empty file as empty rather than emitting a leading blank line', () => {
    expect(mergeGitignore('   \n\n').content).toBe('screenshots/\ntest-reports/\n.env\n');
  });
});

// ---------------------------------------------------------------------------
// workspaces.json
// ---------------------------------------------------------------------------

const ENTRY = { name: 'scratch', repoRoot: '/tmp/aw-scratch', createdAt: '2026-08-21T10:00:00.000Z' };
const OTHER = { name: 'fixture', repoRoot: '/Users/x/aw-fixture', createdAt: '2026-01-01T00:00:00.000Z' };

describe('upsertWorkspace', () => {
  it('creates the registry when the file does not exist', () => {
    const result = upsertWorkspace(undefined, ENTRY);
    expect(result).toEqual({ file: { workspaces: [ENTRY] }, replaced: false, recovered: undefined });
    expect(WorkspacesFile.safeParse(result.file).success).toBe(true);
  });

  it('appends a new entry and keeps the existing ones in order', () => {
    const raw = JSON.stringify({ workspaces: [OTHER] });
    const { file, replaced } = upsertWorkspace(raw, ENTRY);
    expect(replaced).toBe(false);
    expect(file.workspaces).toEqual([OTHER, ENTRY]);
  });

  it('replaces the same-name entry in place, keeps its createdAt, keeps the others', () => {
    const stale = { name: 'scratch', repoRoot: '/old/path', createdAt: '2020-01-01T00:00:00.000Z' };
    const raw = JSON.stringify({ workspaces: [stale, OTHER] });
    const { file, replaced } = upsertWorkspace(raw, { ...ENTRY, repoRoot: '/new/path' });
    expect(replaced).toBe(true);
    expect(file.workspaces).toEqual([
      { name: 'scratch', repoRoot: '/new/path', createdAt: '2020-01-01T00:00:00.000Z' },
      OTHER,
    ]);
    // exactly one entry per name — never a duplicate
    expect(file.workspaces.filter((w) => w.name === 'scratch')).toHaveLength(1);
  });

  it('is idempotent: registering the same repo twice rewrites the identical file', () => {
    const once = upsertWorkspace(undefined, ENTRY).file;
    const twice = upsertWorkspace(JSON.stringify(once), { ...ENTRY, createdAt: 'later' }).file;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('tolerates a file that is not valid JSON, reporting why', () => {
    const { file, recovered } = upsertWorkspace('{ this is not json', ENTRY);
    expect(recovered).toMatch(/not valid JSON/);
    expect(file.workspaces).toEqual([ENTRY]);
  });

  it('tolerates an empty file', () => {
    expect(upsertWorkspace('', ENTRY).file.workspaces).toEqual([ENTRY]);
  });

  it('salvages the valid entries out of a partially corrupt file', () => {
    const raw = JSON.stringify({ workspaces: [OTHER, { name: 'broken' }, 42] });
    const { file, recovered } = upsertWorkspace(raw, ENTRY);
    expect(recovered).toBe('dropped 2 unreadable entries');
    expect(file.workspaces).toEqual([OTHER, ENTRY]);
  });

  it('tolerates a file of the wrong shape entirely', () => {
    const { file, recovered } = upsertWorkspace('["scratch"]', ENTRY);
    expect(recovered).toMatch(/unrecognised shape/);
    expect(file.workspaces).toEqual([ENTRY]);
  });
});

// ---------------------------------------------------------------------------
// aw.config.json
// ---------------------------------------------------------------------------

describe('addMissingKeys', () => {
  const generated = {
    workspace: 'scratch',
    repoRoot: '/tmp/aw-scratch',
    defaults: { provider: 'lmstudio', model: 'test-model' },
    app: { backend: { start: 'npm run dev:api', port: 3001, healthPath: '/health' } },
    viewports: { mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } },
  };

  it('adds only what is missing and never changes an existing value', () => {
    const existing = {
      workspace: 'fixture',
      repoRoot: '/Users/x/aw-fixture',
      defaults: { provider: 'lmstudio', model: 'qwen3-coder-30b-a3b-instruct' },
      app: { backend: { start: 'npm run dev:api', port: 3001 } },
    };
    const { value, added } = addMissingKeys(existing, generated);
    expect(value).toEqual({
      ...existing,
      app: { backend: { start: 'npm run dev:api', port: 3001, healthPath: '/health' } },
      viewports: generated.viewports,
    });
    expect(added).toEqual(['app.backend.healthPath', 'viewports']);
    expect((value as typeof existing).workspace).toBe('fixture');
    expect((value as typeof existing).defaults.model).toBe('qwen3-coder-30b-a3b-instruct');
  });

  it('keeps keys the generated config knows nothing about', () => {
    const existing = { workspace: 'x', offLimits: ['shared dev database'], notes: { a: 1 } };
    const { value } = addMissingKeys(existing, generated);
    expect((value as Record<string, unknown>).offLimits).toEqual(['shared dev database']);
    expect((value as Record<string, unknown>).notes).toEqual({ a: 1 });
  });

  it('never rewrites an existing scalar or array into an object', () => {
    expect(addMissingKeys({ app: 'nope' }, generated).value).toMatchObject({ app: 'nope' });
    expect(addMissingKeys({ app: [] }, generated).value).toMatchObject({ app: [] });
    expect(addMissingKeys({ defaults: null }, generated).value).toMatchObject({ defaults: null });
  });

  it('is idempotent — a second merge adds nothing', () => {
    const once = addMissingKeys({ workspace: 'fixture' }, generated);
    const twice = addMissingKeys(once.value, generated);
    expect(twice.added).toEqual([]);
    expect(twice.value).toEqual(once.value);
  });
});

// ---------------------------------------------------------------------------
// the command as a whole
// ---------------------------------------------------------------------------

const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(REPO_ROOT, 'src', 'cli.ts');

/** Run the real CLI; returns stdout + stderr (notes and warnings go to stderr by design). */
function runInit(args: readonly string[], awHome: string): string {
  const result = spawnSync(TSX, [CLI, 'init', ...args], {
    encoding: 'utf8',
    // stdin closed: init must never wait for an answer that can never arrive.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AW_HOME: awHome },
  });
  if (result.status !== 0) {
    throw new Error(`aw init exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

describe('aw init (end to end, --yes, stdin closed)', () => {
  const root = scratch('aw-init-e2e-');
  const repo = path.join(root, 'target');
  const awHome = path.join(root, 'home');
  const ARGS = ['--yes', '--repo', repo, '--name', 'e2e', '--provider', 'lmstudio', '--model', 'test-model'];
  let first = '';

  beforeAll(() => {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    // A file the developer already has: it must be reported as kept, not overwritten.
    fs.mkdirSync(path.join(repo, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'commands', 'review.md'), 'MINE — do not touch\n');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# target\n\nkeep this line.\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    first = runInit(ARGS, awHome);
  }, 120_000);

  it('writes a config that AwConfig accepts, with no secret in it', () => {
    const raw = fs.readFileSync(path.join(repo, 'aw.config.json'), 'utf8');
    const parsed = AwConfig.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.workspace).toBe('e2e');
    expect(raw).not.toMatch(/password|secret|passwd/i);
  });

  it('installs the six .claude files but keeps the developer’s own copy', () => {
    const agents = fs.readdirSync(path.join(repo, '.claude', 'agents')).sort();
    const commands = fs.readdirSync(path.join(repo, '.claude', 'commands')).sort();
    expect(agents).toEqual(['code-reviewer.md', 'qa-tester.md', 'ui-designer.md']);
    expect(commands).toEqual(['design-loop.md', 'review.md', 'test-feature.md']);
    expect(fs.readFileSync(path.join(repo, '.claude', 'commands', 'review.md'), 'utf8')).toBe(
      'MINE — do not touch\n',
    );
    expect(first).toContain(`kept existing: ${path.join(repo, '.claude', 'commands', 'review.md')}`);
  });

  it('appends the marked block to CLAUDE.md without disturbing what was there', () => {
    const md = fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8');
    expect(md.startsWith('# target\n\nkeep this line.\n')).toBe(true);
    expect(md.split(AW_START)).toHaveLength(2);
    expect(md).toContain('## Agent workflows (aw)');
  });

  it('appends only the missing .gitignore lines', () => {
    expect(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8')).toBe(
      'node_modules/\nscreenshots/\ntest-reports/\n.env\n',
    );
  });

  it('registers the workspace under $AW_HOME', () => {
    const registry = WorkspacesFile.parse(
      JSON.parse(fs.readFileSync(path.join(awHome, 'workspaces.json'), 'utf8')),
    );
    expect(registry.workspaces.map((w) => w.name)).toEqual(['e2e']);
    expect(registry.workspaces[0].repoRoot).toBe(repo);
  });

  it(
    'is idempotent: a second --yes run changes no byte of the target repo',
    () => {
      const snapshot = (): Record<string, string> => {
        const files: Record<string, string> = {};
        const walk = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else files[path.relative(repo, full)] = fs.readFileSync(full, 'utf8');
          }
        };
        walk(repo);
        return files;
      };
      const before = snapshot();
      const registryBefore = fs.readFileSync(path.join(awHome, 'workspaces.json'), 'utf8');
      const second = runInit(ARGS, awHome);
      expect(snapshot()).toEqual(before);
      expect(fs.readFileSync(path.join(awHome, 'workspaces.json'), 'utf8')).toBe(registryBefore);
      expect(second).toContain('kept existing:');
      expect(second).toContain('(unchanged)');
    },
    120_000,
  );
});

describe('aw init over a hand-written config', () => {
  const root = scratch('aw-init-existing-');
  const repo = path.join(root, 'target');
  const awHome = path.join(root, 'home');
  // Compact, hand-formatted, and carrying a key the generated config never produces.
  const HAND_WRITTEN =
    '{\n  "workspace": "fixture",\n  "repoRoot": "REPO",\n' +
    '  "defaults": { "provider": "lmstudio", "model": "qwen3-coder-30b-a3b-instruct" },\n' +
    '  "offLimits": ["shared dev database"]\n}\n';
  let output = '';

  beforeAll(() => {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(
      path.join(repo, 'aw.config.json'),
      HAND_WRITTEN.replace('REPO', repo.replace(/\\/g, '\\\\')),
    );
    output = runInit(['--yes', '--repo', repo, '--name', 'ignored', '--model', 'other'], awHome);
  }, 120_000);

  it('keeps every existing value, adds only the missing keys, migrates the shape', () => {
    const written = JSON.parse(fs.readFileSync(path.join(repo, 'aw.config.json'), 'utf8'));
    expect(written.workspace).toBe('fixture');
    expect(written.defaults).toEqual({ provider: 'lmstudio', model: 'qwen3-coder-30b-a3b-instruct' });
    expect(written.offLimits).toEqual(['shared dev database']);
    expect(written.viewports).toEqual({
      mobile: { width: 375, height: 812 },
      desktop: { width: 1440, height: 900 },
    });
    // T23: init writes the target shape — the legacy repoRoot became the backend target.
    expect(written.backend).toEqual({ repoRoot: repo });
    expect(written.repoRoot).toBeUndefined();
    expect(written.app).toBeUndefined();
    expect(AwConfig.safeParse(written).success).toBe(true);
    expect(output).toContain('config keys added: viewports');
    expect(output).toContain('config migrated to the backend/frontend target shape');
  });

  it('registers the name the config declares, not the one on the command line', () => {
    const registry = WorkspacesFile.parse(
      JSON.parse(fs.readFileSync(path.join(awHome, 'workspaces.json'), 'utf8')),
    );
    expect(registry.workspaces.map((w) => w.name)).toEqual(['fixture']);
    expect(output).toContain('registering that name, not "ignored"');
  });

  it(
    'leaves a complete hand-written config byte for byte alone (no reformatting)',
    () => {
      // A compact, hand-formatted config in the CURRENT (target) shape. `JSON.stringify(…, 2)`
      // would explode it into 30 lines and show up as a diff in a repo where init changed
      // nothing. (A LEGACY-shape config is deliberately not byte-stable: init migrates it once,
      // with a note — see the test above.)
      const compact =
        `{\n  "workspace": "fixture",\n  "backend": { "repoRoot": ${JSON.stringify(repo)} },\n` +
        '  "defaults": { "provider": "lmstudio", "model": "qwen3-coder-30b-a3b-instruct" },\n' +
        '  "viewports": { "mobile": { "width": 375, "height": 812 }, "desktop": { "width": 1440, "height": 900 } }\n}\n';
      const configPath = path.join(repo, 'aw.config.json');
      fs.writeFileSync(configPath, compact);
      runInit(['--yes', '--repo', repo, '--name', 'ignored', '--model', 'other'], awHome);
      expect(fs.readFileSync(configPath, 'utf8')).toBe(compact);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// repoRoot is derived, not authored
// ---------------------------------------------------------------------------

describe('aw init over a config whose repoRoot points at another repo', () => {
  const root = scratch('aw-init-moved-');
  const repo = path.join(root, 'moved');
  const other = path.join(root, 'other');
  const awHome = path.join(root, 'home');
  let output = '';

  beforeAll(() => {
    for (const dir of [repo, other]) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
    }
    // Exactly what a clone/move/second machine produces: aw.config.json is committed and carries
    // an absolute path that belonged to whoever ran init first.
    fs.writeFileSync(
      path.join(repo, 'aw.config.json'),
      `{\n  "workspace": "team",\n  "repoRoot": ${JSON.stringify(other)},\n` +
        '  "defaults": { "provider": "lmstudio", "model": "m" }\n}\n',
    );
    output = runInit(['--yes', '--repo', repo, '--name', 'team'], awHome);
  }, 120_000);

  it('registers the repo that was inited, never the path the config carried', () => {
    const registry = WorkspacesFile.parse(
      JSON.parse(fs.readFileSync(path.join(awHome, 'workspaces.json'), 'utf8')),
    );
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0].repoRoot).toBe(repo);
  });

  it('corrects the key in the config and says so', () => {
    const written = JSON.parse(fs.readFileSync(path.join(repo, 'aw.config.json'), 'utf8'));
    // T23: the legacy repoRoot became the backend target, and ITS root is what gets corrected.
    expect(written.backend.repoRoot).toBe(repo);
    expect(written.repoRoot).toBeUndefined();
    expect(written.defaults.model).toBe('m'); // every other value still wins
    expect(output).toContain('backend.repoRoot pointed at');
    expect(output).toContain(`updated to ${repo}`);
  });

  it('does not warn about a defaulted model when the config already names one', () => {
    expect(output).not.toContain('no --model given');
  });
});

// ---------------------------------------------------------------------------
// T23 — one workspace, two repositories
// ---------------------------------------------------------------------------

describe('aw init with a backend repo and a separate frontend repo (T23)', () => {
  const root = scratch('aw-init-two-');
  const backend = path.join(root, 'api');
  const frontend = path.join(root, 'ui');
  const awHome = path.join(root, 'home');
  const ARGS = [
    '--yes',
    '--repo', backend,
    '--frontend-repo', frontend,
    '--name', 'product',
    '--model', 'm',
    '--backend-port', '8080',
    '--health-path', '/actuator/health',
    '--frontend-start', 'npm start',
    '--frontend-port', '4200',
  ];

  beforeAll(() => {
    for (const dir of [backend, frontend]) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: dir });
    }
    runInit(ARGS, awHome);
  }, 120_000);

  it('writes ONE config, into the backend repo, describing both targets', () => {
    const written = JSON.parse(fs.readFileSync(path.join(backend, 'aw.config.json'), 'utf8'));
    expect(written.backend).toEqual({
      repoRoot: backend,
      port: 8080,
      healthPath: '/actuator/health',
    });
    expect(written.frontend).toEqual({ repoRoot: frontend, start: 'npm start', port: 4200 });
    expect(written.repoRoot).toBeUndefined();
    expect(written.app).toBeUndefined();
    expect(fs.existsSync(path.join(frontend, 'aw.config.json'))).toBe(false);
  });

  it('registers both roots; repoRoot stays populated as the primary for older consumers', () => {
    const registry = WorkspacesFile.parse(
      JSON.parse(fs.readFileSync(path.join(awHome, 'workspaces.json'), 'utf8')),
    );
    expect(registry.workspaces).toHaveLength(1);
    expect(registry.workspaces[0]).toMatchObject({
      name: 'product',
      repoRoot: backend,
      backendRepo: backend,
      frontendRepo: frontend,
    });
  });

  it('installs CLAUDE.md, the .gitignore lines and the .claude layer into BOTH repos', () => {
    for (const dir of [backend, frontend]) {
      expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(
        '## Agent workflows (aw)',
      );
      const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      for (const line of GITIGNORE_LINES) expect(ignore).toContain(line);
      expect(fs.readdirSync(path.join(dir, '.claude', 'commands')).sort()).toEqual([
        'design-loop.md',
        'review.md',
        'test-feature.md',
      ]);
    }
  });

  it('the CLAUDE.md block names both repos and where the config lives', () => {
    const md = fs.readFileSync(path.join(frontend, 'CLAUDE.md'), 'utf8');
    expect(md).toContain(`- backend: \`${backend}\``);
    expect(md).toContain(`- frontend: \`${frontend}\``);
    expect(md).toContain(`\`aw.config.json\` in \`${backend}\``);
  });

  it('a second run changes no byte in either repo', () => {
    const snapshot = (dir: string): Record<string, string> => {
      const files: Record<string, string> = {};
      const walk = (at: string): void => {
        for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const full = path.join(at, entry.name);
          if (entry.isDirectory()) walk(full);
          else files[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
        }
      };
      walk(dir);
      return files;
    };
    const before = [snapshot(backend), snapshot(frontend)];
    runInit(ARGS, awHome);
    expect([snapshot(backend), snapshot(frontend)]).toEqual(before);
  }, 120_000);

  it('names the repo that is not a git repository', () => {
    const bad = path.join(root, 'not-a-repo');
    fs.mkdirSync(bad, { recursive: true });
    expect(() => runInit(['--yes', '--repo', backend, '--frontend-repo', bad], awHome)).toThrow(
      /frontend repo is not a git repository/,
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// nothing is written when a planned write cannot succeed
// ---------------------------------------------------------------------------

describe('writabilityProblem', () => {
  const root = scratch('aw-init-writable-');

  it('accepts a normal file and a file that does not exist yet', () => {
    const file = path.join(root, 'plain.txt');
    fs.writeFileSync(file, 'x');
    expect(writabilityProblem(file)).toBeUndefined();
    expect(writabilityProblem(path.join(root, 'nested', 'deep', 'new.txt'))).toBeUndefined();
  });

  // root ignores file modes, so a 0444 file is still writable there and the check
  // (correctly) reports no problem — the assertion only means something as a normal user.
  it.skipIf(process.getuid?.() === 0)('reports a read-only file', () => {
    const file = path.join(root, 'ro.txt');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o444);
    expect(writabilityProblem(file)).toMatch(/is not writable/);
    fs.chmodSync(file, 0o644);
  });

  it('reports an ancestor that is a regular file, naming the blocker once', () => {
    const blocker = path.join(root, '.claude');
    fs.writeFileSync(blocker, 'not a directory');
    const a = writabilityProblem(path.join(blocker, 'agents', 'x.md'));
    const b = writabilityProblem(path.join(blocker, 'commands', 'y.md'));
    expect(a).toMatch(/is a file, but this run needs it to be a directory/);
    expect(a).toBe(b); // one problem, not six lines
  });

  it('reports a directory where a file must be written', () => {
    const dir = path.join(root, 'CLAUDE.md');
    fs.mkdirSync(dir);
    expect(writabilityProblem(dir)).toMatch(/is a directory, but a file must be written/);
  });
});

describe('aw init leaves the target untouched when a planned write cannot succeed', () => {
  const root = scratch('aw-init-readonly-');
  const repo = path.join(root, 'target');
  const awHome = path.join(root, 'home');

  beforeAll(() => {
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# target\n');
    fs.chmodSync(path.join(repo, 'CLAUDE.md'), 0o444);
  }, 120_000);

  // Skipped as root for the same reason as the read-only writabilityProblem test above:
  // root writes straight through a 0444 CLAUDE.md, so the planned failure never happens.
  it.skipIf(process.getuid?.() === 0)(
    'fails during planning with "Nothing was written." and writes nothing at all',
    () => {
      const result = spawnSync(TSX, [CLI, 'init', '--yes', '--repo', repo, '--name', 'ro', '--model', 'm'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AW_HOME: awHome },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/is not writable/);
      expect(result.stderr).toContain('Nothing was written.');
      // No aw.config.json, no .claude/, no .gitignore, no registry — the whole point of the
      // pre-flight check: a failed init is not a half-configured repo.
      expect(fs.readdirSync(repo).sort()).toEqual(['.git', 'CLAUDE.md']);
      expect(fs.existsSync(awHome)).toBe(false);
      fs.chmodSync(path.join(repo, 'CLAUDE.md'), 0o644);
    },
    120_000,
  );
});
