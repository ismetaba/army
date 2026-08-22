import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  anchorFindings,
  parseUnifiedDiff,
  rowKey,
  widestLineNumber,
  type DiffFile,
  type DiffLine,
} from "./diff";

/**
 * The parser is the risky half of T18: every finding card is positioned by the NEW line number
 * this file computes, so a silent off-by-one puts a BLOCKER under the wrong line of code. These
 * tests therefore assert whole `[type, oldNo, newNo, text]` tuples rather than spot-checking a
 * count, and they cover each `@@` shape and each patch oddity separately.
 */

/** Compact view of a hunk's rows: one tuple per line, exactly as it will be rendered. */
function rows(lines: DiffLine[]): [DiffLine["type"], number | undefined, number | undefined, string][] {
  return lines.map((l) => [l.type, l.oldNo, l.newNo, l.text]);
}

function onlyFile(patch: string): DiffFile {
  const files = parseUnifiedDiff(patch);
  expect(files).toHaveLength(1);
  return files[0]!;
}

describe("parseUnifiedDiff — hunk shapes", () => {
  it("numbers a mixed hunk on both sides", () => {
    const file = onlyFile(
      [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -10,6 +10,7 @@ function main() {",
        " const a = 1;",
        "-const b = 2;",
        "+const b = 3;",
        "+const c = 4;",
        " const d = 5;",
        " const e = 6;",
        " const f = 7;",
        "",
      ].join("\n"),
    );

    expect(file.file).toBe("src/app.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(2);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0]!;
    expect(hunk.header).toBe("@@ -10,6 +10,7 @@ function main() {");
    expect([hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount]).toEqual([10, 6, 10, 7]);
    expect(hunk.section).toBe("function main() {");
    expect(rows(hunk.lines)).toEqual([
      ["ctx", 10, 10, "const a = 1;"],
      ["del", 11, undefined, "const b = 2;"],
      ["add", undefined, 11, "const b = 3;"],
      ["add", undefined, 12, "const c = 4;"],
      ["ctx", 12, 13, "const d = 5;"],
      ["ctx", 13, 14, "const e = 6;"],
      ["ctx", 14, 15, "const f = 7;"],
    ]);
  });

  it("handles an added-only file: @@ -0,0 +1,3 @@", () => {
    const file = onlyFile(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..3333333",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,3 @@",
        "+alpha",
        "+beta",
        "+gamma",
        "",
      ].join("\n"),
    );

    expect(file.status).toBe("added");
    expect(file.oldPath).toBeNull();
    expect(file.newPath).toBe("new.txt");
    expect(file.additions).toBe(3);
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["add", undefined, 1, "alpha"],
      ["add", undefined, 2, "beta"],
      ["add", undefined, 3, "gamma"],
    ]);
  });

  it("handles a removed-only file: @@ -1,3 +0,0 @@", () => {
    const file = onlyFile(
      [
        "diff --git a/gone.txt b/gone.txt",
        "deleted file mode 100644",
        "index 3333333..0000000",
        "--- a/gone.txt",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-alpha",
        "-beta",
        "-gamma",
        "",
      ].join("\n"),
    );

    expect(file.status).toBe("deleted");
    expect(file.file).toBe("gone.txt");
    expect(file.oldPath).toBe("gone.txt");
    expect(file.newPath).toBeNull();
    expect(file.deletions).toBe(3);
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["del", 1, undefined, "alpha"],
      ["del", 2, undefined, "beta"],
      ["del", 3, undefined, "gamma"],
    ]);
  });

  it("treats a missing count as 1: @@ -1 +1 @@", () => {
    const file = onlyFile(
      ["--- a/one.txt", "+++ b/one.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n"),
    );
    const hunk = file.hunks[0]!;
    expect([hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount]).toEqual([1, 1, 1, 1]);
    expect(rows(hunk.lines)).toEqual([
      ["del", 1, undefined, "old"],
      ["add", undefined, 1, "new"],
    ]);
  });

  it("restarts the counters at every hunk header", () => {
    const file = onlyFile(
      [
        "diff --git a/multi.ts b/multi.ts",
        "--- a/multi.ts",
        "+++ b/multi.ts",
        "@@ -1,2 +1,3 @@",
        " one",
        "+inserted",
        " two",
        "@@ -40,3 +41,3 @@ class Thing {",
        " forty",
        "-forty-one",
        "+forty-one!",
        " forty-two",
        "",
      ].join("\n"),
    );

    expect(file.hunks).toHaveLength(2);
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["ctx", 1, 1, "one"],
      ["add", undefined, 2, "inserted"],
      ["ctx", 2, 3, "two"],
    ]);
    expect(rows(file.hunks[1]!.lines)).toEqual([
      ["ctx", 40, 41, "forty"],
      ["del", 41, undefined, "forty-one"],
      ["add", undefined, 42, "forty-one!"],
      ["ctx", 42, 43, "forty-two"],
    ]);
    expect(widestLineNumber(file)).toBe(43);
  });

  it("keeps an empty context line whose trailing space was stripped", () => {
    const file = onlyFile(
      ["--- a/blank.txt", "+++ b/blank.txt", "@@ -1,3 +1,3 @@", " head", "", "-tail", "+TAIL", ""].join(
        "\n",
      ),
    );
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["ctx", 1, 1, "head"],
      ["ctx", 2, 2, ""],
      ["del", 3, undefined, "tail"],
      ["add", undefined, 3, "TAIL"],
    ]);
  });
});

describe("parseUnifiedDiff — patch oddities", () => {
  it("parses a patch with no trailing newline", () => {
    const patch = ["--- a/tail.txt", "+++ b/tail.txt", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n");
    expect(patch.endsWith("\n")).toBe(false);
    const file = onlyFile(patch);
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["del", 1, undefined, "a"],
      ["add", undefined, 1, "b"],
    ]);
  });

  it("marks the line a `\\ No newline at end of file` follows, on both sides", () => {
    const file = onlyFile(
      [
        "--- a/nn.txt",
        "+++ b/nn.txt",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old last",
        "\\ No newline at end of file",
        "+new last",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    const lines = file.hunks[0]!.lines;
    expect(rows(lines)).toEqual([
      ["ctx", 1, 1, "keep"],
      ["del", 2, undefined, "old last"],
      ["add", undefined, 2, "new last"],
    ]);
    expect(lines[0]!.noNewline).toBeUndefined();
    expect(lines[1]!.noNewline).toBe(true);
    expect(lines[2]!.noNewline).toBe(true);
  });

  it("strips CRLF terminators without disturbing the numbering", () => {
    const file = onlyFile(
      [
        "diff --git a/win.txt b/win.txt",
        "--- a/win.txt",
        "+++ b/win.txt",
        "@@ -1,3 +1,3 @@",
        " context",
        "-before",
        "+after",
        " trailer",
        "",
      ].join("\r\n"),
    );
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["ctx", 1, 1, "context"],
      ["del", 2, undefined, "before"],
      ["add", undefined, 2, "after"],
      ["ctx", 3, 3, "trailer"],
    ]);
    expect(file.hunks[0]!.header).toBe("@@ -1,3 +1,3 @@");
  });

  it("records a binary file and gives it no hunks", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/logo.png b/logo.png",
        "index 1111111..2222222 100644",
        "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/after.txt b/after.txt",
        "--- a/after.txt",
        "+++ b/after.txt",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "",
      ].join("\n"),
    );
    expect(files).toHaveLength(2);
    expect(files[0]!.file).toBe("logo.png");
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.hunks).toEqual([]);
    // The binary entry must not swallow the file that follows it.
    expect(files[1]!.file).toBe("after.txt");
    expect(rows(files[1]!.hunks[0]!.lines)).toEqual([
      ["del", 1, undefined, "x"],
      ["add", undefined, 1, "y"],
    ]);
  });

  it("records a `GIT binary patch` block as binary", () => {
    const file = onlyFile(
      [
        "diff --git a/blob.bin b/blob.bin",
        "new file mode 100644",
        "index 0000000..4444444",
        "GIT binary patch",
        "literal 12",
        "zcmZQzU|? hi",
        "",
      ].join("\n"),
    );
    expect(file.binary).toBe(true);
    expect(file.status).toBe("added");
    expect(file.file).toBe("blob.bin");
  });

  it("reads a rename from its `rename from`/`rename to` lines", () => {
    const file = onlyFile(
      [
        "diff --git a/src/old name.ts b/src/new name.ts",
        "similarity index 92%",
        "rename from src/old name.ts",
        "rename to src/new name.ts",
        "--- a/src/old name.ts",
        "+++ b/src/new name.ts",
        "@@ -3,2 +3,2 @@",
        "-was",
        "+is",
        " same",
        "",
      ].join("\n"),
    );
    expect(file.status).toBe("renamed");
    expect(file.oldPath).toBe("src/old name.ts");
    expect(file.newPath).toBe("src/new name.ts");
    expect(file.file).toBe("src/new name.ts");
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["del", 3, undefined, "was"],
      ["add", undefined, 3, "is"],
      ["ctx", 4, 4, "same"],
    ]);
  });

  it("keeps spaces in a path", () => {
    const file = onlyFile(
      [
        "diff --git a/docs/release notes.md b/docs/release notes.md",
        "--- a/docs/release notes.md",
        "+++ b/docs/release notes.md",
        "@@ -1 +1,2 @@",
        " # Notes",
        "+added",
        "",
      ].join("\n"),
    );
    expect(file.file).toBe("docs/release notes.md");
    expect(file.oldPath).toBe("docs/release notes.md");
    expect(file.newPath).toBe("docs/release notes.md");
    expect(file.status).toBe("modified");
  });

  it("unquotes a C-quoted unicode path", () => {
    const file = onlyFile(
      [
        'diff --git "a/src/caf\\303\\251 \\342\\200\\224 men\\303\\274.ts" "b/src/caf\\303\\251 \\342\\200\\224 men\\303\\274.ts"',
        '--- "a/src/caf\\303\\251 \\342\\200\\224 men\\303\\274.ts"',
        '+++ "b/src/caf\\303\\251 \\342\\200\\224 men\\303\\274.ts"',
        "@@ -1 +1 @@",
        "-espresso",
        "+ristretto",
        "",
      ].join("\n"),
    );
    expect(file.file).toBe("src/café — menü.ts");
    expect(file.newPath).toBe("src/café — menü.ts");
    expect(file.status).toBe("modified");
  });

  it("accepts an unquoted unicode path (core.quotepath=false)", () => {
    const file = onlyFile(
      [
        "diff --git a/src/café.ts b/src/café.ts",
        "--- a/src/café.ts",
        "+++ b/src/café.ts",
        "@@ -2 +2 @@",
        "-x",
        "+y",
        "",
      ].join("\n"),
    );
    expect(file.file).toBe("src/café.ts");
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["del", 2, undefined, "x"],
      ["add", undefined, 2, "y"],
    ]);
  });

  it("strips only one prefix level, so a real top-level `b/` directory survives", () => {
    const file = onlyFile(
      ["--- a/b/thing.ts", "+++ b/b/thing.ts", "@@ -1 +1 @@", "-x", "+y", ""].join("\n"),
    );
    expect(file.oldPath).toBe("b/thing.ts");
    expect(file.newPath).toBe("b/thing.ts");
    expect(file.status).toBe("modified");
  });

  it("drops the timestamp `diff -u` appends after a tab", () => {
    const file = onlyFile(
      [
        "--- a/plain.txt\t2026-08-22 00:45:04.000000000 +0300",
        "+++ b/plain.txt\t2026-08-22 00:45:05.000000000 +0300",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "",
      ].join("\n"),
    );
    expect(file.file).toBe("plain.txt");
  });

  it("splits concatenated patches that have no `diff --git` lines", () => {
    const files = parseUnifiedDiff(
      [
        "--- a/one.txt",
        "+++ b/one.txt",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-a",
        "+b",
        "--- a/two.txt",
        "+++ b/two.txt",
        "@@ -5,1 +5,2 @@",
        " head",
        "+tail",
        "",
      ].join("\n"),
    );
    expect(files.map((f) => f.file)).toEqual(["one.txt", "two.txt"]);
    expect(rows(files[1]!.hunks[0]!.lines)).toEqual([
      ["ctx", 5, 5, "head"],
      ["add", undefined, 6, "tail"],
    ]);
  });
});

describe("parseUnifiedDiff — our own truncation markers", () => {
  it("flags `…[diff for X truncated]` on its own line and ends the hunk there", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/big.ts b/big.ts",
        "--- a/big.ts",
        "+++ b/big.ts",
        "@@ -1,40 +1,80 @@",
        " one",
        "+two",
        "…[diff for big.ts truncated]",
        "diff --git a/small.ts b/small.ts",
        "--- a/small.ts",
        "+++ b/small.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
        "",
      ].join("\n"),
    );

    expect(files.map((f) => f.file)).toEqual(["big.ts", "small.ts"]);
    expect(files[0]!.truncated).toBe(true);
    expect(rows(files[0]!.hunks[0]!.lines)).toEqual([
      ["ctx", 1, 1, "one"],
      ["add", undefined, 2, "two"],
    ]);
    // The file after the marker is intact and NOT marked truncated.
    expect(files[1]!.truncated).toBe(false);
    expect(rows(files[1]!.hunks[0]!.lines)).toEqual([
      ["del", 1, undefined, "x"],
      ["add", undefined, 1, "y"],
    ]);
  });

  it("keeps the half-written line the marker is glued to, flagged `partial`", () => {
    // `collectDiff` slices BYTES and appends the marker, so the cut can land mid-line.
    const file = onlyFile(
      [
        "diff --git a/big.ts b/big.ts",
        "--- a/big.ts",
        "+++ b/big.ts",
        "@@ -10,5 +10,9 @@",
        " context",
        "+const complete = 1;",
        "+const halfWri…[diff for big.ts truncated]",
        "",
      ].join("\n"),
    );

    expect(file.truncated).toBe(true);
    const lines = file.hunks[0]!.lines;
    expect(rows(lines)).toEqual([
      ["ctx", 10, 10, "context"],
      ["add", undefined, 11, "const complete = 1;"],
      ["add", undefined, 12, "const halfWri"],
    ]);
    expect(lines[2]!.partial).toBe(true);
    expect(lines[1]!.partial).toBeUndefined();
  });

  it("does NOT treat a reviewed file's own content as a marker", () => {
    // The marker is this toolkit's own output, so a repo whose source or docs quote it at
    // end-of-line used to end that file's diff early: +/- counts zeroed, a bogus "truncated"
    // tag, and every finding below the line un-anchored. `collectDiff` only ever emits the
    // marker at EOF or immediately before the next `diff --git`, so only those positions count.
    const file = onlyFile(
      [
        "diff --git a/marker.txt b/marker.txt",
        "--- a/marker.txt",
        "+++ b/marker.txt",
        "@@ -1,3 +1,4 @@",
        " normal",
        " something …[diff truncated]",
        " tail",
        "+more",
        "",
      ].join("\n"),
    );

    expect(file.truncated).toBe(false);
    expect(file.additions).toBe(1);
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["ctx", 1, 1, "normal"],
      ["ctx", 2, 2, "something …[diff truncated]"],
      ["ctx", 3, 3, "tail"],
      ["add", undefined, 4, "more"],
    ]);
  });

  it("flags the whole-patch `…[diff truncated]` marker", () => {
    const file = onlyFile(
      [
        "diff --git a/only.ts b/only.ts",
        "--- a/only.ts",
        "+++ b/only.ts",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "…[diff truncated]",
      ].join("\n"),
    );
    expect(file.truncated).toBe(true);
    expect(rows(file.hunks[0]!.lines)).toEqual([
      ["ctx", 1, 1, "a"],
      ["del", 2, undefined, "b"],
    ]);
  });
});

describe("anchorFindings", () => {
  const patch = [
    "diff --git a/api/server.mjs b/api/server.mjs",
    "--- a/api/server.mjs",
    "+++ b/api/server.mjs",
    "@@ -19,3 +19,5 @@",
    " const BUILD = {};",
    "+const TOKEN = 'secret';",
    "+",
    " let nextId = 4;",
    "-const items = [];",
    "+const items = [1];",
    "diff --git a/web/util.ts b/web/util.ts",
    "--- a/web/util.ts",
    "+++ b/web/util.ts",
    "@@ -1 +1 @@",
    "-export const x = 1;",
    "+export const x = 2;",
    "",
  ].join("\n");
  const files = parseUnifiedDiff(patch);

  it("places a finding under the row whose NEW number it names", () => {
    const finding = { severity: "MAJOR", file: "api/server.mjs", line: 20 };
    const { byRow, unanchored } = anchorFindings(files, [finding]);
    expect(unanchored).toEqual([]);
    // hunk 0 of file 0: line index 1 is `+const TOKEN = 'secret';`, new line 20.
    expect(files[0]!.hunks[0]!.lines[1]!.newNo).toBe(20);
    expect(byRow.get(rowKey(0, 0, 1))).toEqual([finding]);
  });

  it("anchors on context rows too, not just additions", () => {
    const finding = { file: "api/server.mjs", line: 19 };
    const { byRow } = anchorFindings(files, [finding]);
    expect(byRow.get(rowKey(0, 0, 0))).toEqual([finding]);
  });

  it("never drops a finding whose line is not in the diff", () => {
    const bogus = { severity: "BLOCKER", file: "api/server.mjs", line: 9999 };
    const { byRow, unanchored } = anchorFindings(files, [bogus]);
    expect(byRow.size).toBe(0);
    expect(unanchored).toEqual([bogus]);
  });

  it("never drops a finding for a file the diff does not contain", () => {
    const bogus = { file: "src/untouched.ts", line: 1 };
    expect(anchorFindings(files, [bogus]).unanchored).toEqual([bogus]);
  });

  it("does not anchor on a removed line: a deletion has no new line number", () => {
    // `-export const x = 1;` is old line 1 of web/util.ts; new line 1 is the ADDED row.
    const { byRow } = anchorFindings(files, [{ file: "web/util.ts", line: 1 }]);
    const key = byRow.keys().next().value!;
    const [fi, hi, li] = key.split(":").map(Number);
    expect(files[fi!]!.hunks[hi!]!.lines[li!]!.type).toBe("add");
  });

  it("collects several findings on one row, in input order", () => {
    const a = { file: "api/server.mjs", line: 20, title: "a" };
    const b = { file: "api/server.mjs", line: 20, title: "b" };
    expect(anchorFindings(files, [a, b]).byRow.get(rowKey(0, 0, 1))).toEqual([a, b]);
  });

  it("tolerates a `./` prefix and a unique suffix match", () => {
    expect(anchorFindings(files, [{ file: "./api/server.mjs", line: 20 }]).unanchored).toEqual([]);
    expect(anchorFindings(files, [{ file: "/repo/api/server.mjs", line: 20 }]).unanchored).toEqual(
      [],
    );
  });

  it("leaves an AMBIGUOUS suffix unanchored rather than guessing a file", () => {
    const twoServers = parseUnifiedDiff(
      [
        "--- a/api/server.mjs",
        "+++ b/api/server.mjs",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "--- a/edge/server.mjs",
        "+++ b/edge/server.mjs",
        "@@ -1 +1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    const finding = { file: "server.mjs", line: 1 };
    expect(anchorFindings(twoServers, [finding]).unanchored).toEqual([finding]);
  });
});

// ---------------------------------------------------------------------------
// the real seeded run (T18 is built against it; see tasks/T18.md § Acceptance)
// ---------------------------------------------------------------------------

const AW_HOME = process.env.AW_HOME?.trim() || path.join(os.homedir(), ".agent-workflows");
const SEEDED = path.join(AW_HOME, "fixture/runs/review-20260822-004504");
const seededPatch = path.join(SEEDED, "artifacts/diff.patch");
const hasSeed = fs.existsSync(seededPatch);

describe.skipIf(!hasSeed)("the seeded review run review-20260822-004504", () => {
  const patch = fs.readFileSync(seededPatch, "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(SEEDED, "manifest.json"), "utf8")) as {
    review: { verdict: string; findings: { file: string; line: number; title: string }[] };
  };
  const files = parseUnifiedDiff(patch);

  it("finds the three changed files with the right statuses", () => {
    expect(files.map((f) => [f.file, f.status, f.additions, f.deletions])).toEqual([
      ["api/server.mjs", "modified", 21, 0],
      ["src/components/SearchPanel.tsx", "added", 52, 0],
      ["src/pages/HomePage.tsx", "modified", 29, 19],
    ]);
    expect(files.every((f) => !f.truncated && !f.binary)).toBe(true);
  });

  it("puts every one of the six findings on a real row", () => {
    const { byRow, unanchored } = anchorFindings(files, manifest.review.findings);
    expect(unanchored).toEqual([]);
    expect([...byRow.values()].flat()).toHaveLength(6);
  });

  it("anchors each finding to the exact source line the patch shows there", () => {
    // Read off `artifacts/diff.patch` by hand — this is the assertion that would catch an
    // off-by-one in the `@@ -a,b +c,d @@` counters.
    const expected: Record<string, string> = {
      "api/server.mjs:22": "const SEARCH_API_TOKEN = 'sk_live_EXAMPLE_FIXTURE_NOT_A_REAL_KEY';",
      "api/server.mjs:125": "    const q = url.searchParams.get('q') || '';",
      "api/server.mjs:135": "      results.push({ ...match, rank, share: match.qty / totalQty, related });",
      "src/components/SearchPanel.tsx:30": "        value={q}",
      "src/components/SearchPanel.tsx:42": '      <ul className="item-list">',
      "src/components/SearchPanel.tsx:45":
        '            <span className="item-row__name">{result.name}</span>',
    };

    const { byRow } = anchorFindings(files, manifest.review.findings);
    const seen: Record<string, string> = {};
    for (const [key, findings] of byRow) {
      const [fi, hi, li] = key.split(":").map(Number);
      const line = files[fi!]!.hunks[hi!]!.lines[li!]!;
      for (const f of findings) seen[`${f.file}:${f.line}`] = line.text;
    }
    expect(seen).toEqual(expected);
  });

  it("leaves a finding with a bogus line number unanchored (acceptance step 3)", () => {
    const tampered = manifest.review.findings.map((f, i) =>
      i === 0 ? { ...f, line: 100_000 } : f,
    );
    const { byRow, unanchored } = anchorFindings(files, tampered);
    expect(unanchored.map((f) => f.title)).toEqual([manifest.review.findings[0]!.title]);
    expect([...byRow.values()].flat()).toHaveLength(5);
  });
});
