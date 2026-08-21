import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  condensePlan,
  countCases,
  createReportFile,
  isLooping,
  localDate,
  offTargetOrigins,
  parseCasesOutput,
  renderReport,
  stripTail,
} from './test-feature';

/** Every assertion below also proves the parser did not throw — it always returns a result. */
function parse(raw: unknown) {
  return parseCasesOutput(raw);
}

const CASE_ONE = {
  id: 'c1',
  name: 'GET /health returns 200',
  kind: 'happy',
  status: 'PASS',
  request: 'GET http://localhost:3001/health',
  response: '200 {"status":"ok"}',
};

const CASE_TWO = {
  id: 'c2',
  name: 'POST /api/items rejects an empty name',
  kind: 'invalid',
  status: 'FAIL',
  request: 'POST http://localhost:3001/api/items\n{"qty":1}',
  response: '201 {"id":4,"qty":1}',
  reproSteps: ['POST an item with no name', 'observe 201 instead of 400'],
  severity: 'MAJOR',
};

function tail(json: string, summary = 'One case passed.\nOne case failed.'): string {
  return ['Plan:', '1. happy path', '2. invalid input', '', '===CASES===', json, '===SUMMARY===', summary].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// well-formed
// ---------------------------------------------------------------------------

describe('parseCasesOutput — well-formed tail', () => {
  it('parses the required format verbatim', () => {
    const r = parse(tail(JSON.stringify([CASE_ONE, CASE_TWO], null, 2)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.cases).toEqual([
      {
        id: 'c1',
        name: 'GET /health returns 200',
        kind: 'happy',
        status: 'PASS',
        request: 'GET http://localhost:3001/health',
        response: '200 {"status":"ok"}',
        reproSteps: undefined,
        severity: undefined,
      },
      {
        id: 'c2',
        name: 'POST /api/items rejects an empty name',
        kind: 'invalid',
        status: 'FAIL',
        request: 'POST http://localhost:3001/api/items\n{"qty":1}',
        response: '201 {"id":4,"qty":1}',
        reproSteps: ['POST an item with no name', 'observe 201 instead of 400'],
        severity: 'MAJOR',
      },
    ]);
    expect(r.summary).toBe('One case passed.\nOne case failed.');
  });

  it('keeps everything before ===CASES=== as the test plan', () => {
    const r = parse(tail(JSON.stringify([CASE_ONE])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toBe('Plan:\n1. happy path\n2. invalid input');
  });

  it('caps the summary at 3 lines and says so', () => {
    const r = parse(tail(JSON.stringify([CASE_ONE]), 'l1\nl2\nl3\nl4'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toBe('l1\nl2\nl3');
    expect(r.warnings).toContain('summary was 4 lines — kept the first 3');
  });

  it('uses the LAST ===CASES=== marker, so an echoed prompt template does not win', () => {
    const raw = [
      'I will finish with:',
      '===CASES===',
      '[ { TestCase }, ... ]',
      '===SUMMARY===',
      '<3 lines max>',
      '',
      'Now the real run.',
      '===CASES===',
      JSON.stringify([CASE_ONE]),
      '===SUMMARY===',
      'all good',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]!.id).toBe('c1');
    expect(r.summary).toBe('all good');
  });
});

// ---------------------------------------------------------------------------
// tolerated deviations
// ---------------------------------------------------------------------------

describe('parseCasesOutput — tolerated deviations', () => {
  it('accepts the JSON wrapped in a markdown code fence', () => {
    const raw = [
      '===CASES===',
      '```json',
      JSON.stringify([CASE_ONE, CASE_TWO]),
      '```',
      '===SUMMARY===',
      'fenced but fine',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(r.summary).toBe('fenced but fine');
  });

  it('ignores trailing prose after the closing bracket', () => {
    const raw = [
      '===CASES===',
      JSON.stringify([CASE_ONE]),
      '',
      'Note: I could not test the auth path because no account is configured.',
      '===SUMMARY===',
      'one case',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases).toHaveLength(1);
  });

  it('wraps a single object emitted instead of an array', () => {
    const raw = ['===CASES===', JSON.stringify(CASE_TWO), '===SUMMARY===', 'just one'].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]!.status).toBe('FAIL');
    expect(r.warnings).toContain(
      '===CASES=== held a single object instead of an array — wrapped it',
    );
  });

  it('parses CRLF output identically to LF output', () => {
    const lf = tail(JSON.stringify([CASE_ONE, CASE_TWO]));
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = parse(lf);
    const b = parse(crlf);
    expect(b.ok).toBe(true);
    expect(b).toEqual(a);
  });

  it('repairs trailing commas', () => {
    const raw = [
      '===CASES===',
      `[ ${JSON.stringify(CASE_ONE)}, ]`,
      '===SUMMARY===',
      'trailing comma',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases).toHaveLength(1);
    expect(r.warnings).toContain('repaired trailing comma(s) in the ===CASES=== JSON');
  });

  it('accepts a bare array delimited only by ===SUMMARY===', () => {
    const raw = [
      JSON.stringify([CASE_ONE, CASE_TWO]),
      '===SUMMARY===',
      'the opening marker was dropped',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(r.plan).toBe('');
    expect(r.summary).toBe('the opening marker was dropped');
    expect(r.warnings).toContain(
      'no `===CASES===` marker — read the text before `===SUMMARY===` as the cases',
    );
  });

  it('accepts a bare array with no markers at all', () => {
    const r = parse(JSON.stringify([CASE_ONE]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases.map((c) => c.id)).toEqual(['c1']);
    expect(r.summary).toBe('');
    expect(r.warnings).toContain(
      'no `===CASES===` marker — parsed the whole output as the case list',
    );
  });

  it('accepts markdown decoration around the markers', () => {
    const raw = [
      '**===CASES===**',
      JSON.stringify([CASE_ONE]),
      '## ===SUMMARY===',
      'decorated',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toBe('decorated');
  });

  it('normalises status synonyms and records the reading', () => {
    const raw = [
      '===CASES===',
      JSON.stringify([{ ...CASE_ONE, status: 'passed' }]),
      '===SUMMARY===',
      's',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases[0]!.status).toBe('PASS');
    expect(r.warnings).toContain('case 0: status "passed" read as PASS');
  });

  it('falls back to kind "edge" rather than losing a graded case', () => {
    const raw = [
      '===CASES===',
      JSON.stringify([{ ...CASE_ONE, kind: 'smoke' }]),
      '===SUMMARY===',
      's',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases[0]!.kind).toBe('edge');
    expect(r.cases[0]!.status).toBe('PASS');
    expect(r.warnings).toContain('case 0: kind "smoke" not recognised — recorded as "edge"');
  });

  it('stringifies a request/response the model emitted as an object', () => {
    const raw = [
      '===CASES===',
      JSON.stringify([
        { ...CASE_TWO, request: { method: 'POST', url: '/api/items' }, response: { status: 201 } },
      ]),
      '===SUMMARY===',
      's',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases[0]!.request).toContain('"method": "POST"');
    expect(r.cases[0]!.response).toContain('"status": 201');
  });
});

// ---------------------------------------------------------------------------
// missing summary
// ---------------------------------------------------------------------------

describe('parseCasesOutput — missing ===SUMMARY===', () => {
  it('still returns the cases, with an empty summary and a warning', () => {
    const raw = ['===CASES===', JSON.stringify([CASE_ONE, CASE_TWO])].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases).toHaveLength(2);
    expect(r.summary).toBe('');
    expect(r.warnings).toContain(
      'no `===SUMMARY===` marker — summary generated from the counts',
    );
  });
});

// ---------------------------------------------------------------------------
// rejected / failing input
// ---------------------------------------------------------------------------

describe('parseCasesOutput — an unknown status value', () => {
  it('rejects that case but keeps the valid ones, reproducing the raw entry', () => {
    const bad = { ...CASE_ONE, id: 'c9', status: 'INCONCLUSIVE' };
    const raw = ['===CASES===', JSON.stringify([CASE_TWO, bad]), '===SUMMARY===', 's'].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cases.map((c) => c.id)).toEqual(['c2']);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.index).toBe(1);
    expect(r.rejected[0]!.reason).toContain('status');
    expect(r.rejected[0]!.raw).toContain('INCONCLUSIVE');
    expect(r.warnings.some((w) => w.startsWith('case 1 dropped —'))).toBe(true);
  });

  it('fails (so the caller retries) when EVERY case has an unknown status', () => {
    const raw = [
      '===CASES===',
      JSON.stringify([{ ...CASE_ONE, status: 'INCONCLUSIVE' }]),
      '===SUMMARY===',
      's',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('all 1 case object(s) were invalid');
    expect(r.reason).toContain('status');
  });

  it('rejects a case with no status at all', () => {
    const { status: _drop, ...noStatus } = CASE_ONE;
    const raw = ['===CASES===', JSON.stringify([noStatus]), '===SUMMARY===', 's'].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('no "status" field');
  });
});

describe('parseCasesOutput — unusable output', () => {
  it('fails on invalid JSON, naming the parse error', () => {
    const raw = ['===CASES===', '[ { "id": "c1", "name": }, ]', '===SUMMARY===', 's'].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('not valid JSON');
  });

  it('fails on an unbalanced array', () => {
    const raw = ['===CASES===', `[ ${JSON.stringify(CASE_ONE)}`, '===SUMMARY===', 's'].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('no balanced JSON');
  });

  it('fails on prose with no marker and no JSON', () => {
    const r = parse('I ran the tests and everything looked fine.');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('the output contains no balanced JSON array or object');
  });

  it('fails on prose that merely contains a bracket', () => {
    const r = parse('I checked the list [items] and it looked fine.');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('not valid JSON');
  });

  it('fails on an empty case array', () => {
    const r = parse(['===CASES===', '[]', '===SUMMARY===', 'nothing'].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('empty');
  });

  it('fails on an empty ===CASES=== block', () => {
    const r = parse(['===CASES===', '', '===SUMMARY===', 'nothing'].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('the ===CASES=== block is empty');
  });

  it.each([['', 'empty string'], [undefined, 'undefined'], [42, 'a number']] as const)(
    'fails on non-text output without throwing (%s)',
    (raw, _label) => {
      const r = parse(raw);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('the model returned no text');
    },
  );
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-t09-'));
  tmpDirs.push(dir);
  return dir;
}

describe('createReportFile', () => {
  it('never overwrites: the same description on the same day gets -2, -3', () => {
    const dir = path.join(tmpDir(), 'test-reports');
    const desc = 'the health endpoint returns 200 with build info';
    const a = createReportFile(dir, desc, '2026-08-21');
    const b = createReportFile(dir, desc, '2026-08-21');
    const c = createReportFile(dir, desc, '2026-08-21');
    expect(path.basename(a)).toBe('the-health-endpoint-returns-200-with-build-info-2026-08-21.md');
    expect(path.basename(b)).toBe('the-health-endpoint-returns-200-with-build-info-2026-08-21-2.md');
    expect(path.basename(c)).toBe('the-health-endpoint-returns-200-with-build-info-2026-08-21-3.md');
    expect(fs.readFileSync(a, 'utf8')).toBe('');
  });

  it('creates the directory and survives a description with no usable characters', () => {
    const dir = path.join(tmpDir(), 'nested', 'test-reports');
    const file = createReportFile(dir, '???', '2026-08-21');
    expect(path.basename(file)).toBe('test-2026-08-21.md');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('truncates a very long description to a usable filename', () => {
    const dir = path.join(tmpDir(), 'test-reports');
    const file = createReportFile(dir, 'x'.repeat(400), '2026-08-21');
    expect(path.basename(file).length).toBeLessThanOrEqual(80 + '-2026-08-21.md'.length);
  });
});

describe('condensePlan', () => {
  it('drops paragraphs the model repeated while spinning', () => {
    const repeated = "I'll create a test plan and execute each case.";
    const text = [repeated, 'Happy: GET /health returns 200.', `${repeated}   `, repeated].join(
      '\n\n',
    );
    expect(condensePlan(text)).toBe(`${repeated}\n\nHappy: GET /health returns 200.`);
  });

  it('caps the plan at 4 KB', () => {
    const text = Array.from({ length: 400 }, (_, i) => `paragraph ${i} ${'x'.repeat(40)}`).join(
      '\n\n',
    );
    const out = condensePlan(text);
    expect(out.length).toBeLessThanOrEqual(4 * 1024 + '…[truncated]'.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('is empty for empty input', () => {
    expect(condensePlan('   \n\n  ')).toBe('');
  });
});

describe('isLooping', () => {
  const call = (name: string, input: unknown) => ({ toolCalls: [{ toolName: name, input }] });

  it('is false below the repeat limit', () => {
    expect(isLooping({ steps: [call('git_log', { limit: 5 }), call('git_log', { limit: 5 })] })).toBe(
      false,
    );
  });

  it('is true when the last 5 steps repeat the identical call', () => {
    const steps = [call('read_file', { path: 'a' }), ...Array.from({ length: 5 }, () => call('git_log', { limit: 5 }))];
    expect(isLooping({ steps })).toBe(true);
  });

  it('is false when the inputs differ', () => {
    const steps = Array.from({ length: 5 }, (_, i) => call('read_file', { path: `f${i}` }));
    expect(isLooping({ steps })).toBe(false);
  });

  it('is false for steps that called no tool, however many there are', () => {
    expect(isLooping({ steps: Array.from({ length: 9 }, () => ({ toolCalls: [] })) })).toBe(false);
  });
});

describe('stripTail', () => {
  it('keeps narration and drops anything from ===CASES=== onwards', () => {
    expect(stripTail('Plan:\n1. happy\n===CASES===\n[{"id":"c1"}]')).toBe('Plan:\n1. happy');
  });

  it('returns the whole text when there is no marker', () => {
    expect(stripTail('Plan:\n1. happy\r\n2. edge')).toBe('Plan:\n1. happy\n2. edge');
  });
});

describe('localDate', () => {
  it('formats the local calendar day, zero-padded', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
  });
});

describe('renderReport', () => {
  const base = {
    desc: 'POST /api/items rejects an item with no name',
    target: 'http://localhost:3001',
    provider: 'lmstudio',
    model: 'qwen3-coder-30b-a3b-instruct',
    plan: 'Plan:\n1. happy\n2. invalid',
    summary: 'One failure found.',
    warnings: [] as string[],
    startedAt: new Date('2026-08-21T10:00:00.000Z'),
  };

  it('records the exact request and response of a failure', () => {
    const md = renderReport({
      ...base,
      cases: [
        { ...CASE_TWO, kind: 'invalid', status: 'FAIL', severity: 'MAJOR' } as never,
      ],
      rejected: [],
    });
    expect(md).toContain('# Test report — POST /api/items rejects an item with no name');
    expect(md).toContain('## Test plan');
    expect(md).toContain('### 1. POST /api/items rejects an empty name — FAIL');
    expect(md).toContain('POST http://localhost:3001/api/items');
    expect(md).toContain('201 {"id":4,"qty":1}');
    expect(md).toContain('1. POST an item with no name');
    expect(md).toContain('- **Result:** PASS 0/1 — 1 FAIL');
    expect(md).toContain('## Summary');
    expect(md).toContain('One failure found.');
  });

  it('states the gap when a FAIL carries no evidence', () => {
    const md = renderReport({
      ...base,
      cases: [{ id: 'c1', name: 'no evidence', kind: 'edge', status: 'FAIL' } as never],
      rejected: [],
    });
    expect(md).toContain('Request: _not recorded by the agent._');
    expect(md).toContain('Response: _not recorded by the agent._');
  });

  it('reproduces rejected entries instead of dropping them', () => {
    const md = renderReport({
      ...base,
      cases: [{ ...CASE_ONE } as never],
      rejected: [{ index: 1, reason: 'status: invalid option', raw: '{"status":"INCONCLUSIVE"}' }],
    });
    expect(md).toContain('## Unparseable cases');
    expect(md).toContain('entry 1 — status: invalid option');
    expect(md).toContain('INCONCLUSIVE');
  });

  it('uses a longer fence when the quoted text contains one', () => {
    const md = renderReport({
      ...base,
      cases: [
        { ...CASE_ONE, status: 'FAIL', response: '```\nnot json\n```' } as never,
      ],
      rejected: [],
    });
    expect(md).toContain('````\n```\nnot json\n```\n````');
  });
});

describe('offTargetOrigins', () => {
  it('is empty when every request names the target', () => {
    expect(offTargetOrigins([CASE_ONE as never], 'http://localhost:3001')).toEqual([]);
  });

  it('reports the origin the agent actually called', () => {
    expect(offTargetOrigins([CASE_ONE as never], 'http://localhost:9')).toEqual([
      'http://localhost:3001',
    ]);
  });

  it('is surfaced in the report header', () => {
    const md = renderReport({
      desc: 'health check',
      target: 'http://localhost:9',
      provider: 'lmstudio',
      model: 'm',
      plan: '',
      summary: 'all good',
      warnings: [],
      startedAt: new Date('2026-08-21T10:00:00.000Z'),
      cases: [CASE_ONE as never],
      rejected: [],
    });
    expect(md).toContain('**Evidence is off target:**');
    expect(md).toContain('`http://localhost:3001`');
  });
});

describe('countCases', () => {
  it('counts each status and the total', () => {
    expect(
      countCases([
        { ...CASE_ONE, status: 'PASS' } as never,
        { ...CASE_TWO, status: 'FAIL' } as never,
        { ...CASE_ONE, id: 'c3', status: 'SKIP' } as never,
      ]),
    ).toEqual({ passed: 1, failed: 1, skipped: 1, total: 3 });
  });
});
