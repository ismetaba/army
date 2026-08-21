import { describe, expect, it } from 'vitest';
import { formatReview, parseReviewOutput } from './review';

/** Every assertion below also proves the parser did not throw — it always returns a result. */
function parse(raw: unknown) {
  return parseReviewOutput(raw);
}

const WELL_FORMED = [
  'VERDICT: REQUEST CHANGES',
  '',
  '[BLOCKER] src/auth.ts:42 — JWT signature not verified',
  'Risk: any forged token is accepted.',
  'Fix: call jwt.verify(token, SECRET) instead of jwt.decode.',
  '',
  '[MINOR] src/api.ts:10 — magic number',
  'Risk: unclear intent.',
  'Fix: extract a named constant.',
].join('\n');

describe('parseReviewOutput — well-formed output', () => {
  it('parses the SPEC example verbatim', () => {
    const r = parse(WELL_FORMED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict).toBe('REQUEST CHANGES');
    expect(r.warnings).toEqual([]);
    expect(r.findings).toEqual([
      {
        severity: 'BLOCKER',
        file: 'src/auth.ts',
        line: 42,
        title: 'JWT signature not verified',
        risk: 'any forged token is accepted.',
        fix: 'call jwt.verify(token, SECRET) instead of jwt.decode.',
      },
      {
        severity: 'MINOR',
        file: 'src/api.ts',
        line: 10,
        title: 'magic number',
        risk: 'unclear intent.',
        fix: 'extract a named constant.',
      },
    ]);
  });

  it('sorts findings BLOCKER → NIT regardless of the order the model emitted', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '[NIT] a.ts:1 — nit',
      'Risk: r',
      'Fix: f',
      '',
      '[MAJOR] b.ts:2 — major',
      'Risk: r',
      'Fix: f',
      '',
      '[BLOCKER] c.ts:3 — blocker',
      'Risk: r',
      'Fix: f',
      '',
      '[MINOR] d.ts:4 — minor',
      'Risk: r',
      'Fix: f',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.map((f) => f.severity)).toEqual(['BLOCKER', 'MAJOR', 'MINOR', 'NIT']);
  });

  it('joins wrapped Risk:/Fix: continuation lines', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '[MAJOR] src/a.ts:7 — unbounded query',
      'Risk: the endpoint loads every row,',
      'which takes the database down under load.',
      'Fix: add pagination',
      'with a hard limit of 100.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0]!.risk).toBe(
      'the endpoint loads every row, which takes the database down under load.',
    );
    expect(r.findings[0]!.fix).toBe('add pagination with a hard limit of 100.');
  });
});

describe('parseReviewOutput — tolerated deviations', () => {
  it('skips leading prose before the VERDICT line and warns', () => {
    const raw = ['Sure! Here is my review of the diff.', '', WELL_FORMED].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict).toBe('REQUEST CHANGES');
    expect(r.findings).toHaveLength(2);
    expect(r.warnings).toContain('ignored 1 line(s) of prose before the VERDICT line');
  });

  it('collects findings emitted before the VERDICT line (verdict last)', () => {
    const raw = [
      'Here is what I found:',
      '',
      '[BLOCKER] api/server.mjs:22 — hardcoded API token',
      'Risk: the secret ships in the repo.',
      'Fix: read it from process.env.',
      '',
      'VERDICT: REQUEST CHANGES',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict).toBe('REQUEST CHANGES');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.file).toBe('api/server.mjs');
    // The finding block is not counted as prose — only the one real prose line is.
    expect(r.warnings).toContain('ignored 1 line(s) of prose before the VERDICT line');
  });

  it('accepts findings written as a markdown list', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '- [BLOCKER] api/server.mjs:124 — RegExp built from raw user input',
      '- Risk: catastrophic backtracking takes the API down.',
      '- Fix: escape the input and cap its length.',
      '',
      '2. [NIT] api/server.mjs:9 — stale comment',
      '2. Risk: misleads the next reader.',
      '2. Fix: delete it.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.map((f) => `${f.severity} ${f.file}:${f.line}`)).toEqual([
      'BLOCKER api/server.mjs:124',
      'NIT api/server.mjs:9',
    ]);
    expect(r.findings[0]!.fix).toBe('escape the input and cap its length.');
  });

  it('accepts findings wrapped in markdown emphasis, headings or block quotes', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '**[BLOCKER] api/server.mjs:22 — hardcoded API token**',
      '**Risk:** the secret ships in the repo.',
      'Fix: read it from process.env.',
      '',
      '### [MAJOR] api/server.mjs:124 — RegExp built from raw user input',
      'Risk: catastrophic backtracking.',
      'Fix: cap the length.',
      '',
      '> [NIT] api/server.mjs:9 — stale comment',
      'Risk: misleads the next reader.',
      'Fix: delete it.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.map((f) => `${f.severity} ${f.file}:${f.line}`)).toEqual([
      'BLOCKER api/server.mjs:22',
      'MAJOR api/server.mjs:124',
      'NIT api/server.mjs:9',
    ]);
    expect(r.findings[0]!.risk).toBe('the secret ships in the repo.');
    expect(r.warnings).toEqual([]);
  });

  it('warns about a decorated finding line that still does not match, instead of dropping it', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '**[BLOCKER] api/server.mjs — no line number**',
      'Risk: r',
      'Fix: f',
      '',
      'Also, I rated the token issue [MAJOR] but could not locate it.',
      '',
      '[MINOR] api/server.mjs:9 — stale comment',
      'Risk: r',
      'Fix: f',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.map((f) => f.severity)).toEqual(['MINOR']);
    expect(r.warnings.some((w) => w.includes('[BLOCKER] api/server.mjs — no line number'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('[MAJOR] but could not locate it'))).toBe(true);
  });

  it('fails the parse when every finding is a decorated near miss (so the retry fires)', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '**[BLOCKER] api/server.mjs - hyphen and no line**',
      'Risk: r',
      'Fix: f',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/1 finding line\(s\) did not match/);
  });

  it('strips control characters so model text cannot inject ANSI escapes into stdout', () => {
    const esc = String.fromCharCode(27);
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      `[BLOCKER] a.ts:1 — bad ${esc}[31mRED${esc}[0m`,
      `Risk: ${esc}[2Kwiped`,
      'Fix: f',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0]!.title).not.toContain(esc);
    expect(formatReview(r.verdict, r.findings)).not.toContain(esc);
  });

  it('rejects an implausible line number rather than re-rendering a different one', () => {
    const r = parse(['VERDICT: REQUEST CHANGES', '', '[BLOCKER] a.ts:99999999999999999999 — bad'].join('\n'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.warnings.some((w) => w.includes('implausible line number'))).toBe(true);
  });

  it('handles CRLF line endings', () => {
    const r = parse(WELL_FORMED.replace(/\n/g, '\r\n'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict).toBe('REQUEST CHANGES');
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]!.title).toBe('JWT signature not verified');
    // A surviving \r would show up at the end of the last captured group.
    expect(r.findings[1]!.fix).toBe('extract a named constant.');
  });

  it('keeps an em dash inside the title (splits on the first separator only)', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '[MAJOR] src/a.ts:12 — input is trusted — and then compiled into a RegExp',
      'Risk: catastrophic backtracking.',
      'Fix: cap the length and escape the input.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0]).toMatchObject({
      file: 'src/a.ts',
      line: 12,
      title: 'input is trusted — and then compiled into a RegExp',
    });
  });

  it('handles a file path containing spaces', () => {
    const raw = [
      'VERDICT: APPROVE WITH NITS',
      '',
      '[NIT] src/my components/Search Panel.tsx:3 — unused import',
      'Risk: dead code.',
      'Fix: remove it.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0]!.file).toBe('src/my components/Search Panel.tsx');
    expect(r.findings[0]!.line).toBe(3);
  });

  it('handles a path that itself ends in a colon-number (takes the last one as the line)', () => {
    const r = parse(['VERDICT: APPROVE WITH NITS', '', '[NIT] src/a.ts:42:10 — column noise'].join('\n'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings[0]).toMatchObject({ file: 'src/a.ts:42', line: 10 });
  });

  it('reports a missing Risk/Fix line as a warning instead of dropping the finding', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '[BLOCKER] src/a.ts:5 — hardcoded API token',
      'Fix: read it from the environment.',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.risk).toBe('');
    expect(r.findings[0]!.fix).toBe('read it from the environment.');
    expect(r.warnings).toContain('finding src/a.ts:5 has no Risk: line');
    // ...and the re-rendered output still has the exact contract shape.
    expect(formatReview(r.verdict, r.findings)).toBe(
      [
        'VERDICT: REQUEST CHANGES',
        '',
        '[BLOCKER] src/a.ts:5 — hardcoded API token',
        'Risk: (not provided)',
        'Fix: read it from the environment.',
      ].join('\n'),
    );
  });

  it('accepts zero findings', () => {
    const r = parse('VERDICT: APPROVE\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.verdict).toBe('APPROVE');
    expect(r.findings).toEqual([]);
    expect(formatReview(r.verdict, r.findings)).toBe('VERDICT: APPROVE');
  });

  it('warns when APPROVE is contradicted by findings', () => {
    const r = parse(['VERDICT: APPROVE', '', '[MAJOR] a.ts:1 — t', 'Risk: r', 'Fix: f'].join('\n'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toContain('verdict APPROVE contradicts 1 reported finding(s)');
  });

  it('ignores an unknown severity but keeps the valid findings, with a warning', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '[CRITICAL] src/a.ts:1 — not a SPEC severity',
      'Risk: r',
      'Fix: f',
      '',
      '[MAJOR] src/b.ts:2 — real finding',
      'Risk: r',
      'Fix: f',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.findings.map((f) => f.file)).toEqual(['src/b.ts']);
    expect(r.warnings.some((w) => w.includes('[CRITICAL]'))).toBe(true);
  });
});

describe('parseReviewOutput — format failures (never throws)', () => {
  it('fails when the VERDICT line is missing', () => {
    const r = parse('The code looks mostly fine to me.\n[MAJOR] a.ts:1 — x\nRisk: r\nFix: f');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/VERDICT/);
  });

  it('fails on a mis-spelled verdict value', () => {
    expect(parse('VERDICT: LGTM').ok).toBe(false);
    expect(parse('Verdict: APPROVE').ok).toBe(false);
    expect(parse('VERDICT: APPROVE WITH NITS!').ok).toBe(false);
  });

  it('fails when every finding line is malformed (rather than reporting zero findings)', () => {
    const raw = [
      'VERDICT: REQUEST CHANGES',
      '',
      '[BLOCKER] src/a.ts:12 - hyphen instead of an em dash',
      'Risk: r',
      'Fix: f',
      '',
      '[MAJOR] src/b.ts — no line number',
      'Risk: r',
      'Fix: f',
    ].join('\n');
    const r = parse(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/2 finding line\(s\) did not match/);
  });

  it('fails on empty, whitespace-only and non-string input', () => {
    for (const value of ['', '   \n\t ', undefined, null, 42, {}, []]) {
      const r = parse(value);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('the model returned no text');
    }
  });
});

describe('formatReview → parseReviewOutput round trip', () => {
  it('re-parses its own output identically', () => {
    const first = parse(WELL_FORMED);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = parse(formatReview(first.verdict, first.findings));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.findings).toEqual(first.findings);
    expect(second.verdict).toBe(first.verdict);
    expect(second.warnings).toEqual([]);
  });
});
