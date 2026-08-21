import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  condensePlan,
  countCases,
  createReportFile,
  extractPlanSection,
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

/** The required tail of T09 step 5, as amended: ===PLAN=== then ===CASES=== then ===SUMMARY===. */
function tail(json: string, summary = 'One case passed.\nOne case failed.'): string {
  return [
    '===PLAN===',
    '- happy: GET /health returns 200',
    '- invalid: POST an item with no name',
    '===CASES===',
    json,
    '===SUMMARY===',
    summary,
  ].join('\n');
}

/** The pre-amendment shape: narration, then ===CASES===, with no ===PLAN=== section. */
function tailWithoutPlan(json: string, preamble = 'Plan:\n1. happy path\n2. invalid input'): string {
  return [preamble, '', '===CASES===', json, '===SUMMARY===', 'done'].join('\n');
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

  it('reads the test plan out of the ===PLAN=== section', () => {
    const r = parse(tail(JSON.stringify([CASE_ONE])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toBe('- happy: GET /health returns 200\n- invalid: POST an item with no name');
    expect(r.planSource).toBe('tail');
    expect(r.warnings).toEqual([]);
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
// missing plan (T09 § Architect amendment)
// ---------------------------------------------------------------------------

describe('parseCasesOutput — ===PLAN===', () => {
  it('uses the LAST ===PLAN=== above ===CASES===, so an echoed template does not win', () => {
    const raw = [
      'I will finish with:',
      '===PLAN===',
      '<the test plan>',
      '===CASES===',
      '[ { TestCase }, ... ]',
      '',
      'Now the real run.',
      '===PLAN===',
      '- happy: the real plan',
      '===CASES===',
      JSON.stringify([CASE_ONE]),
      '===SUMMARY===',
      'all good',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toBe('- happy: the real plan');
    expect(r.planSource).toBe('tail');
  });

  it('tolerates markdown decoration around the marker', () => {
    const r = parse(
      ['**===PLAN===**', '- happy: ping', '===CASES===', JSON.stringify([CASE_ONE])].join('\n'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toBe('- happy: ping');
    expect(r.planSource).toBe('tail');
  });

  it('is a warning, not a failure, when the marker is missing', () => {
    const r = parse(tailWithoutPlan(JSON.stringify([CASE_ONE])));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The cases are the result: a missing plan section never triggers the format retry.
    expect(r.cases).toHaveLength(1);
    expect(r.planSource).toBe('preamble');
    expect(r.plan).toBe('Plan:\n1. happy path\n2. invalid input');
    expect(r.warnings).toContain(
      'no `===PLAN===` marker — plan recovered from the agent’s prose, de-duplicated',
    );
  });

  it('reports planSource "none" when there is no plan text at all', () => {
    const r = parse(['===CASES===', JSON.stringify([CASE_ONE])].join('\n'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toBe('');
    expect(r.planSource).toBe('none');
  });

  it('falls back to the preamble when the ===PLAN=== section is empty', () => {
    const raw = ['thinking out loud', '===PLAN===', '', '===CASES===', JSON.stringify([CASE_ONE])].join(
      '\n',
    );
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.planSource).toBe('preamble');
    // The marker line is not plan text: printing it under `## Test plan` is the very thing the
    // preamble fallback exists to avoid.
    expect(r.plan).toBe('thinking out loud');
    expect(r.warnings.some((w) => w.includes('`===PLAN===` section was empty'))).toBe(true);
  });

  it('bounds the plan section when the model drops ===CASES===', () => {
    const raw = [
      '===PLAN===',
      '- happy: GET /health returns 200',
      '- edge: unknown path',
      JSON.stringify([CASE_ONE]),
      '===SUMMARY===',
      'One case, passing.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Unbounded, the slice ran to the end of the output and the "Test plan" section swallowed
    // the raw case JSON, the ===SUMMARY=== marker and the summary text.
    expect(r.plan).toBe('- happy: GET /health returns 200\n- edge: unknown path');
    expect(r.cases).toHaveLength(1);
    expect(r.summary).toBe('One case, passing.');
    // A section whose end the parser had to guess is not reproduced verbatim.
    expect(r.planSource).toBe('preamble');
  });

  it('never reads an illustrative case array out of the plan as a result', () => {
    const raw = [
      '===PLAN===',
      'The cases I intend to emit look like this:',
      JSON.stringify([{ id: 'x', name: 'EXAMPLE ONLY - not run', kind: 'happy', status: 'PASS' }]),
      'I could not actually run them; the server refused every connection.',
    ].join('\n');
    const r = parse(raw);
    // Reporting PASS for cases that were never executed is the one failure this workflow must
    // not have. No case block below the plan is a parse failure, which triggers the retry.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('below the ===PLAN=== section');
  });

  it('keeps quoted markers out of the plan body', () => {
    const raw = [
      '===PLAN===',
      'I will end my answer with this exact tail:',
      '===CASES===',
      '[ ... ]',
      '===SUMMARY===',
      '<3 lines>',
      'That is the format.',
      '===CASES===',
      JSON.stringify([CASE_ONE]),
      '===SUMMARY===',
      'Done.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).not.toContain('===CASES===');
    expect(r.plan).not.toContain('===SUMMARY===');
    expect(r.summary).toBe('Done.');
  });
});

describe('extractPlanSection', () => {
  it('recovers a plan the model wrote in an intermediate step', () => {
    // The prompt says "First write the test plan … Finally output …", so a model that answers
    // with only ===CASES===/===SUMMARY=== has still written its plan — into the narration.
    const narration = [
      '===PLAN===',
      '- happy: GET /health returns 200',
      '- auth: no token is rejected',
      '',
      'Now running them.',
    ].join('\n');
    expect(extractPlanSection(narration)).toBe(
      '- happy: GET /health returns 200\n- auth: no token is rejected\n\nNow running them.',
    );
    // stripTail cuts AT the marker, which is what threw the plan away.
    expect(stripTail(narration)).toBe('');
  });

  it('stops at the next tail marker and returns "" when there is no section', () => {
    expect(extractPlanSection('===PLAN===\n- happy\n===CASES===\n[]')).toBe('- happy');
    expect(extractPlanSection('no markers here')).toBe('');
    expect(extractPlanSection('===PLAN===\n\n===CASES===\n[]')).toBe('');
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
    // `slugify` is ASCII-only, so a description in another script slugifies to nothing. A digest
    // of the description keeps those runs apart instead of naming every one of them `test-…`.
    expect(path.basename(file)).toMatch(/^test-[0-9a-f]{8}-2026-08-21\.md$/);
    expect(path.basename(createReportFile(dir, '???', '2026-08-21'))).toMatch(/-2\.md$/);
    expect(path.basename(createReportFile(dir, '健康チェック', '2026-08-21'))).not.toBe(
      path.basename(file),
    );
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

  it('leaves a real ===PLAN=== section exactly as the model wrote it', () => {
    const plan = ['- happy: POST a valid item', '- edge: empty name', '- auth: no token'].join('\n');
    expect(condensePlan(plan)).toBe(plan);
  });
});

// The shape of the live acceptance run's "## Test plan" section: the same plan restated, never
// byte-identically, with "Let me …" transitions in between.
const NARRATED_PLAN = [
  "I'll create a test plan for verifying the POST /api/items endpoint behavior when an item has no name, then execute each case.",
  '## Test Plan\n\n### Happy Path\n- POST /api/items with a valid item containing a name field\n- Expect: 201 Created response',
  'Let me first check if the service is running and understand its structure:',
  "I'll create a test plan for verifying the POST /api/items endpoint behavior with items that have no name, then execute each test case.",
  'Let me check what endpoints are available by testing the root path:',
  'I will write a test plan to verify the POST /api/items endpoint behaviour when an item has no name, then execute each test case.',
].join('\n\n');

describe('condensePlan — narration fallback', () => {
  it('collapses a plan the model restated three times into one', () => {
    const restated = [
      'Test plan for POST /api/items:\n- happy: a valid item is created\n- invalid: an item with no name is rejected',
      'Let me check the health endpoint first:',
      'Test plan for the POST /api/items endpoint:\n- happy: a valid item gets created\n- invalid: an item without a name is rejected',
      'Let me look at the source:',
      'Test plan for the POST /api/items endpoint:\n- happy: a valid item is created\n- invalid: an item with no name gets rejected',
    ].join('\n\n');
    const out = condensePlan(restated, { fromNarration: true });
    expect(out.split(/\n{2,}/)).toHaveLength(1);
    expect(out).toContain('Test plan for POST /api/items:');
    expect(out).not.toContain('Let me');
  });

  it('keeps one clean plan out of the live report’s narration', () => {
    const out = condensePlan(NARRATED_PLAN, { fromNarration: true });
    // The single plan body, each section once, and no "Let me …" transitions.
    expect(out.match(/### Happy Path/g)).toHaveLength(1);
    expect(out).not.toContain('Let me');
    expect(out).not.toContain("I'll create a test plan");
    expect(out.split(/\n{2,}/).length).toBeLessThanOrEqual(3);
    expect(out.length).toBeLessThan(NARRATED_PLAN.length / 2);
  });

  it('keeps a restated section once, even when its bullets were reworded', () => {
    // Word overlap alone misses this pair; the repeated heading is what gives it away.
    const text = [
      '### Invalid Input\n- POST /api/items without a name field entirely\n- Expect: 400 Bad Request',
      '### Invalid Input\n- POST /api/items with no name field at all\n- Expect: 400 Bad Request',
    ].join('\n\n');
    const out = condensePlan(text, { fromNarration: true });
    expect(out.match(/### Invalid Input/g)).toHaveLength(1);
    expect(out).toContain('without a name field entirely');
  });

  it('keeps genuinely different sections of a plan', () => {
    const text = [
      '- happy: POST /api/items with a valid name returns 201',
      '- auth: an unauthenticated request is rejected with 401',
    ].join('\n\n');
    expect(condensePlan(text, { fromNarration: true }).split(/\n{2,}/)).toHaveLength(2);
  });

  it('keeps the filler when the narration is nothing but filler', () => {
    const text = ['Let me check the health endpoint:', 'Now let me try the items endpoint:'].join(
      '\n\n',
    );
    expect(condensePlan(text, { fromNarration: true })).not.toBe('');
  });

  it('caps the section far below the ===PLAN=== cap', () => {
    const text = Array.from(
      { length: 200 },
      (_, i) => `Section ${i}: ${'unique-word-' + i} ${'x'.repeat(60)}`,
    ).join('\n\n');
    const out = condensePlan(text, { fromNarration: true });
    expect(out.split(/\n{2,}/).length).toBeLessThanOrEqual(6);
    expect(out.length).toBeLessThanOrEqual(1_500 + '…[truncated]'.length);
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

  it('also cuts at ===PLAN===, so a half-written tail never lands in the report', () => {
    expect(stripTail('Thinking.\n===PLAN===\n- happy\n===CASES===\n[]')).toBe('Thinking.');
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

  it('prints a ===PLAN=== section as written, with no provenance note', () => {
    const md = renderReport({
      ...base,
      plan: '- happy: GET /health returns 200\n- auth: no token is rejected',
      planSource: 'tail',
      cases: [{ ...CASE_ONE } as never],
      rejected: [],
    });
    expect(md).toContain('## Test plan\n\n- happy: GET /health returns 200');
    expect(md).not.toContain('reconstructed from what it wrote');
  });

  it('condenses a plan recovered from narration and says where it came from', () => {
    const md = renderReport({
      ...base,
      plan: NARRATED_PLAN,
      planSource: 'preamble',
      cases: [{ ...CASE_ONE } as never],
      rejected: [],
    });
    const section = md.split('## Test plan')[1]!.split('## Cases')[0]!;
    expect(section).toContain('reconstructed from what it wrote');
    expect(section).not.toContain('Let me');
    // The live report's version of this section was ~40 lines; one clean plan is a handful.
    expect(section.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(12);
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
