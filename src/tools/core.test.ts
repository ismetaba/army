import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCKED_BASH_PATTERNS, blockedBashPattern, makeCoreTools } from './core';

const ALL_TOOLS = [
  'read_file',
  'glob',
  'grep',
  'git_diff',
  'git_log',
  'write_file',
  'edit_file',
  'bash',
  'http_request',
];

/** Invoke a tool's execute() the way the AI SDK would. */
async function call(tools: ToolSet, name: string, input: unknown): Promise<any> {
  const entry = (tools as Record<string, any>)[name];
  if (!entry?.execute) throw new Error(`tool "${name}" is not in this profile`);
  return await entry.execute(input as any, {
    toolCallId: 'test-call',
    messages: [],
    context: undefined,
  } as any);
}

/** A temp repo (`repoRoot`) plus a sibling directory that must stay unreachable. */
let repoRoot: string;
let outsideDir: string;
let baseUrl: string;
let server: http.Server;

const BIG_LINE = 'x'.repeat(500);

beforeAll(async () => {
  const tmp = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aw-core-')));
  repoRoot = path.join(tmp, 'repo');
  outsideDir = path.join(tmp, 'outside');
  await fs.promises.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fs.promises.mkdir(path.join(repoRoot, 'test-reports', 'tmp'), { recursive: true });
  await fs.promises.mkdir(path.join(repoRoot, 'node_modules', 'dep'), { recursive: true });
  await fs.promises.mkdir(outsideDir, { recursive: true });

  await fs.promises.writeFile(
    path.join(repoRoot, 'src', 'x.ts'),
    'export const needle = 1;\nexport const two = 2;\nexport const three = 3;\n',
  );
  await fs.promises.writeFile(path.join(repoRoot, 'src', 'dup.ts'), '// TODO\nconst a = 1;\n// TODO\n');
  await fs.promises.writeFile(path.join(repoRoot, 'node_modules', 'dep', 'index.ts'), 'needle\n');
  await fs.promises.writeFile(path.join(repoRoot, 'big.txt'), `${BIG_LINE}\n`.repeat(60));
  await fs.promises.writeFile(path.join(outsideDir, 'secret.txt'), 'TOP SECRET\n');
  // symlink escape: <repo>/link-out -> <tmp>/outside
  await fs.promises.symlink(outsideDir, path.join(repoRoot, 'link-out'), 'dir');

  // a real git repo so git_diff / git_log have something to report
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'seed commit');
  await fs.promises.appendFile(path.join(repoRoot, 'src', 'x.ts'), 'export const four = 4;\n');

  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (repoRoot) await fs.promises.rm(path.dirname(repoRoot), { recursive: true, force: true });
});

describe('permission profiles (SPEC tools table)', () => {
  it('reviewer gets read-only tools and has no write/bash/http keys at all', () => {
    const tools = makeCoreTools('reviewer', repoRoot);
    expect(Object.keys(tools).sort()).toEqual(
      ['git_diff', 'git_log', 'glob', 'grep', 'read_file'].sort(),
    );
    for (const forbidden of ['write_file', 'edit_file', 'bash', 'http_request']) {
      expect(forbidden in tools).toBe(false);
      expect((tools as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it('designer and tester get every core tool', () => {
    expect(Object.keys(makeCoreTools('designer', repoRoot)).sort()).toEqual([...ALL_TOOLS].sort());
    expect(Object.keys(makeCoreTools('tester', repoRoot)).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('calling a tool the profile lacks is impossible (no key to call)', async () => {
    await expect(call(makeCoreTools('reviewer', repoRoot), 'bash', { command: 'echo hi' })).rejects.toThrow(
      'not in this profile',
    );
  });
});

describe('read_file', () => {
  const tools = () => makeCoreTools('reviewer', repoRoot);

  it('returns numbered lines', async () => {
    const res = await call(tools(), 'read_file', { path: 'src/x.ts' });
    expect(res.error).toBeUndefined();
    expect(res.path).toBe('src/x.ts');
    expect(res.content).toContain('1\texport const needle = 1;');
    expect(res.totalLines).toBeGreaterThan(3);
  });

  it('honours offset and limit', async () => {
    const res = await call(tools(), 'read_file', { path: 'src/x.ts', offset: 2, limit: 1 });
    expect(res.startLine).toBe(2);
    expect(res.endLine).toBe(2);
    expect(res.content).toBe('2\texport const two = 2;');
  });

  it('truncates output at 8 KB', async () => {
    const res = await call(tools(), 'read_file', { path: 'big.txt' });
    expect(res.content.endsWith('…[truncated]')).toBe(true);
    expect(res.content.length).toBeLessThan(9 * 1024);
  });

  it('returns {error} instead of throwing for a missing file', async () => {
    const res = await call(tools(), 'read_file', { path: 'src/nope.ts' });
    expect(typeof res.error).toBe('string');
    expect(res.error).toMatch(/ENOENT|no such file/i);
  });

  it('returns {error} for a directory', async () => {
    const res = await call(tools(), 'read_file', { path: 'src' });
    expect(res.error).toContain('directory');
  });
});

describe('path containment', () => {
  const tools = () => makeCoreTools('designer', repoRoot);

  it('refuses "../" escapes', async () => {
    const res = await call(tools(), 'read_file', { path: '../outside/secret.txt' });
    expect(res.error).toContain('repoRoot');
  });

  it('refuses nested "../" escapes', async () => {
    const res = await call(tools(), 'read_file', { path: 'src/../../outside/secret.txt' });
    expect(res.error).toContain('repoRoot');
  });

  it('refuses absolute paths outside the repo', async () => {
    const res = await call(tools(), 'read_file', { path: path.join(outsideDir, 'secret.txt') });
    expect(res.error).toContain('repoRoot');
  });

  it('refuses reads through a symlink that leaves the repo', async () => {
    const res = await call(tools(), 'read_file', { path: 'link-out/secret.txt' });
    expect(res.error).toContain('repoRoot');
    expect(res.content).toBeUndefined();
  });

  it('refuses writes through a symlink that leaves the repo', async () => {
    const res = await call(tools(), 'write_file', { path: 'link-out/pwned.txt', content: 'x' });
    expect(res.error).toContain('repoRoot');
    expect(fs.existsSync(path.join(outsideDir, 'pwned.txt'))).toBe(false);
  });

  it('refuses writes outside the repo', async () => {
    const res = await call(tools(), 'write_file', {
      path: path.join(outsideDir, 'pwned2.txt'),
      content: 'x',
    });
    expect(res.error).toContain('repoRoot');
    expect(fs.existsSync(path.join(outsideDir, 'pwned2.txt'))).toBe(false);
  });

  it('refuses a grep path outside the repo', async () => {
    const res = await call(tools(), 'grep', { pattern: 'SECRET', path: '../outside' });
    expect(res.error).toContain('repoRoot');
  });
});

describe('write_file / edit_file permissions', () => {
  it('tester write_file outside test-reports/tmp is refused', async () => {
    const res = await call(makeCoreTools('tester', repoRoot), 'write_file', {
      path: 'src/x.ts',
      content: 'nope',
    });
    expect(res.error).toContain('test-reports/tmp');
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'x.ts'), 'utf8')).not.toBe('nope');
  });

  it('tester edit_file outside test-reports/tmp is refused', async () => {
    const res = await call(makeCoreTools('tester', repoRoot), 'edit_file', {
      path: 'src/x.ts',
      old: 'two',
      new: 'zwei',
    });
    expect(res.error).toContain('test-reports/tmp');
  });

  it('tester may write under test-reports/tmp/', async () => {
    const res = await call(makeCoreTools('tester', repoRoot), 'write_file', {
      path: 'test-reports/tmp/report.md',
      content: '# report\n',
    });
    expect(res.error).toBeUndefined();
    expect(res.written).toBe(true);
    expect(fs.readFileSync(path.join(repoRoot, 'test-reports', 'tmp', 'report.md'), 'utf8')).toBe(
      '# report\n',
    );
  });

  it('designer may write anywhere inside the repo', async () => {
    const res = await call(makeCoreTools('designer', repoRoot), 'write_file', {
      path: 'src/generated/new.ts',
      content: 'export const ok = true;\n',
    });
    expect(res.error).toBeUndefined();
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'generated', 'new.ts'), 'utf8')).toContain('ok');
  });
});

describe('edit_file', () => {
  const tools = () => makeCoreTools('designer', repoRoot);

  it('rejects a non-unique "old"', async () => {
    const res = await call(tools(), 'edit_file', { path: 'src/dup.ts', old: '// TODO', new: '// done' });
    expect(res.error).toContain('not unique');
    expect(res.error).toContain('2 matches');
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'dup.ts'), 'utf8')).toContain('// TODO');
  });

  it('rejects an "old" with no match', async () => {
    const res = await call(tools(), 'edit_file', { path: 'src/dup.ts', old: 'absent', new: 'x' });
    expect(res.error).toContain('no match');
  });

  it('replaces a unique "old"', async () => {
    const res = await call(tools(), 'edit_file', {
      path: 'src/dup.ts',
      old: 'const a = 1;',
      new: 'const a = 42;',
    });
    expect(res.error).toBeUndefined();
    expect(res.replaced).toBe(1);
    expect(fs.readFileSync(path.join(repoRoot, 'src', 'dup.ts'), 'utf8')).toContain('const a = 42;');
  });

  it('writes "new" literally, without reinterpreting $$ / $& / $` / $\' patterns', async () => {
    const file = path.join(repoRoot, 'src', 'dollars.ts');
    await fs.promises.writeFile(file, 'before\nPLACEHOLDER\nafter\n');
    const replacement = '$$ x $& y $` z $\' w $1';
    const res = await call(tools(), 'edit_file', {
      path: 'src/dollars.ts',
      old: 'PLACEHOLDER',
      new: replacement,
    });
    expect(res.error).toBeUndefined();
    expect(res.replaced).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(`before\n${replacement}\nafter\n`);
  });
});

describe('bash guardrails', () => {
  const tools = () => makeCoreTools('designer', repoRoot);

  it('rejects "git push origin main"', async () => {
    const res = await call(tools(), 'bash', { command: 'git push origin main' });
    expect(res.error).toContain('blocked');
    expect(res.error).toContain('blocked by guardrails:');
    expect(res.exitCode).toBeUndefined();
  });

  it.each([
    'git push origin main',
    'rm -rf build',
    'rm -f node_modules/x',
    'git reset --hard HEAD~1',
    'dd if=/dev/zero of=/dev/sda',
    'mkfs.ext4 /dev/sda1',
    ': > important.txt',
  ])('rejects %s', async (command) => {
    const res = await call(tools(), 'bash', { command });
    expect(res.error).toContain('blocked by guardrails:');
  });

  it('every SPEC pattern is wired up', () => {
    expect(BLOCKED_BASH_PATTERNS.map(String)).toEqual([
      '/git\\s+push/',
      '/\\brm\\s+(-\\w*\\s+)*-\\w*[rf]/',
      '/git\\s+reset\\s+--hard/',
      '/\\bdd\\b/',
      '/mkfs/',
      '/:\\s*>\\s*/',
    ]);
    expect(blockedBashPattern('echo safe')).toBeNull();
    expect(String(blockedBashPattern('git push'))).toBe('/git\\s+push/');
  });

  it('runs allowed commands in repoRoot', async () => {
    const res = await call(tools(), 'bash', { command: 'echo hi && basename "$PWD"' });
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hi');
    expect(res.stdout).toContain('repo');
  });

  it('reports a non-zero exit as a result, not a tool error', async () => {
    const res = await call(tools(), 'bash', { command: 'echo boom 1>&2; exit 3' });
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('boom');
  });
});

describe('bash timeout kills the whole process group', () => {
  const tools = () => makeCoreTools('designer', repoRoot);

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Signal 0 only probes for existence — it delivers nothing. */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** The backgrounded child records its own pid; wait for the file to appear, then read it. */
  async function readPidFile(file: string): Promise<number> {
    for (let i = 0; i < 50; i++) {
      const raw = (await fs.promises.readFile(file, 'utf8').catch(() => '')).trim();
      if (/^\d+$/.test(raw)) return Number(raw);
      await sleep(100);
    }
    throw new Error(`background child never wrote its pid to ${file}`);
  }

  async function expectReaped(pid: number): Promise<void> {
    // Signalling the group is asynchronous, and a killed child lingers as a zombie until
    // its reparented-to-init parent reaps it.
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    expect(alive(pid)).toBe(false);
  }

  it('leaves no orphan when a backgrounded grandchild outlives the timeout', async () => {
    const pidFile = path.join(repoRoot, 'test-reports', 'tmp', 'orphan.pid');
    await fs.promises.rm(pidFile, { force: true });
    // The shape that leaked port 3001: the outer shell backgrounds a long-lived process and
    // then blocks, so the timeout fires with a live grandchild that killing only the direct
    // child (what `exec()` did) never reaches.
    const command = `sh -c 'echo $$ > "${pidFile}"; exec sleep 45' & sleep 45`;

    const res = await call(tools(), 'bash', { command, timeoutMs: 1000 });
    expect(res.error).toBeUndefined();
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.command).toBe(command);
    expect(typeof res.stdout).toBe('string');
    expect(typeof res.stderr).toBe('string');

    await expectReaped(await readPidFile(pidFile));
  }, 30_000);

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const pidFile = path.join(repoRoot, 'test-reports', 'tmp', 'stubborn.pid');
    await fs.promises.rm(pidFile, { force: true });
    // `trap "" TERM` is what an npm wrapper effectively does to the polite signal, so only
    // the SIGKILL escalation can free this one.
    const command =
      `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' & sleep 45`;

    const res = await call(tools(), 'bash', { command, timeoutMs: 1000 });
    expect(res.error).toBeUndefined();
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();

    await expectReaped(await readPidFile(pidFile));
  }, 30_000);

  it('a command that finishes in time is unaffected', async () => {
    const res = await call(tools(), 'bash', { command: 'echo quick', timeoutMs: 5000 });
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBeUndefined();
    expect(res.stdout).toContain('quick');
  });
});

describe('grep / glob / git', () => {
  const tools = () => makeCoreTools('reviewer', repoRoot);

  it('greps the repo and skips node_modules', async () => {
    const res = await call(tools(), 'grep', { pattern: 'needle' });
    expect(res.error).toBeUndefined();
    expect(res.matches).toContain('src/x.ts');
    expect(res.matches).not.toContain('node_modules');
  });

  it('treats a pattern starting with "-" as a pattern, not a grep flag', async () => {
    await fs.promises.writeFile(path.join(repoRoot, 'src', 'dash.html'), '<!-- c -->\nplain\n');
    const res = await call(tools(), 'grep', { pattern: '-->' });
    expect(res.error).toBeUndefined();
    expect(res.matches).toContain('src/dash.html');
    expect(res.matches).not.toContain('plain');
  });

  it('treats "no match" as a normal empty result', async () => {
    const res = await call(tools(), 'grep', { pattern: 'zzz-definitely-absent-zzz' });
    expect(res.error).toBeUndefined();
    expect(res.matches).toBe('');
  });

  it('globs repo files and skips node_modules', async () => {
    const res = await call(tools(), 'glob', { pattern: '**/*.ts' });
    expect(res.error).toBeUndefined();
    expect(res.files).toContain('src/x.ts');
    expect(res.files.some((f: string) => f.includes('node_modules'))).toBe(false);
  });

  it('refuses glob patterns that escape repoRoot', async () => {
    for (const pattern of ['../*', '../outside/*', 'src/../../outside/*']) {
      const res = await call(tools(), 'glob', { pattern });
      expect(res.error).toContain('escapes repoRoot');
      expect(res.files).toBeUndefined();
    }
  });

  it('refuses absolute glob patterns', async () => {
    const res = await call(tools(), 'glob', { pattern: '/etc/hos*' });
    expect(res.error).toContain('must be relative to repoRoot');
    expect(res.files).toBeUndefined();
  });

  it('never returns matches from a symlink that points outside repoRoot', async () => {
    const res = await call(tools(), 'glob', { pattern: '**/*.txt' });
    expect(res.error).toBeUndefined();
    expect(res.files.some((f: string) => f.startsWith('link-out/'))).toBe(false);
    expect(res.files.some((f: string) => f.includes('secret.txt'))).toBe(false);
  });

  it('git_log lists commits', async () => {
    const res = await call(tools(), 'git_log', { limit: 5 });
    expect(res.error).toBeUndefined();
    expect(res.log).toContain('seed commit');
  });

  it('git_diff shows uncommitted changes', async () => {
    const res = await call(tools(), 'git_diff', {});
    expect(res.error).toBeUndefined();
    expect(res.diff).toContain('export const four = 4;');
  });

  it('returns {error} when the repo is not a git repo', async () => {
    const res = await call(makeCoreTools('reviewer', outsideDir), 'git_log', {});
    expect(res.error).toContain('git log failed');
  });
});

describe('http_request destructive guard', () => {
  const NON_LOCAL = 'https://aw-test.invalid/api/things';

  it('allows POST to localhost/127.0.0.1 without the flag', async () => {
    const res = await call(makeCoreTools('tester', repoRoot), 'http_request', {
      method: 'POST',
      url: `${baseUrl}/echo`,
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(res.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body).toContain('"method":"POST"');
    expect(res.body).toContain('{\\"a\\":1}');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s to a non-local host without allowDestructive',
    async (method) => {
      const res = await call(makeCoreTools('tester', repoRoot), 'http_request', {
        method,
        url: NON_LOCAL,
      });
      expect(res.error).toBe('destructive call to non-local target requires --allow-destructive');
    },
  );

  it('passes the guard when allowDestructive is set (3rd arg)', async () => {
    const res = await call(makeCoreTools('tester', repoRoot, true), 'http_request', {
      method: 'DELETE',
      url: NON_LOCAL,
    });
    // The host does not resolve (RFC 6761 .invalid), so we get a network error —
    // the point is that it is no longer the guardrail error.
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain('allow-destructive');
  }, 15000);

  it('never blocks non-local GET', async () => {
    const res = await call(makeCoreTools('tester', repoRoot), 'http_request', {
      method: 'GET',
      url: NON_LOCAL,
    });
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain('allow-destructive');
  }, 15000);

  it('returns {error} for an invalid url', async () => {
    const res = await call(makeCoreTools('designer', repoRoot), 'http_request', {
      method: 'GET',
      url: 'not-a-url',
    });
    expect(res.error).toContain('invalid url');
  });
});
