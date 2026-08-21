import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPlanPrompt,
  buildSessionPrompt,
  checkpoint,
  extractJudgmentCalls,
  findScreenshots,
  frontendFiles,
  limitPlan,
  resolveFeature,
  resumeLine,
  slugForFeature,
} from './design-loop';
import type { AwConfig } from '../../shared/schemas';

const temps: string[] = [];

function tempDir(prefix = 'aw-design-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// slug + resume line (T10 steps 2 and 8)
// ---------------------------------------------------------------------------

describe('slugForFeature', () => {
  it('slugifies the first six words', () => {
    expect(slugForFeature('add a placeholder /about page with a heading and a paragraph')).toBe(
      'add-a-placeholder-about-page-with',
    );
  });

  it('ignores markdown decoration when counting words', () => {
    expect(slugForFeature('# Feature: **team** page')).toBe('feature-team-page');
  });

  it('never returns an empty directory name', () => {
    expect(slugForFeature('!!! ???')).toBe('design');
    expect(slugForFeature('   ')).toBe('design');
  });

  it('caps the slug so it stays a usable directory name', () => {
    const slug = slugForFeature('supercalifragilistic '.repeat(6));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('resumeLine', () => {
  it('is the exact T10 step 8 line', () => {
    expect(resumeLine('add an about page')).toBe(
      '--- STOPPING FOR FEEDBACK — resume with: aw design-loop "add an about page" --iterate "<your feedback>" ---',
    );
  });

  it('escapes what would otherwise break the printed shell command', () => {
    const line = resumeLine('add a "team" page $HOME');
    expect(line).toContain('aw design-loop "add a \\"team\\" page \\$HOME" --iterate');
  });

  it('collapses a multi-line spec argument onto one line', () => {
    expect(resumeLine('line one\nline two')).toContain('"line one line two"');
  });
});

// ---------------------------------------------------------------------------
// plan (T10 step 4)
// ---------------------------------------------------------------------------

describe('limitPlan', () => {
  it('keeps at most five non-empty lines', () => {
    const plan = limitPlan('a\n\nb\nc\nd\ne\nf\ng');
    expect(plan.split('\n')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('drops code fences the model wraps the plan in', () => {
    expect(limitPlan('```\nscreens: about\n```')).toBe('screens: about');
  });

  it('returns an empty string for an empty answer', () => {
    expect(limitPlan('   \n\n')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// judgment calls (T10 step 8)
// ---------------------------------------------------------------------------

describe('extractJudgmentCalls', () => {
  it('reads a bulleted list under the heading', () => {
    const text = [
      'Changed: src/pages/TeamPage.tsx',
      'Screenshots: /tmp/a-mobile.png',
      '',
      'Judgment calls:',
      '- reused the existing .card class instead of new styles',
      '* kept the nav order unchanged',
      '',
      'Done.',
    ].join('\n');
    expect(extractJudgmentCalls(text)).toEqual([
      'reused the existing .card class instead of new styles',
      'kept the nav order unchanged',
    ]);
  });

  it('reads the inline form', () => {
    expect(extractJudgmentCalls('Judgment calls: none')).toEqual(['none']);
  });

  it('reads a markdown heading with bold decoration', () => {
    const text = '### **Judgement Calls**\n\n1. picked the accent token for the link\n';
    expect(extractJudgmentCalls(text)).toEqual(['picked the accent token for the link']);
  });

  it('stops at the next section instead of swallowing the rest', () => {
    const text = 'Judgment calls:\n- one\n\nScreenshots:\n- /tmp/x.png';
    expect(extractJudgmentCalls(text)).toEqual(['one']);
  });

  it('returns [] when the agent reported none', () => {
    expect(extractJudgmentCalls('Changed: src/App.tsx')).toEqual([]);
    expect(extractJudgmentCalls(undefined)).toEqual([]);
    expect(extractJudgmentCalls('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// file list (T10 step 4)
// ---------------------------------------------------------------------------

describe('frontendFiles', () => {
  it('keeps frontend paths and drops the rest', () => {
    expect(
      frontendFiles(['src/App.tsx', 'api/server.mjs', 'README.md', 'index.html', 'package.json']),
    ).toEqual(['src/App.tsx', 'index.html']);
  });

  it('falls back to the whole list when nothing looks like frontend', () => {
    expect(frontendFiles(['api/server.mjs', 'README.md'])).toEqual(['api/server.mjs', 'README.md']);
  });
});

// ---------------------------------------------------------------------------
// spec file vs description (T10 step 2)
// ---------------------------------------------------------------------------

describe('resolveFeature', () => {
  it('treats a plain description as a description', () => {
    expect(resolveFeature('add an about page')).toEqual({ description: 'add an about page' });
  });

  it('reads an existing file as the spec text', () => {
    const dir = tempDir();
    const spec = path.join(dir, 'spec.md');
    fs.writeFileSync(spec, '# Team page\n\nShow the team.\n', 'utf8');
    expect(resolveFeature('spec.md', dir)).toEqual({
      description: '# Team page\n\nShow the team.',
      specPath: spec,
    });
  });

  it('does not mistake a directory for a spec file', () => {
    const dir = tempDir();
    expect(resolveFeature(dir)).toEqual({ description: dir });
  });
});

// ---------------------------------------------------------------------------
// screenshots (T10 step 6)
// ---------------------------------------------------------------------------

describe('findScreenshots', () => {
  it('finds PNGs recursively, sorted, with size and mtime', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'about-desktop.png'), 'x');
    fs.writeFileSync(path.join(dir, 'about-mobile.png'), '');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    fs.writeFileSync(path.join(dir, 'nested', 'home-mobile.png'), 'yy');

    const found = findScreenshots(dir);
    expect(found.map((f) => path.relative(dir, f.path))).toEqual([
      'about-desktop.png',
      'about-mobile.png',
      path.join('nested', 'home-mobile.png'),
    ]);
    expect(found[1]!.bytes).toBe(0);
    expect(found[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it('returns [] for a directory that does not exist', () => {
    expect(findScreenshots(path.join(tempDir(), 'missing'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkpoint (T10 step 7)
// ---------------------------------------------------------------------------

function initRepo(): string {
  const dir = tempDir('aw-design-git-');
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'aw@example.com');
  run('config', 'user.name', 'aw test');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'seed');
  return dir;
}

describe('checkpoint', () => {
  it('commits the work with the T10 message', async () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'page.tsx'), 'export default null;\n');

    const result = await checkpoint(dir, 'add-an-about-page');
    expect(result.error).toBeUndefined();
    expect(result.committed).toBe(true);
    expect(result.files).toEqual(['page.tsx']);
    const message = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: dir }).toString().trim();
    expect(message).toBe('design-loop(add-an-about-page): checkpoint');
  });

  it('skips cleanly when there is nothing to commit', async () => {
    const dir = initRepo();
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

    const result = await checkpoint(dir, 'nothing');
    expect(result).toEqual({ committed: false, files: [] });
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    expect(after).toBe(before);
  });

  it('reports a git failure instead of throwing', async () => {
    const result = await checkpoint(path.join(tempDir(), 'not-a-repo'), 'x');
    expect(result.committed).toBe(false);
    expect(result.error).toMatch(/git add -A failed/);
  });
});

// ---------------------------------------------------------------------------
// prompts (T10 steps 4 and 5)
// ---------------------------------------------------------------------------

const CFG: AwConfig = {
  workspace: 'fixture',
  repoRoot: '/tmp/repo',
  defaults: { provider: 'lmstudio', model: 'qwen3' },
  app: { baseUrl: 'http://localhost:3001' },
  viewports: { mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } },
};

describe('buildPlanPrompt', () => {
  it('asks for the 5-line plan and lists the frontend files', () => {
    const prompt = buildPlanPrompt({
      description: 'add an about page',
      files: ['src/App.tsx'],
      frontendUrl: 'http://localhost:5173',
    });
    expect(prompt).toContain('Output a UI plan in at most 5 lines: screens, components, states.');
    expect(prompt).toContain('- src/App.tsx');
    expect(prompt).toContain('http://localhost:5173');
  });
});

describe('buildSessionPrompt', () => {
  const base = {
    plan: 'screens: about',
    description: 'add an about page',
    frontendUrl: 'http://localhost:5173',
    repoRoot: '/tmp/repo',
    screenshotDir: '/tmp/repo/screenshots/add-an-about-page',
    cfg: CFG,
  };

  it('carries the T10 step 5 instruction verbatim', () => {
    const prompt = buildSessionPrompt(base);
    expect(prompt).toContain(
      'Implement, then run your self-review checklist loop from your instructions on every touched',
    );
    expect(prompt).toContain('Save final screenshots named <screen>-<viewport>.');
    expect(prompt).not.toContain('re-verify ONLY the affected screens');
  });

  it('prepends the feedback in iterate mode', () => {
    const prompt = buildSessionPrompt({ ...base, iterate: 'make the heading bigger' });
    expect(prompt.startsWith(
      'Apply this feedback to the existing implementation, re-verify ONLY the affected screens: make the heading bigger',
    )).toBe(true);
  });

  it('forbids the two things that would break the run', () => {
    const prompt = buildSessionPrompt(base);
    expect(prompt).toContain('never start, restart or stop a server');
    expect(prompt).toContain('never run `git commit`');
  });
});
