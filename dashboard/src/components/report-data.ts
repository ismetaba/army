/**
 * Pure helpers behind the Report tab (T19). No React, no `node:` imports, no fs — the case table
 * is a client component and the summary header is a server component, and both need the same
 * counting, ordering and slug rules. Anything that would make this module server-only belongs in
 * `report-panel.tsx` instead.
 *
 * `@shared/schemas` is imported with `import type` on purpose: the types come from the single
 * source of truth (SPEC § Types) while nothing about zod is pulled into the client bundle.
 */
import type { RunManifest, TestCase } from "@shared/schemas";

export type CaseStatus = TestCase["status"];
export type CaseKind = TestCase["kind"];

/**
 * Display order for statuses — and the sort order of the table (T19 step 1: "FAIL first, table
 * sorted FAIL→PASS").
 *
 * SKIP sits in the middle rather than last because a skipped case is an unanswered question: it
 * is less urgent than a failure and strictly more interesting than a pass, so burying it under
 * sixteen green rows is the one place it would never be read.
 */
export const STATUS_ORDER: readonly CaseStatus[] = ["FAIL", "SKIP", "PASS"];

/** Display order for the kind filter: the qa-tester's own plan order (happy → edge → invalid → auth). */
export const KIND_ORDER: readonly CaseKind[] = ["happy", "edge", "invalid", "auth"];

export interface CaseCounts {
  PASS: number;
  FAIL: number;
  SKIP: number;
  total: number;
}

export function countByStatus(cases: readonly TestCase[]): CaseCounts {
  const counts: CaseCounts = { PASS: 0, FAIL: 0, SKIP: 0, total: cases.length };
  for (const c of cases) counts[c.status] += 1;
  return counts;
}

export function countByKind(cases: readonly TestCase[]): Record<CaseKind, number> {
  const counts: Record<CaseKind, number> = { happy: 0, edge: 0, invalid: 0, auth: 0 };
  for (const c of cases) counts[c.kind] += 1;
  return counts;
}

/**
 * Cases in table order: FAIL, then SKIP, then PASS; within a status the manifest's own order.
 *
 * The tie-break is the ORIGINAL INDEX, not the id: ids are agent-written strings (`c1`…`c16`),
 * and sorting those lexically would put `c10` between `c1` and `c2`. The manifest order is the
 * order the tester ran them in, which is the order the repro steps of one case assume for the
 * next one, so it is the right thing to preserve.
 */
export function sortCases(cases: readonly TestCase[]): TestCase[] {
  return cases
    .map((c, index) => ({ c, index }))
    .sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.c.status) - STATUS_ORDER.indexOf(b.c.status) || a.index - b.index,
    )
    .map((entry) => entry.c);
}

/** `PASS 5/6 — 1 FAIL`, the same one-line verdict the generated report.md carries. */
export function verdictLine(counts: CaseCounts): string {
  const parts = [`PASS ${counts.PASS}/${counts.total}`];
  if (counts.FAIL > 0) parts.push(`${counts.FAIL} FAIL`);
  if (counts.SKIP > 0) parts.push(`${counts.SKIP} SKIP`);
  return parts.join(" — ");
}

/** Percentage of all cases with a given status, 0–100, for the pass-rate bar. */
export function percent(part: number, total: number): number {
  return total <= 0 ? 0 : (part / total) * 100;
}

// ---------------------------------------------------------------------------
// feature slug (T19 step 2)
// ---------------------------------------------------------------------------

/**
 * The human text of the feature a test-feature run covered.
 *
 * `input.feature` is what the workflow records and is used whenever it is there. The fallback
 * matters for runs written before that field was populated (and for any manifest an agent hand-
 * edited): the CLI surface is `test-feature "<desc>" [flags]` (SPEC § CLI commands), so the first
 * double-quoted span of `input.args` IS the description. Failing both, the args line minus its
 * leading command word and minus every `--flag`/`--flag value` pair is the closest thing left.
 */
export function featureLabel(input: RunManifest["input"]): string {
  const feature = input.feature?.trim();
  if (feature) return feature;

  const quoted = /"([^"]*)"/.exec(input.args ?? "");
  if (quoted && quoted[1].trim()) return quoted[1].trim();

  const bare = (input.args ?? "")
    .replace(/^\s*\S+\s*/, "") // drop the command word ("test-feature")
    .replace(/--\S+(\s+(?!--)\S+)?/g, "") // drop `--flag` and `--flag value`
    .trim();
  return bare;
}

/**
 * A comparison key for "these two runs tested the same thing".
 *
 * Deliberately lossy — lowercased, every run of non-alphanumerics collapsed to a single `-`.
 * Two runs of the same feature are typed by a human on two different days, so `POST /api/items
 * rejects an item with no name` and `POST /api/items rejects an item with no name.` must land in
 * the same bucket or the history list is empty exactly when it is most wanted. The cost of the
 * looseness is a false neighbour now and then, which is visible and harmless (the run is linked,
 * you click it, it is about something else) — unlike a false *absence*, which looks like "this
 * feature has never regressed".
 *
 * Which is why "keep letters and digits" means EVERY script's letters and digits (`\p{L}\p{N}`),
 * not `[a-z0-9]`. An ASCII-only class deletes a feature described in Turkish, Chinese, Russian or
 * Greek down to the empty string, and an empty slug matches nothing — so the panel would state
 * outright that no other run covers the feature, which is the exact false absence this function
 * exists to avoid. The owner of this repo writes features in Turkish.
 *
 * Two folds happen before the class, both about the same word typed twice:
 *  - `NFKC`, so a composed `ş` and a `s`+combining-cedilla are one character, not two;
 *  - Turkish dotted/dotless i. `toLowerCase()` is locale-independent by spec, so `İ` becomes
 *    `i`+U+0307 (the combining dot survives as a non-letter and would split the word) while `I`
 *    becomes plain `i` — meaning `GİRİŞİ` and `girişi`, and `KULLANICI` and `kullanıcı`, fold
 *    apart unless `i`+U+0307 and `ı` are both mapped to `i` here.
 */
export function slugify(value: string): string {
  const folded = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/i̇/gu, "i") // lowercased Turkish dotted capital İ
    .replace(/ı/gu, "i"); // Turkish dotless ı
  const slug = folded.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  if (slug !== "") return slug;
  // A feature named entirely in symbols ("→→→") has no letters or digits at all. Falling back to
  // the folded text keeps it grouping with itself instead of collapsing into the "no feature
  // recorded" bucket; a genuinely empty label still yields "", which matches nothing.
  return folded.trim().replace(/\s+/gu, "-");
}

/** The slug two test-feature runs must share to count as runs of the same feature. */
export function featureSlug(input: RunManifest["input"]): string {
  return slugify(featureLabel(input));
}
