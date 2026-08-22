/**
 * A unified-diff parser, written by hand (T18 step 1 / step 3: no diff2html, no dependencies).
 *
 * PURE. No `node:` imports, no React — the run page parses on the server and hands the result to
 * a client component, and the anchoring helpers below run in the browser as the severity filter
 * changes. `TextEncoder`/`TextDecoder` are the only globals used, and both exist in Node and in
 * every browser the panel targets.
 *
 * What it has to survive, because the input is `artifacts/diff.patch` — whatever `git diff`
 * produced in someone else's repo, possibly cut short by our own 60 KB budget:
 *
 * - every `@@ -a,b +c,d @@` shape, including the one-sided `@@ -0,0 +1,52 @@` of a new file, the
 *   `@@ -1,3 +0,0 @@` of a deletion, and the count-less `@@ -1 +1 @@`;
 * - `\ No newline at end of file`, and a patch whose own text has no trailing newline;
 * - CRLF, both as the patch's line terminator and as the reviewed file's;
 * - binary files (`Binary files … differ`, `GIT binary patch`), renames, mode-only changes;
 * - paths with spaces, and paths git C-quotes because they hold non-ASCII (`"a/caf\303\251.txt"`);
 * - `…[diff for <file> truncated]` — the marker `src/workflows/review.ts` inserts when the diff
 *   exceeds the model's budget. It is appended to a BYTE slice, so it can be glued onto the tail
 *   of a half-written diff line rather than sitting on a line of its own.
 *
 * The one thing that must be exactly right is the NEW line number of every rendered row: that is
 * what `Finding.line` anchors on (SPEC § Types), and a card under the wrong line is worse than no
 * card at all.
 */

export type DiffLineType = "ctx" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  /** 1-based line number on the OLD side. Absent on added lines. */
  oldNo?: number;
  /** 1-based line number on the NEW side. Absent on removed lines — findings anchor on this. */
  newNo?: number;
  /** Line content WITHOUT the leading `+`/`-`/space marker. */
  text: string;
  /** `\ No newline at end of file` followed this line in the patch. */
  noNewline?: boolean;
  /** The byte budget cut this line in half; `text` is a prefix of the real line. */
  partial?: boolean;
}

export interface DiffHunk {
  /** The `@@ …` line verbatim, as the section header wants to show it. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Whatever git wrote after the closing `@@` (usually the enclosing function). */
  section: string;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "renamed" | "modified";

export interface DiffFile {
  /** Display path: the NEW path, falling back to the old one for a deletion. */
  file: string;
  /** Repo-relative old path with the `a/` prefix removed; `null` for an added file. */
  oldPath: string | null;
  /** Repo-relative new path with the `b/` prefix removed; `null` for a deleted file. */
  newPath: string | null;
  status: DiffFileStatus;
  /** No text hunks are available: `Binary files … differ` or `GIT binary patch`. */
  binary: boolean;
  /** A `…[diff … truncated]` marker ended this file's diff early. */
  truncated: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Both markers `collectDiff()` can emit: `…[diff for <file> truncated]` per file and
 * `…[diff truncated]` for the whole patch. Anchored at end-of-line but NOT at the start, because
 * the marker follows a byte slice that may have stopped mid-line.
 */
const TRUNCATION_MARKER = /…\[diff(?: for [\s\S]*)? truncated\]$/;

/** Characters that can begin a line INSIDE a hunk. `@`, `d`, `B`, … end it. */
const CONTENT_PREFIXES = new Set([" ", "+", "-", "\\"]);

interface Pending extends DiffFile {
  /** `--- ` path, still prefixed, possibly `/dev/null`. */
  rawOld: string | null;
  /** `+++ ` path, still prefixed, possibly `/dev/null`. */
  rawNew: string | null;
  /** Status stated outright by a `new file mode` / `deleted file mode` / `rename` line. */
  explicit: DiffFileStatus | null;
  renameFrom: string | null;
  renameTo: string | null;
  /** A `+++ ` line has been seen, so the next `--- ` line starts a NEW file. */
  seenNewHeader: boolean;
}

/**
 * Parse a unified diff into one entry per file, in the order the patch lists them.
 *
 * Never throws and never drops input it does not understand: an unrecognised header line is
 * ignored, a malformed hunk simply ends where it stops making sense, and the file it belonged to
 * is still returned with the hunks that did parse.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const pending: Pending[] = [];
  if (typeof text !== "string" || text === "") return [];

  const lines = text.split("\n");
  // `split` leaves a final "" for a patch that ends with a newline. A patch that does NOT end
  // with one has real content in that slot, so this pop is exactly the "no trailing newline"
  // case — and an empty final line is unrepresentable without a terminator, so nothing is lost.
  if (lines[lines.length - 1] === "") lines.pop();

  let cur: Pending | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const startFile = (): Pending => {
    const file: Pending = {
      file: "",
      oldPath: null,
      newPath: null,
      status: "modified",
      binary: false,
      truncated: false,
      additions: 0,
      deletions: 0,
      hunks: [],
      rawOld: null,
      rawNew: null,
      explicit: null,
      renameFrom: null,
      renameTo: null,
      seenNewHeader: false,
    };
    pending.push(file);
    return file;
  };
  /** The file a header line belongs to — patches without a `diff --git` line still parse. */
  const file = (): Pending => cur ?? (cur = startFile());

  const pushContent = (raw: string, partial: boolean): void => {
    if (hunk === null || cur === null) return;
    const marker = raw === "" ? " " : raw[0]!;
    // An empty line inside a hunk is an empty CONTEXT line whose trailing space some tools strip.
    const body = raw === "" ? "" : raw.slice(1);
    const line: DiffLine =
      marker === "+"
        ? { type: "add", newNo, text: body }
        : marker === "-"
          ? { type: "del", oldNo, text: body }
          : { type: "ctx", oldNo, newNo, text: body };
    if (partial) line.partial = true;
    hunk.lines.push(line);
    if (marker === "+") {
      newNo += 1;
      newLeft -= 1;
      cur.additions += 1;
    } else if (marker === "-") {
      oldNo += 1;
      oldLeft -= 1;
      cur.deletions += 1;
    } else {
      oldNo += 1;
      newNo += 1;
      oldLeft -= 1;
      newLeft -= 1;
    }
  };

  const endHunk = (): void => {
    hunk = null;
    oldLeft = 0;
    newLeft = 0;
  };

  for (let i = 0; i < lines.length; i += 1) {
    let raw = lines[i]!;
    // One trailing CR, whether the PATCH is CRLF-terminated or the reviewed file was. Either way
    // it is a terminator, not content, and rendering it would show a stray glyph at every EOL.
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);

    // --- truncation marker -------------------------------------------------------------------
    // A marker only counts where `collectDiff()` can actually emit one: at the very end of the
    // patch (`…[diff truncated]`) or immediately before the next file's `diff --git` header
    // (`<head>…[diff for X truncated]`). Without that position check the regex also fires on a
    // REVIEWED FILE's own content — any line that happens to end in the marker text — which
    // ended that file's diff early, zeroed its +/- counts, tagged it "truncated" and un-anchored
    // every finding below it.
    const cut = TRUNCATION_MARKER.exec(raw);
    const atCutPoint =
      cut !== null &&
      (i === lines.length - 1 || stripCR(lines[i + 1] ?? "").startsWith("diff --git "));
    if (cut !== null && atCutPoint) {
      const head = raw.slice(0, cut.index);
      if (cur !== null) cur.truncated = true;
      // The slice may have stopped mid-line, leaving a real (partial) diff line in front of the
      // marker. It is still a line of the file and still occupies its line number.
      if (hunk !== null && head !== "" && CONTENT_PREFIXES.has(head[0]!) && head[0] !== "\\") {
        pushContent(head, true);
      }
      endHunk();
      continue;
    }

    // --- inside a hunk -----------------------------------------------------------------------
    if (hunk !== null) {
      if (raw.startsWith("\\")) {
        // `\ No newline at end of file` — describes the line before it; consumes no counter.
        const last = hunk.lines[hunk.lines.length - 1];
        if (last !== undefined) last.noNewline = true;
        continue;
      }
      // `--- x` is a removed line and `+++ y` an added one, so a patch that simply concatenates
      // file headers without `diff --git` would be swallowed as content. This exact triple —
      // `--- `, then `+++ `, then a hunk header — is a file boundary and nothing else.
      const isHeaderTriple =
        raw.startsWith("--- ") &&
        stripCR(lines[i + 1] ?? "").startsWith("+++ ") &&
        HUNK_HEADER.test(stripCR(lines[i + 2] ?? ""));
      if (oldLeft + newLeft > 0 && !isHeaderTriple && (raw === "" || CONTENT_PREFIXES.has(raw[0]!))) {
        pushContent(raw, false);
        continue;
      }
      endHunk();
      // fall through: this line belongs to the next file's header (or to a new hunk)
    }

    // --- hunk header -------------------------------------------------------------------------
    const h = HUNK_HEADER.exec(raw);
    if (h !== null) {
      const f = file();
      const oldStart = Number(h[1]);
      const oldCount = h[2] === undefined ? 1 : Number(h[2]);
      const newStart = Number(h[3]);
      const newCount = h[4] === undefined ? 1 : Number(h[4]);
      hunk = {
        header: raw,
        oldStart,
        oldCount,
        newStart,
        newCount,
        section: (h[5] ?? "").replace(/^ /, ""),
        lines: [],
      };
      f.hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldCount;
      newLeft = newCount;
      continue;
    }

    // --- file headers ------------------------------------------------------------------------
    if (raw.startsWith("diff --git ")) {
      cur = startFile();
      const paths = splitGitHeader(raw.slice("diff --git ".length));
      cur.rawOld = paths.old;
      cur.rawNew = paths.new;
      continue;
    }
    if (raw.startsWith("--- ")) {
      // A second `--- ` after a `+++ ` means a new file in a patch with no `diff --git` lines.
      if (cur === null || cur.seenNewHeader) cur = startFile();
      cur.rawOld = headerPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const f = file();
      f.rawNew = headerPath(raw.slice(4));
      f.seenNewHeader = true;
      continue;
    }
    if (raw.startsWith("new file mode")) {
      file().explicit = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      file().explicit = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      const f = file();
      f.renameFrom = unquotePath(raw.slice("rename from ".length));
      f.explicit = "renamed";
      continue;
    }
    if (raw.startsWith("rename to ")) {
      const f = file();
      f.renameTo = unquotePath(raw.slice("rename to ".length));
      f.explicit = "renamed";
      continue;
    }
    if (raw.startsWith("copy from ")) {
      file().renameFrom = unquotePath(raw.slice("copy from ".length));
      continue;
    }
    if (raw.startsWith("copy to ")) {
      file().renameTo = unquotePath(raw.slice("copy to ".length));
      continue;
    }
    if (raw === "GIT binary patch") {
      file().binary = true;
      continue;
    }
    if (raw.startsWith("Binary files ") && raw.endsWith(" differ")) {
      const f = file();
      f.binary = true;
      // Only when there was no `diff --git` line to take the paths from: this line's own split
      // is ambiguous for paths containing " and ".
      if (f.rawOld === null && f.rawNew === null) {
        const m = /^Binary files (.*) and (.*) differ$/.exec(raw);
        if (m !== null) {
          f.rawOld = m[1]!;
          f.rawNew = m[2]!;
        }
      }
      continue;
    }
    // `index …`, `old mode …`, `similarity index …`, prose between patches: not interesting.
  }

  return pending.map(finalize);
}

function stripCR(value: string): string {
  return value.endsWith("\r") ? value.slice(0, -1) : value;
}

function finalize(p: Pending): DiffFile {
  const oldPath = p.renameFrom ?? stripPrefix(p.rawOld, "a");
  const newPath = p.renameTo ?? stripPrefix(p.rawNew, "b");
  const status: DiffFileStatus =
    p.explicit ??
    (p.rawOld === "/dev/null"
      ? "added"
      : p.rawNew === "/dev/null"
        ? "deleted"
        : oldPath !== null && newPath !== null && oldPath !== newPath
          ? "renamed"
          : "modified");
  return {
    file: newPath ?? oldPath ?? "",
    oldPath,
    newPath,
    status,
    binary: p.binary,
    truncated: p.truncated,
    additions: p.additions,
    deletions: p.deletions,
    hunks: p.hunks,
  };
}

/**
 * Drop git's `a/` or `b/` prefix — one level only, and only the side's own letter.
 *
 * A repository really can contain a top-level `b/` directory, so `--- a/b/thing.ts` has to come
 * out as `b/thing.ts`. Stripping "either prefix, anywhere" is how that file loses its directory.
 */
function stripPrefix(value: string | null, side: "a" | "b"): string | null {
  if (value === null || value === "/dev/null") return null;
  return value.startsWith(`${side}/`) ? value.slice(2) : value;
}

/**
 * The path out of a `--- ` / `+++ ` line.
 *
 * Plain `diff -u` appends a tab and a timestamp; git never emits an unquoted tab in a path (it
 * C-quotes the whole path instead), so everything from the first tab on is metadata.
 */
function headerPath(value: string): string {
  const tab = value.indexOf("\t");
  return unquotePath(tab === -1 ? value : value.slice(0, tab));
}

/**
 * Split `a/<old> b/<new>` from a `diff --git` line.
 *
 * Ambiguous by construction: neither side is quoted or escaped when it merely contains spaces,
 * so `a/my b/file.txt` could split two ways. Resolved by preferring the split that makes both
 * sides name the SAME file — true for every change except a rename, and a rename carries
 * authoritative `rename from`/`rename to` lines that override this anyway.
 */
function splitGitHeader(rest: string): { old: string | null; new: string | null } {
  if (rest.startsWith('"')) {
    const m = /^("(?:\\.|[^"\\])*")\s+(.*)$/.exec(rest);
    if (m !== null) return { old: unquotePath(m[1]!), new: unquotePath(m[2]!) };
  }
  const splits: number[] = [];
  for (let i = rest.indexOf(" b/"); i !== -1; i = rest.indexOf(" b/", i + 1)) splits.push(i);
  for (const i of splits) {
    const left = rest.slice(0, i);
    const right = rest.slice(i + 1);
    if (left.startsWith("a/") && left.slice(2) === right.slice(2)) return { old: left, new: right };
  }
  if (splits.length > 0) {
    // A rename: no split makes the sides equal, so take the last plausible one.
    const i = splits[splits.length - 1]!;
    return { old: rest.slice(0, i), new: rest.slice(i + 1) };
  }
  return { old: null, new: null };
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * Undo git's C-style path quoting: `"a/caf\303\251.txt"` → `a/café.txt`.
 *
 * The escapes are BYTES (`\303\251` is one UTF-8 character split across two octal escapes), so
 * the whole path is rebuilt as bytes and decoded once at the end. Anything that is not a quoted
 * string is returned untouched.
 */
function unquotePath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const chars = Array.from(value.slice(1, -1));
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch !== "\\") {
      for (const b of encoder.encode(ch)) bytes.push(b);
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    const octal = chars.slice(i + 1, i + 4).join("");
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const mapped = ESCAPES[next];
    if (mapped !== undefined) {
      bytes.push(mapped);
      i += 1;
      continue;
    }
    bytes.push(0x5c); // an escape we do not know: keep the backslash, drop nothing
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------
// finding anchoring
// ---------------------------------------------------------------------------

/** The minimum a finding needs to be placed: SPEC § Types gives `Finding` both fields. */
export interface Anchorable {
  file: string;
  line: number;
}

/** Identifies one rendered diff row. Opaque — build it with `rowKey`, never by hand. */
export function rowKey(fileIndex: number, hunkIndex: number, lineIndex: number): string {
  return `${fileIndex}:${hunkIndex}:${lineIndex}`;
}

export interface Anchored<T> {
  /** `rowKey(...)` → the findings that belong directly under that row, in input order. */
  byRow: Map<string, T[]>;
  /** Findings whose file or line is not in the diff. Shown separately — NEVER dropped. */
  unanchored: T[];
}

/**
 * Place each finding under the diff row whose NEW line number it names (T18 step 2).
 *
 * Removed lines have no new number and can therefore never take a finding — which is correct:
 * `Finding.line` is a line in the code as it stands after the change, and the reviewer is asked
 * to point at code that still exists.
 *
 * File matching is exact on the repo-relative path first. A single suffix match is accepted as a
 * fallback (a reviewer that answered `./api/server.mjs`, or an absolute path); an AMBIGUOUS
 * suffix — two files in the diff ending the same way — is deliberately left unanchored rather
 * than guessed, because a card under the wrong file reads as fact.
 */
export function anchorFindings<T extends Anchorable>(
  files: readonly DiffFile[],
  findings: readonly T[],
): Anchored<T> {
  // file index → new line number → rowKey
  const rows = files.map((f, fi) => {
    const byLine = new Map<number, string>();
    f.hunks.forEach((h, hi) => {
      h.lines.forEach((line, li) => {
        if (line.newNo !== undefined && !byLine.has(line.newNo)) {
          byLine.set(line.newNo, rowKey(fi, hi, li));
        }
      });
    });
    return byLine;
  });

  const byRow = new Map<string, T[]>();
  const unanchored: T[] = [];

  for (const finding of findings) {
    const index = matchFile(files, finding.file);
    const key = index === null ? undefined : rows[index]!.get(finding.line);
    if (key === undefined) {
      unanchored.push(finding);
      continue;
    }
    const bucket = byRow.get(key);
    if (bucket === undefined) byRow.set(key, [finding]);
    else bucket.push(finding);
  }

  return { byRow, unanchored };
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Index of the diff entry a finding's `file` names, or `null`. */
function matchFile(files: readonly DiffFile[], raw: string): number | null {
  const wanted = normalizePath(raw);
  if (wanted === "") return null;

  const exact = files.findIndex(
    (f) =>
      normalizePath(f.file) === wanted ||
      (f.newPath !== null && normalizePath(f.newPath) === wanted) ||
      (f.oldPath !== null && normalizePath(f.oldPath) === wanted),
  );
  if (exact !== -1) return exact;

  const suffix = files.flatMap((f, i) => {
    const candidates = [f.file, f.newPath, f.oldPath].filter((p): p is string => Boolean(p));
    return candidates.some((p) => {
      const norm = normalizePath(p);
      return norm.endsWith(`/${wanted}`) || wanted.endsWith(`/${norm}`);
    })
      ? [i]
      : [];
  });
  return suffix.length === 1 ? suffix[0]! : null;
}

/**
 * The widest line number the file will render, so both gutters can be sized once — every hunk of
 * a file must use the same width or the columns step sideways between scroll containers.
 */
export function widestLineNumber(file: DiffFile): number {
  let max = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.oldNo !== undefined && line.oldNo > max) max = line.oldNo;
      if (line.newNo !== undefined && line.newNo > max) max = line.newNo;
    }
  }
  return max;
}
