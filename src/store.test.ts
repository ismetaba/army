/**
 * T16 — the run store.
 *
 * Two properties carry the whole task and are tested hardest:
 *
 * 1. **No run stays `running`.** A manifest left on `running` is indistinguishable from a run in
 *    progress, so the dashboard would show a ghost forever. Four ways a run can die are checked
 *    against a real child process — a clean finish, an uncaught throw, `fail()` (which calls
 *    `process.exit` and unwinds nothing), and SIGTERM — because none of them can be simulated
 *    in-process: `process.exit()` would take the test runner with it.
 * 2. **No reader throws.** `listRuns` is what the dashboard calls; one truncated manifest must
 *    cost a row, not the page.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunManifest } from '../shared/schemas';
import {
  StoreError,
  appendLog,
  awHome,
  listRuns,
  listWorkspaces,
  newRun,
  readLog,
  readRun,
  runDir,
  runTimestamp,
  runsDir,
  saveArtifact,
  startRun,
  writeManifest,
} from './store';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');

const tmpDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

let home: string;
const previousHome = process.env.AW_HOME;

beforeEach(() => {
  home = scratch('aw-store-');
  process.env.AW_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AW_HOME;
  else process.env.AW_HOME = previousHome;
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A valid manifest, so each test can vary the one field it is about. */
function manifest(patch: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'review-20260102-030405',
    kind: 'review',
    workspace: 'ws',
    createdAt: '2026-01-02T03:04:05.000Z',
    agent: 'code-reviewer',
    provider: 'lmstudio',
    model: 'qwen3-coder-30b-a3b-instruct',
    status: 'running',
    input: { args: 'review --base main', base: 'main' },
    ...patch,
  } as RunManifest;
}

// ---------------------------------------------------------------------------
// awHome
// ---------------------------------------------------------------------------

describe('awHome', () => {
  it('honours AW_HOME', () => {
    expect(awHome()).toBe(home);
  });

  it('falls back to ~/.agent-workflows when AW_HOME is unset', () => {
    delete process.env.AW_HOME;
    expect(awHome()).toBe(path.join(os.homedir(), '.agent-workflows'));
  });

  it('is read on every call, so a moved AW_HOME moves the runs', () => {
    const other = scratch('aw-store-other-');
    process.env.AW_HOME = other;
    expect(runsDir('ws')).toBe(path.join(other, 'ws', 'runs'));
  });
});

// ---------------------------------------------------------------------------
// newRun
// ---------------------------------------------------------------------------

describe('newRun', () => {
  it('creates <awHome>/<workspace>/runs/<runId>/artifacts/', () => {
    const { runId, dir } = newRun('ws', 'review', new Date(2026, 0, 2, 3, 4, 5));
    expect(runId).toBe('review-20260102-030405');
    expect(dir).toBe(path.join(home, 'ws', 'runs', 'review-20260102-030405'));
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(dir, 'artifacts')).isDirectory()).toBe(true);
  });

  it('names the run <kind>-<YYYYMMDD-HHmmss> in local time', () => {
    const at = new Date(2026, 10, 9, 8, 7, 6);
    expect(runTimestamp(at)).toBe('20261109-080706');
    expect(newRun('ws', 'design-loop', at).runId).toBe('design-loop-20261109-080706');
  });

  it('never reuses a directory: a second run in the same second gets -2', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    const first = newRun('ws', 'test-feature', at);
    const second = newRun('ws', 'test-feature', at);
    const third = newRun('ws', 'test-feature', at);
    expect(first.runId).toBe('test-feature-20260102-030405');
    expect(second.runId).toBe('test-feature-20260102-030405-2');
    expect(third.runId).toBe('test-feature-20260102-030405-3');
    expect(new Set([first.dir, second.dir, third.dir]).size).toBe(3);
  });

  it('refuses a workspace name that would escape AW_HOME', () => {
    expect(() => newRun('../evil', 'review')).toThrow(StoreError);
    expect(() => newRun('a/b', 'review')).toThrow(/single segment/);
    expect(() => newRun('', 'review')).toThrow(StoreError);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeManifest
// ---------------------------------------------------------------------------

describe('writeManifest', () => {
  it('writes pretty-printed JSON that zod-parses back', () => {
    const { dir } = newRun('ws', 'review');
    const m = manifest({ status: 'done', durationMs: 1234 });
    writeManifest(dir, m);
    const text = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    expect(text).toContain('\n  "runId"');
    expect(RunManifest.parse(JSON.parse(text))).toEqual(m);
  });

  it('rejects an invalid manifest and writes nothing', () => {
    const { dir } = newRun('ws', 'review');
    // `status: "finished"` is not in the enum; SPEC § Types fixes the four values.
    expect(() => writeManifest(dir, manifest({ status: 'finished' } as never))).toThrow();
    expect(() => writeManifest(dir, { ...manifest(), input: undefined } as never)).toThrow();
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  it('rejects a finding that is not a Finding', () => {
    const { dir } = newRun('ws', 'review');
    const broken = manifest({
      review: { verdict: 'APPROVE', findings: [{ severity: 'HUGE' }], diffArtifact: 'x' },
    } as never);
    expect(() => writeManifest(dir, broken)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// appendLog / saveArtifact
// ---------------------------------------------------------------------------

describe('appendLog', () => {
  it('appends with an [HH:mm:ss] prefix on every line', () => {
    const { dir } = newRun('ws', 'review');
    appendLog(dir, 'first');
    appendLog(dir, 'second\nthird');
    const lines = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/^\[\d{2}:\d{2}:\d{2}] /);
    expect(lines.map((l) => l.slice(11))).toEqual(['first', 'second', 'third']);
  });

  it('never throws when the run directory is gone', () => {
    expect(() => appendLog(path.join(home, 'no', 'such', 'run'), 'x')).not.toThrow();
  });
});

describe('saveArtifact', () => {
  it('writes artifacts/<name> and returns the relative path', () => {
    const { dir } = newRun('ws', 'review');
    expect(saveArtifact(dir, 'diff.patch', 'diff --git a b\n')).toBe('artifacts/diff.patch');
    expect(fs.readFileSync(path.join(dir, 'artifacts', 'diff.patch'), 'utf8')).toBe(
      'diff --git a b\n',
    );
  });

  it('creates sub-directories and keeps binary content intact', () => {
    const { dir } = newRun('ws', 'design-loop');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const rel = saveArtifact(dir, 'screenshots/home-mobile.png', png);
    expect(rel).toBe('artifacts/screenshots/home-mobile.png');
    expect(fs.readFileSync(path.join(dir, ...rel.split('/')))).toEqual(png);
  });

  it('refuses a name that climbs out of artifacts/', () => {
    const { dir } = newRun('ws', 'review');
    expect(() => saveArtifact(dir, '../../escape.txt', 'x')).toThrow(StoreError);
    expect(() => saveArtifact(dir, '', 'x')).toThrow(StoreError);
    expect(fs.existsSync(path.join(home, 'ws', 'runs', 'escape.txt'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listRuns / readRun
// ---------------------------------------------------------------------------

/** Write a finished run at a fixed clock, so ordering is deterministic. */
function seed(workspace: string, kind: RunManifest['kind'], at: Date): string {
  const { runId, dir } = newRun(workspace, kind, at);
  writeManifest(
    dir,
    manifest({ runId, kind, workspace, createdAt: at.toISOString(), status: 'done' }),
  );
  return runId;
}

describe('listRuns', () => {
  it('returns runs newest first', () => {
    const oldest = seed('ws', 'review', new Date(2026, 0, 1, 10, 0, 0));
    const middle = seed('ws', 'test-feature', new Date(2026, 0, 1, 11, 0, 0));
    const newest = seed('ws', 'design-loop', new Date(2026, 0, 2, 9, 0, 0));
    expect(listRuns('ws').map((r) => r.runId)).toEqual([newest, middle, oldest]);
  });

  it('lists every workspace when none is named', () => {
    seed('alpha', 'review', new Date(2026, 0, 1, 10, 0, 0));
    seed('beta', 'review', new Date(2026, 0, 3, 10, 0, 0));
    expect(listRuns().map((r) => r.workspace)).toEqual(['beta', 'alpha']);
  });

  it('skips a corrupt or partial manifest with a warning instead of throwing', () => {
    const good = seed('ws', 'review', new Date(2026, 0, 1, 10, 0, 0));
    // Truncated mid-write — what a run killed by SIGKILL can leave behind.
    const broken = newRun('ws', 'review', new Date(2026, 0, 1, 11, 0, 0));
    fs.writeFileSync(path.join(broken.dir, 'manifest.json'), '{"runId": "review-2026', 'utf8');
    // Valid JSON, wrong shape — an older or newer schema.
    const wrong = newRun('ws', 'review', new Date(2026, 0, 1, 12, 0, 0));
    fs.writeFileSync(path.join(wrong.dir, 'manifest.json'), '{"runId":"x","status":"weird"}', 'utf8');
    // Started but not written yet: the directory exists and holds nothing.
    const empty = newRun('ws', 'review', new Date(2026, 0, 1, 13, 0, 0));

    const warnings: string[] = [];
    const runs = listRuns('ws', { onWarn: (m) => warnings.push(m) });
    expect(runs.map((r) => r.runId)).toEqual([good]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join('\n')).toContain(broken.runId);
    expect(warnings.join('\n')).toContain('not valid JSON');
    expect(warnings.join('\n')).toContain(wrong.runId);
    expect(warnings.join('\n')).toContain(empty.runId);
  });

  it('is empty, not an error, for a workspace that has never run', () => {
    expect(listRuns('never-used')).toEqual([]);
    expect(listRuns()).toEqual([]);
  });
});

describe('readRun', () => {
  it('reads one manifest back', () => {
    const runId = seed('ws', 'review', new Date(2026, 0, 1, 10, 0, 0));
    expect(readRun('ws', runId)?.status).toBe('done');
  });

  it('returns null with a warning for a missing run', () => {
    const warnings: string[] = [];
    expect(readRun('ws', 'review-20260101-100000', { onWarn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings.join('')).toContain('no manifest.json');
  });
});

describe('listWorkspaces', () => {
  it('reads workspaces.json, and shrugs off a broken one', () => {
    const warnings: string[] = [];
    expect(listWorkspaces()).toEqual([]);
    fs.writeFileSync(
      path.join(home, 'workspaces.json'),
      JSON.stringify({ workspaces: [{ name: 'ws', repoRoot: '/tmp/ws', createdAt: 'now' }] }),
      'utf8',
    );
    expect(listWorkspaces().map((w) => w.name)).toEqual(['ws']);
    fs.writeFileSync(path.join(home, 'workspaces.json'), '{oops', 'utf8');
    expect(listWorkspaces({ onWarn: (m) => warnings.push(m) })).toEqual([]);
    expect(warnings.join('')).toContain('not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// startRun — the live recorder
// ---------------------------------------------------------------------------

function start(kind: RunManifest['kind'] = 'review', now?: Date) {
  return startRun({
    workspace: 'ws',
    kind,
    agent: 'code-reviewer',
    provider: 'lmstudio',
    model: 'qwen3-coder-30b-a3b-instruct',
    input: { args: 'review --base main', base: 'main' },
    now,
  });
}

describe('startRun', () => {
  it('writes a running manifest and a non-empty log immediately', () => {
    const run = start();
    const written = readRun('ws', run.runId);
    expect(written?.status).toBe('running');
    expect(written?.input.args).toBe('review --base main');
    expect(written?.provider).toBe('lmstudio');
    expect(readLog('ws', run.runId)).toContain(run.runId);
    run.finish('done');
  });

  it('merges updates without ever leaving `running` early', () => {
    const run = start();
    run.update({ review: { verdict: 'APPROVE', findings: [], diffArtifact: 'artifacts/diff.patch' } });
    expect(readRun('ws', run.runId)?.status).toBe('running');
    expect(readRun('ws', run.runId)?.review?.verdict).toBe('APPROVE');
    run.finish('done');
    const done = readRun('ws', run.runId);
    expect(done?.status).toBe('done');
    expect(done?.review?.verdict).toBe('APPROVE');
    expect(done?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('is idempotent: the first terminal status wins', () => {
    const run = start();
    run.finish('done');
    run.finish('error', { error: 'too late' });
    run.update({ error: 'also too late' });
    expect(readRun('ws', run.runId)?.status).toBe('done');
    expect(readRun('ws', run.runId)?.error).toBeUndefined();
  });

  it('keeps the terminal status even when the result it was handed is invalid', () => {
    const run = start();
    run.finish('done', { review: { verdict: 'NOPE' } } as never);
    const written = readRun('ws', run.runId);
    expect(written?.status).toBe('done');
    expect(written?.error).toContain('manifest rejected');
  });

  it('never lets a rejected update break the run it is recording', () => {
    const run = start();
    // A result block the schema refuses. The run must still finish — recording is not allowed
    // to turn a completed review into a crashed one — but it must say what was lost.
    expect(() => run.update({ test: { reportArtifact: 7 } } as never)).not.toThrow();
    expect(readRun('ws', run.runId)?.status).toBe('running');
    run.finish('done');
    const written = readRun('ws', run.runId);
    expect(written?.status).toBe('done');
    expect(written?.test).toBeUndefined();
    expect(written?.error).toContain('manifest update rejected');
  });

  it('ends as error when the session throws — the workflows’ try/catch, in miniature', async () => {
    const run = start();
    // Exactly what runReview/runTestFeature/runDesignLoop do around their session function.
    await expect(
      (async () => {
        try {
          throw new Error('the session exploded');
        } catch (err) {
          run.finish('error', { error: (err as Error).message });
          throw err;
        }
      })(),
    ).rejects.toThrow('the session exploded');
    const written = readRun('ws', run.runId);
    expect(written?.status).toBe('error');
    expect(written?.error).toBe('the session exploded');
    expect(written?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records artifacts by their relative path', () => {
    const run = start();
    expect(run.artifact('diff.patch', 'x')).toBe('artifacts/diff.patch');
    run.finish('done');
  });
});

// ---------------------------------------------------------------------------
// every run ends terminal — proven against a real process
// ---------------------------------------------------------------------------

/**
 * A child that starts a run and then dies in one of four ways. It has to be a separate process:
 * `fail()` and the exit guard both go through `process.exit`, which would end vitest itself.
 */
const CHILD = `
const store = await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'src/store.ts')).href)});
const common = await import(${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'src/workflows/common.ts')).href)});
const run = store.startRun({
  workspace: 'ws', kind: 'review', agent: 'code-reviewer',
  provider: 'lmstudio', model: 'm', input: { args: 'review --base main', base: 'main' },
});
process.stdout.write(run.runId + '\\n');
const mode = process.argv[2];
if (mode === 'done') {
  run.finish('done');
} else if (mode === 'crash') {
  // No try/catch anywhere: the guard is the only thing that can close this run.
  throw new Error('boom inside the session');
} else if (mode === 'fail') {
  common.fail('the model refused the request');
} else {
  // Hold the process open until the parent signals it.
  setInterval(() => {}, 1000);
}
`;

function childScript(): string {
  const dir = scratch('aw-store-child-');
  const file = path.join(dir, 'child.mjs');
  fs.writeFileSync(file, CHILD, 'utf8');
  return file;
}

const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

describe('a run always reaches a terminal status', () => {
  it('done — the workflow finished', () => {
    const out = spawnSync(TSX, [childScript(), 'done'], {
      env: { ...process.env, AW_HOME: home },
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    const runId = out.stdout.trim().split('\n')[0]!;
    expect(readRun('ws', runId)?.status).toBe('done');
    expect(out.stderr).toContain(`run saved: ws/${runId}`);
  }, 60_000);

  it('error — an uncaught throw inside the session', () => {
    const out = spawnSync(TSX, [childScript(), 'crash'], {
      env: { ...process.env, AW_HOME: home },
      encoding: 'utf8',
    });
    expect(out.status).toBe(1);
    const runId = out.stdout.trim().split('\n')[0]!;
    const written = readRun('ws', runId);
    expect(written?.status).toBe('error');
    expect(written?.durationMs).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('error — fail() exits the process with the reason', () => {
    const out = spawnSync(TSX, [childScript(), 'fail'], {
      env: { ...process.env, AW_HOME: home },
      encoding: 'utf8',
    });
    expect(out.status).toBe(1);
    const runId = out.stdout.trim().split('\n')[0]!;
    const written = readRun('ws', runId);
    expect(written?.status).toBe('error');
    expect(written?.error).toBe('the model refused the request');
    // The reason reached log.txt too, so the panel can show it without the manifest.
    expect(readLog('ws', runId)).toContain('the model refused the request');
  }, 60_000);

  it('cancelled — SIGTERM', async () => {
    const child = spawn(TSX, [childScript(), 'hang'], {
      env: { ...process.env, AW_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runId = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.includes('\n')) resolve(buffer.split('\n')[0]!.trim());
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`child exited before starting a run: ${buffer}`)));
    });
    expect(readRun('ws', runId)?.status).toBe('running');

    const code = await new Promise<number | null>((resolve) => {
      child.once('exit', (exitCode) => resolve(exitCode));
      child.kill('SIGTERM');
    });
    expect(code).toBe(143);
    const written = readRun('ws', runId);
    expect(written?.status).toBe('cancelled');
    expect(written?.error).toContain('SIGTERM');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

describe('runDir', () => {
  it('composes the SPEC § Storage layout', () => {
    expect(runDir('ws', 'review-20260102-030405')).toBe(
      path.join(home, 'ws', 'runs', 'review-20260102-030405'),
    );
  });

  it('refuses a run id that is not a single safe segment', () => {
    expect(() => runDir('ws', '../../etc')).toThrow(StoreError);
  });
});
