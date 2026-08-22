/**
 * The dashboard's access to the run store (T17 step 3 — the read side; T21 — the write side).
 *
 * SERVER ONLY. Every function here touches `node:fs`, so this module must never be reached from
 * a `"use client"` component — the import of `node:fs` makes that a hard build error rather than
 * a subtle leak, which is the guarantee we want. Client components in `src/app/settings/` and
 * `src/components/ledger-view/row-actions.tsx` reach these functions only through the API routes; data for a
 * first render is read in server components and passed down as plain values.
 *
 * Why re-implement instead of importing the toolkit's `src/store.ts`: that module is node-only by
 * design (it also owns the WRITE side, installs `process.on('exit')` guards, and its neighbours
 * pull in playwright and child_process). The dashboard only ever reads, so it re-implements the
 * read half against the same on-disk layout (SPEC § Storage):
 *
 *   $AW_HOME/                          (default ~/.agent-workflows)
 *   ├── workspaces.json                # WorkspacesFile
 *   └── <workspace>/runs/<runId>/
 *       ├── manifest.json              # RunManifest
 *       ├── log.txt
 *       └── artifacts/
 *
 * The *types* are not re-implemented: `@shared/schemas` is imported directly, so a change to the
 * manifest shape reaches the panel through the same zod schema the CLI validates with.
 *
 * Two rules, inherited from the toolkit's store because the panel reads this directory WHILE a
 * workflow writes it:
 *
 * 1. **A reader never throws.** A truncated manifest (a run killed mid-write) is skipped, not
 *    fatal. One bad file is a gap in a table, never a 500.
 * 2. **Nothing outside `$AW_HOME` is reachable.** Workspace and run ids are validated as single
 *    path segments; every path a request names is resolved with `realpath` and re-checked
 *    against the resolved store root (see `realRunDir`), because all three arrive straight from
 *    a URL and any directory under `$AW_HOME` may itself be a symlink an agent planted.
 *
 * `next build` warns "Dynamic filesystem access causes tracing of the whole project" about the
 * `awHome()` calls below. That warning is about which source files get copied into a deployment
 * bundle, and it is correct that none can be determined here — the store is an absolute path
 * from `$AW_HOME`, chosen at RUN time, outside the project entirely. There is nothing to trace
 * and nothing to fix; the panel is served from `next dev`/`next start` on the machine that owns
 * the store.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cache } from "react";
import { RunManifest, WorkspacesFile } from "@shared/schemas";
import type { Workspace } from "@shared/schemas";

export type { RunManifest, Workspace };
export type RunKind = RunManifest["kind"];
export type RunStatus = RunManifest["status"];

/**
 * The run kinds, taken from the schema rather than re-typed.
 *
 * A fourth kind added to `RunManifest` in `shared/schemas.ts` reaches the filter bar by itself;
 * a hand-copied literal list would type-check happily while quietly dropping its pill.
 */
export const RUN_KINDS = RunManifest.shape.kind.options;

/** SPEC § Storage: `~/.agent-workflows`, overridable with env `AW_HOME`. */
export function awHome(): string {
  const override = process.env.AW_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".agent-workflows");
}

/**
 * The same rule `aw init` and the toolkit's store validate directory segments with: a leading
 * alphanumeric, then letters, digits, `.`, `-`, `_`. It admits neither `.` nor `..` nor anything
 * containing a separator, so a validated segment cannot traverse — this is the first of the two
 * gates in front of `/api/artifact`.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeSegment(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return SAFE_SEGMENT.test(trimmed) ? trimmed : null;
}

/**
 * Is this a name the CLI could use as a workspace? Exported so `POST /api/workspaces` rejects a
 * name at registration time with the same rule `aw init`, the toolkit's store and this module
 * already apply — rather than letting an unusable entry into `workspaces.json` and discovering it
 * later as a 404 (T17 deviation 15).
 */
export function isWorkspaceName(value: string): boolean {
  return safeSegment(value) !== null;
}

/** `$AW_HOME/<workspace>/runs`, or `null` when the name is not a usable directory segment. */
function runsDir(workspace: string): string | null {
  const name = safeSegment(workspace);
  return name === null ? null : path.join(awHome(), name, "runs");
}

/** `$AW_HOME/<workspace>/runs/<runId>`, or `null` when either name is unusable. */
export function runDir(workspace: string, runId: string): string | null {
  const runs = runsDir(workspace);
  const id = safeSegment(runId);
  return runs === null || id === null ? null : path.join(runs, id);
}

/**
 * The run directory with every symlink resolved, proven to still sit inside the resolved store
 * root — or `null`.
 *
 * This, not the run directory itself, is what containment must be anchored on. `SAFE_SEGMENT`
 * proves the *name* cannot traverse, but it says nothing about what the directory IS: a
 * `$AW_HOME/<ws>/runs/<id>` symlinked to `/etc`, or a `$AW_HOME/<ws>` symlinked anywhere,
 * satisfies every lexical check while relocating the whole run outside the store. Resolving the
 * run dir and comparing against the resolved `$AW_HOME` catches both, and the same call is the
 * gate in front of `log.txt`, the manifest and every artifact — the panel reads a store that
 * agents with `write_file` and `bash` also write to.
 *
 * Exported since T22: `/api/feedback` needed exactly this function and kept a private copy of it,
 * which is two places to fix when the containment rule changes. There is one now.
 */
export function realRunDir(workspace: string, runId: string): string | null {
  const dir = runDir(workspace, runId);
  if (dir === null) return null;
  try {
    const root = fs.realpathSync(awHome());
    const real = fs.realpathSync(dir);
    return isInside(root, real) ? real : null;
  } catch {
    // A missing store, a dangling symlink, an ELOOP — all of them mean "no such run".
    return null;
  }
}

/**
 * `<realRunDir>/<name>` for a FIXED file name, proven to be a regular file that still sits inside
 * the run directory once every symlink is resolved — or `null`.
 *
 * The missing half of `realRunDir`. That function proves the DIRECTORY has not been relocated; it
 * says nothing about the entry inside it, and `path.join(dir, "log.txt")` opened directly follows
 * a symlink at that name like any other path. An agent has `write_file` and an unconfined `bash`
 * (SPEC § Tools: only the blocked-pattern regexes apply, and `ln -s` is not one of them), so
 * `ln -s /etc/passwd $AW_HOME/<ws>/runs/<id>/log.txt` is a thing that can be in the store — and
 * before this existed, `GET /api/logs?run=` and the run page's Log tab both streamed the target.
 *
 * `name` is a constant at every call site (`log.txt`, `spawn.log`, `feedback-queue.json`); it is
 * still validated as a single safe segment so it can never become a caller-supplied path.
 * This is `resolveArtifact`'s gate 4 applied to the files that are not artifacts.
 */
export function resolveRunFile(workspace: string, runId: string, name: string): string | null {
  const realDir = realRunDir(workspace, runId);
  if (realDir === null) return null;
  if (safeSegment(name) === null) return null;
  try {
    const real = fs.realpathSync(path.join(realDir, name));
    if (!isInside(realDir, real)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    // ENOENT (no log yet), ELOOP, EACCES, a dangling link — all of them mean "no such file".
    return null;
  }
}

// ---------------------------------------------------------------------------
// workspaces
// ---------------------------------------------------------------------------

/** The registered workspaces from `$AW_HOME/workspaces.json`. `[]` if missing or invalid. */
export function listWorkspaces(): Workspace[] {
  const file = path.join(awHome(), "workspaces.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return [];
  }
  const parsed = WorkspacesFile.safeParse(raw);
  return parsed.success ? parsed.data.workspaces : [];
}

/** Directory names under `$AW_HOME` that actually contain a `runs/` folder. */
function workspacesOnDisk(): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(awHome(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SAFE_SEGMENT.test(e.name))
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(awHome(), name, "runs")))
    .sort();
}

export interface WorkspaceSummary {
  name: string;
  /** `null` for a directory with runs that is not in `workspaces.json` (registry lost/edited). */
  repoRoot: string | null;
  createdAt: string | null;
  runCount: number;
  /**
   * Runs sitting in `archive/`. Counted separately because the "forget this workspace" dialog
   * promises that everything in the store stays where it is, and a workspace whose runs have all
   * been archived would otherwise make that promise about "0 recorded runs".
   */
  archivedCount: number;
  /** `createdAt` of the newest run, or `null` when the workspace has none. */
  lastRunAt: string | null;
  registered: boolean;
  /**
   * False for a registry entry whose name is not a usable directory segment. Such a workspace
   * has no directory under `$AW_HOME` and no page: it must be shown WITHOUT a link, because a
   * link to it is guaranteed to 404 and sends the reader looking for the wrong problem.
   */
  usable: boolean;
}

/**
 * Every workspace the panel can show: the registry, plus any run-bearing directory the registry
 * has forgotten. A workspace whose runs exist but whose registry entry is gone would otherwise
 * be invisible while its runs still showed up in "latest runs" — a confusing half-state.
 *
 * Wrapped in React's `cache()`: the site header and the page it wraps both call this, and it
 * scans and zod-parses every manifest in the store. `cache()` makes the two calls in one render
 * share a single scan. (Outside a render — an API route — it simply calls through.)
 */
export const listWorkspaceSummaries = cache(function listWorkspaceSummaries(): WorkspaceSummary[] {
  const registered = listWorkspaces();
  const known = new Set(registered.map((w) => w.name));
  const names = [...registered.map((w) => w.name), ...workspacesOnDisk().filter((n) => !known.has(n))];

  return names
    .map((name) => {
      const entry = registered.find((w) => w.name === name);
      const usable = safeSegment(name) !== null;
      const runs = usable ? listRuns(name) : [];
      return {
        name,
        repoRoot: entry?.repoRoot ?? null,
        createdAt: entry?.createdAt ?? null,
        runCount: runs.length,
        archivedCount: usable ? listArchivedRuns(name).length : 0,
        lastRunAt: runs[0]?.createdAt ?? null,
        registered: Boolean(entry),
        usable,
      };
    })
    .sort((a, b) => (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") || a.name.localeCompare(b.name));
});

/** True when the name is a registered workspace OR has a runs directory — i.e. a real page. */
export function workspaceExists(workspace: string): boolean {
  const name = safeSegment(workspace);
  if (name === null) return false;
  if (listWorkspaces().some((w) => w.name === name)) return true;
  const runs = runsDir(name);
  return runs !== null && fs.existsSync(runs);
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

/**
 * Parse one `manifest.json`. `null` for anything unreadable, invalid, or not a RunManifest.
 *
 * The returned manifest's `runId` and `workspace` are the ones DERIVED FROM `dir`, not the ones
 * the file declares, whenever the two disagree. A manifest is run content and run content is
 * untrusted (SPEC § Dashboard security invariants #3): a directory `runs/foo` whose manifest says
 * `runId: "bar"` used to make every row in the run table, every artifact link and — since T21 —
 * the Archive and Delete buttons address `bar`, a directory this manifest was not read from.
 * (`cp -R` of a run directory was enough to make one row's Delete remove the other row's run.)
 * Anchoring the identity to the path the bytes came from makes that impossible everywhere at once,
 * rather than at each of the call sites that happen to remember.
 */
function loadManifest(dir: string): RunManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = RunManifest.safeParse(raw);
  if (!parsed.success) return null;

  // `$AW_HOME/<ws>/<area>/<runId>` — the layout every caller here walks (SPEC § Storage, plus
  // T21's `archive/`). Only override when the derived names are usable segments; a directory
  // somewhere unexpected keeps whatever the file said rather than gaining an empty run id.
  const derivedRunId = safeSegment(path.basename(dir));
  const derivedWorkspace = safeSegment(path.basename(path.dirname(path.dirname(dir))));
  return {
    ...parsed.data,
    ...(derivedRunId === null ? {} : { runId: derivedRunId }),
    ...(derivedWorkspace === null ? {} : { workspace: derivedWorkspace }),
  };
}

/**
 * Every run, newest first. With no argument: across every workspace under `$AW_HOME`.
 * Sorted by `createdAt` (ISO 8601 sorts lexically), run id as the tie-break.
 */
export function listRuns(workspace?: string): RunManifest[] {
  const names = workspace === undefined ? workspacesOnDisk() : [workspace];
  const out: RunManifest[] = [];
  for (const name of names) {
    const dir = runsDir(name);
    if (dir === null) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // a workspace that has never run is not an error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = loadManifest(path.join(dir, entry.name));
      if (manifest !== null) out.push(manifest);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
}

/** One run's manifest, or `null` when it is missing, unreadable, or outside the store. */
export function readRun(workspace: string, runId: string): RunManifest | null {
  const dir = realRunDir(workspace, runId);
  return dir === null ? null : loadManifest(dir);
}

export interface LogTail {
  /** The last `max` lines, joined. */
  text: string;
  /** Total lines in `log.txt`, or `null` when the file was too large to count them all. */
  totalLines: number | null;
  shownLines: number;
  truncated: boolean;
  exists: boolean;
  /** Size of `log.txt` in bytes; `0` when it does not exist. */
  bytes: number;
  /** Set when `log.txt` EXISTS but could not be read — never confuse this with `!exists`. */
  error: string | null;
}

/**
 * How much of a log is read to produce the tail. A 500-line tail of a run log is a few tens of
 * kilobytes; a megabyte is generous slack for very long tool-result lines.
 */
const TAIL_BYTES = 1024 * 1024;

/**
 * The tail of a run's `log.txt` (T17 step 4: last 500 lines).
 *
 * Bounded by BYTES, not by trust in the file's size. Reading the whole file to keep its last 500
 * lines costs its full length in server memory on every request (the page is `force-dynamic`, so
 * every reload pays again), and past V8's ~512 MB string limit `readFileSync(…, "utf8")` throws
 * outright — which, caught, used to render as "this run has no log.txt" for a log that was
 * merely enormous. So: stat, read at most the last megabyte, drop the first (probably partial)
 * line, and report `totalLines: null` when the count is unknown rather than guessing it.
 */
export function readLogTail(workspace: string, runId: string, max = 500): LogTail {
  const absent: LogTail = {
    text: "",
    totalLines: 0,
    shownLines: 0,
    truncated: false,
    exists: false,
    bytes: 0,
    error: null,
  };
  // `resolveRunFile`, not `path.join`: a symlink AT `log.txt` would otherwise be followed and its
  // target rendered on the Log tab. Same gate `/api/logs` uses, for the same file.
  const file = resolveRunFile(workspace, runId, "log.txt");
  if (file === null) return absent;

  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return absent;
    size = stat.size;
  } catch {
    return absent; // no log.txt — the run never wrote one, or has not yet
  }

  let text: string;
  let partial: boolean;
  try {
    const from = Math.max(0, size - TAIL_BYTES);
    partial = from > 0;
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(file, "r");
    try {
      const read = fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // The errno, never `err.message`: Node puts the ABSOLUTE path of the file in the message for
    // EACCES, EISDIR, ELOOP, ENAMETOOLONG and EIO, and SPEC § Dashboard security invariants #2
    // forbids surfacing an error that names a real path.
    return {
      ...absent,
      exists: true,
      bytes: size,
      error: err instanceof Error && "code" in err ? String(err.code) : "read error",
    };
  }

  // A byte offset lands mid-line (and possibly mid-UTF-8-character); the first line goes — but
  // only if there IS a later line. A tail with no newline in it at all is one long line, and
  // `indexOf` returning -1 would slice from 0 and keep it; dropping it would show an empty box.
  const firstBreak = partial ? text.indexOf("\n") : -1;
  if (firstBreak >= 0) text = text.slice(firstBreak + 1);

  const lines = text.replace(/\n$/, "").split("\n");
  const counted = text === "" ? 0 : lines.length;
  const shown = lines.slice(-max);
  return {
    text: shown.join("\n"),
    totalLines: partial ? null : counted,
    shownLines: counted === 0 ? 0 : shown.length,
    truncated: partial || counted > max,
    exists: true,
    bytes: size,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

export interface ResolvedArtifact {
  /** Absolute, fully symlink-resolved path, proven to sit inside the run directory. */
  absPath: string;
  /** Path relative to the run directory, POSIX-separated (what the manifest stores). */
  relPath: string;
  size: number;
  contentType: string;
  fileName: string;
}

/**
 * Content type by extension.
 *
 * The list is an ALLOW-list and the fallback is `application/octet-stream` on purpose. `.html`
 * and `.svg` are deliberately absent: an agent-generated artifact is untrusted input, and serving
 * one as `text/html` or `image/svg+xml` from the panel's own origin would let it run script in
 * the panel. Unlisted extensions download instead of rendering. Callers must also send
 * `X-Content-Type-Options: nosniff` so the browser does not second-guess this map.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve `<runDir>/<relPath>` to a real file, or `null`. NEVER throws.
 *
 * `ws`, `run` and `path` all arrive from a query string, so this is the security boundary of
 * `/api/artifact`. Four independent gates, each sufficient on its own for the attack it names:
 *
 * 1. `runDir()` validates `ws` and `run` against `SAFE_SEGMENT`, which contains no separator and
 *    is not `.` or `..` — so neither can leave `$AW_HOME`.
 * 2. `relPath` is rejected if it is absolute (`/etc/hosts`, `C:\…`, `\\server\share`) and split
 *    on both separators with every `..` segment rejected. Percent-encoding is already undone by
 *    `URLSearchParams` before we see the value, so `%2e%2e%2f` arrives as `../` and is caught
 *    here — decoding never happens after this check.
 * 3. The lexically resolved path must still be inside the run directory: catches anything the
 *    segment scan missed (odd unicode separators, NUL, `..` re-introduced by normalisation).
 * 4. Both sides are re-checked AFTER `realpathSync`, and the run directory itself is re-checked
 *    against the resolved `$AW_HOME` (`realRunDir`). A symlink inside `artifacts/` pointing at
 *    `/etc/hosts` passes gates 1–3 (its path is innocent) and fails the first half. A symlinked
 *    RUN or WORKSPACE directory — `runs/<id>` → `/etc` — would pass that half too, because the
 *    escaped location is then both sides of the comparison; anchoring on the store root is what
 *    catches it.
 *
 * Finally the target must be a regular file — a directory or a fifo is not an artifact.
 */
export function resolveArtifact(
  workspace: string,
  runId: string,
  relPath: string,
): ResolvedArtifact | null {
  try {
    const dir = runDir(workspace, runId); // gate 1
    if (dir === null) return null;
    if (typeof relPath !== "string" || relPath === "" || relPath.includes("\0")) return null;

    // gate 2: no absolute paths, no `..` segments.
    if (path.isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath) || relPath.startsWith("\\")) {
      return null;
    }
    const parts = relPath
      .split(/[\\/]+/)
      .map((p) => p.trim())
      .filter((p) => p !== "" && p !== ".");
    if (parts.length === 0 || parts.some((p) => p === "..")) return null;

    // gate 3: lexical containment.
    const target = path.resolve(dir, ...parts);
    if (!isInside(dir, target)) return null;

    // gate 4: containment survives symlink resolution — of the file AND of the run directory,
    // which `realRunDir` has already proven still resolves inside `$AW_HOME`.
    const realDir = realRunDir(workspace, runId);
    if (realDir === null) return null;
    const realTarget = fs.realpathSync(target);
    if (!isInside(realDir, realTarget)) return null;

    const stat = fs.statSync(realTarget);
    if (!stat.isFile()) return null;

    const rel = path.relative(realDir, realTarget).split(path.sep).join("/");
    const fileName = path.basename(realTarget);
    return {
      absPath: realTarget,
      relPath: rel,
      size: stat.size,
      contentType: contentTypeFor(fileName),
      fileName,
    };
  } catch {
    // ENOENT, ELOOP, EACCES, a name longer than NAME_MAX — all of them mean "no such artifact".
    return null;
  }
}

/** True when `child` is `parent` itself or sits under it. Compares whole path segments. */
function isInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

export interface ManifestArtifact {
  label: string;
  path: string;
  /** False when the path does not resolve to a readable file inside the run directory. */
  present: boolean;
}

/**
 * Every artifact path a manifest points at, in display order.
 *
 * Derived from whichever result block the run happens to have, so the generic run page can link
 * to real files without knowing anything type-specific (that is T18–T20's job).
 *
 * Each path is resolved here, not just rendered: a manifest can name a file that was never
 * written (a full store — the toolkit records the intended path rather than failing the run) or
 * one that has since been deleted. `present: false` is what lets the page show it as missing
 * instead of as a link that answers 404.
 */
export function manifestArtifacts(m: RunManifest): ManifestArtifact[] {
  const out: { label: string; path: string }[] = [];
  if (m.review) out.push({ label: "diff", path: m.review.diffArtifact });
  if (m.test) out.push({ label: "report", path: m.test.reportArtifact });
  if (m.design) {
    for (const s of m.design.screens) out.push({ label: `${s.screen} · ${s.viewport}`, path: s.path });
    if (m.design.video) out.push({ label: "video", path: m.design.video });
  }
  return out.map((a) => ({
    ...a,
    present: resolveArtifact(m.workspace, m.runId, a.path) !== null,
  }));
}

/** `/api/artifact?ws=…&run=…&path=…` for one artifact, correctly escaped. */
export function artifactHref(workspace: string, runId: string, relPath: string): string {
  const q = new URLSearchParams({ ws: workspace, run: runId, path: relPath });
  return `/api/artifact?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// archive (T21 step 2/3)
// ---------------------------------------------------------------------------

/**
 * The two directories a run can live in: `$AW_HOME/<ws>/runs/` and `$AW_HOME/<ws>/archive/`.
 *
 * Archiving is a `rename` between the two, which is why `archive/` sits NEXT TO `runs/` rather
 * than inside it: a directory under `runs/` would be walked by `listRuns` (and by the toolkit's
 * own `src/store.ts`, which this panel must not surprise), and every archived run would keep
 * showing up in the table it was archived out of.
 */
export type RunArea = "runs" | "archive";

/** `$AW_HOME/<workspace>/<area>`, or `null` when the name is not a usable directory segment. */
function areaDir(workspace: string, area: RunArea): string | null {
  const name = safeSegment(workspace);
  return name === null ? null : path.join(awHome(), name, area);
}

/** Archived runs of one workspace, newest first. `[]` when there is no `archive/` directory. */
export function listArchivedRuns(workspace: string): RunManifest[] {
  const dir = areaDir(workspace, "archive");
  if (dir === null) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // nothing archived yet is not an error
  }
  const out: RunManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = loadManifest(path.join(dir, entry.name));
    if (manifest !== null) out.push(manifest);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
}

// ---------------------------------------------------------------------------
// mutations: the strict gate (T21)
// ---------------------------------------------------------------------------

/**
 * The gate in front of every DESTRUCTIVE operation. Stricter than `realRunDir` on purpose.
 *
 * `realRunDir` (reads) asks one question: does this path, fully resolved, still sit inside the
 * resolved store? That is the right question for serving bytes. It is not enough for `rm -r`:
 * "inside the store" also describes another workspace's run directory, so a `runs/<id>` symlink
 * pointing at a *sibling* run would pass it and take the sibling's manifest, log and artifacts
 * with it. Deleting is not undoable, so this gate proves the exact shape instead:
 *
 * 1. `ws`, `runId` and the area are single safe segments — no separator, never `.` or `..`
 *    (percent-decoding already happened in `URLSearchParams`, so `%2e%2e` arrives as `..` here);
 * 2. the PARENT is resolved with `realpath` and the entry itself is `lstat`ed, so a symlink is
 *    seen as a symlink and refused rather than followed;
 * 3. the resolved path is EXACTLY `<realpath($AW_HOME)>/<ws>/<area>/<runId>` — checked segment by
 *    segment, including that its great-grandparent IS the store root. Nothing shallower, nothing
 *    deeper, and nothing reached through a relocated workspace or run directory can satisfy it.
 *
 * Returns `null` for anything else — the caller answers 404, never a message naming a real path.
 */
function mutableRunDir(workspace: string, runId: string, area: RunArea): string | null {
  const ws = safeSegment(workspace);
  const id = safeSegment(runId);
  if (ws === null || id === null) return null;
  if (area !== "runs" && area !== "archive") return null;
  try {
    const root = fs.realpathSync(awHome());
    const parent = fs.realpathSync(path.join(awHome(), ws, area));
    const real = path.join(parent, id);
    const stat = fs.lstatSync(real);
    if (!stat.isDirectory()) return null; // a symlink lstats as a symlink, not as a directory
    if (!isInside(root, real)) return null;
    if (path.basename(real) !== id) return null;
    if (path.basename(path.dirname(real)) !== area) return null;
    if (path.basename(path.dirname(path.dirname(real))) !== ws) return null;
    if (path.dirname(path.dirname(path.dirname(real))) !== root) return null;
    return real;
  } catch {
    // ENOENT, ELOOP, EACCES, a relocated workspace — all of them mean "no such run".
    return null;
  }
}

/**
 * The DESTINATION half of the gate: `<realpath($AW_HOME)>/<ws>/<area>`, created if missing, proven
 * to be a real directory at exactly that place — or `null`.
 *
 * The source of an archive/restore has always gone through `mutableRunDir`. The destination went
 * through `path.join(mutableWorkspaceDir(ws), area)` and nothing else, and `rename(2)` follows
 * symlinks in the path PREFIX, so `ln -s /somewhere/else $AW_HOME/<ws>/archive` — a link an agent
 * with `bash` can plant, inside the store, which is the threat model `mutableRunDir` exists for —
 * relocated the whole move. Reproduced before this fix: `POST /api/runs/archive` answered
 * `{"ok":true,…,"movedTo":"archive"}` while the run directory landed outside `$AW_HOME`, out of
 * both the active and the archived view, and `restore` then 404ed because the SOURCE gate did its
 * job. A confined run left the store, permanently, and the route called it a success.
 *
 * So the destination is now held to the same proof as the source: `lstat` (a symlink lstats as a
 * symlink, never as a directory) and a `realpath` that must equal the path built from the resolved
 * store root and the two validated segments. `mkdirSync` first, because a first archive in a
 * workspace legitimately has to create the directory — and `mkdir` on an existing symlink fails
 * with EEXIST rather than following it, so creating it cannot itself be redirected.
 */
function mutableAreaDir(workspace: string, area: RunArea): string | null {
  const ws = safeSegment(workspace);
  if (ws === null) return null;
  if (area !== "runs" && area !== "archive") return null;
  try {
    const root = fs.realpathSync(awHome());
    const expected = path.join(root, ws, area);
    fs.mkdirSync(expected, { recursive: true });
    if (!fs.lstatSync(expected).isDirectory()) return null;
    return fs.realpathSync(expected) === expected ? expected : null;
  } catch {
    return null;
  }
}

export type RunMutation = "ok" | "not-found" | "exists" | "failed";

/**
 * Delete `$AW_HOME/<ws>/<area>/<runId>` and everything under it.
 *
 * `recursive: true` — but `fs.rmSync` never follows symlinks, it unlinks them, so a link an agent
 * planted inside `artifacts/` costs the link and not its target. The directory itself has already
 * been proven not to be a link by `mutableRunDir`.
 */
export function deleteRun(workspace: string, runId: string, area: RunArea = "runs"): RunMutation {
  const dir = mutableRunDir(workspace, runId, area);
  if (dir === null) return "not-found";
  try {
    fs.rmSync(dir, { recursive: true, force: false });
    return "ok";
  } catch {
    return "failed";
  }
}

/**
 * Move a run between `runs/` and `archive/` — a plain `rename`, so it is atomic, instant for a
 * run with a 300 MB video, and impossible to half-apply.
 *
 * Both ends go through `mutableRunDir`/`mutableAreaDir`: the source must be exactly
 * `<store>/<ws>/<from>/<runId>`, and the destination is built from the resolved store root and
 * the same validated segments rather than from anything the caller sent — then re-verified with
 * `lstat` + `realpath`, because "built from the store root" was true of the old code too and a
 * symlinked `archive/` still redirected the `rename`. An existing destination is reported
 * (`"exists"`), never overwritten — `rename` would replace a directory silently.
 */
export function moveRun(
  workspace: string,
  runId: string,
  from: RunArea,
  to: RunArea,
): RunMutation {
  const source = mutableRunDir(workspace, runId, from);
  if (source === null) return "not-found";
  const id = safeSegment(runId);
  if (id === null) return "not-found";
  // Both ends, same proof. `mutableAreaDir` creates the directory and then re-verifies that what
  // it created is a real directory at exactly `<store>/<ws>/<to>` — see its doc comment for the
  // symlinked-`archive/` escape this closes.
  const targetDir = mutableAreaDir(workspace, to);
  if (targetDir === null) return "not-found";
  const target = path.join(targetDir, id);
  try {
    // `lstatSync` rather than `existsSync`: a DANGLING symlink at the destination name does not
    // "exist" by `existsSync` but would be silently replaced by `rename`.
    try {
      fs.lstatSync(target);
      return "exists";
    } catch {
      /* nothing there — the normal case */
    }
    fs.renameSync(source, target);
    return "ok";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// the workspace registry, write side (T21 step 2)
// ---------------------------------------------------------------------------

/**
 * Written through a temp file + `rename`, like the toolkit's store: no reader sees half a file.
 *
 * Atomicity matters for `aw.config.json` too, not just for `$AW_HOME/workspaces.json`: the CLI
 * re-reads that file mid-run, and a half-written config is a failed run. The cost is that a crash
 * between `write` and `rename` leaves residue in a directory that is under git, so the temp name
 * is dot-prefixed (`.aw.config.json.tmp-<pid>`) — hidden from a casual `ls`, still visible to
 * `git status` if it ever happens, and unlinked on any failure path. Recorded in T21 § Deviations.
 */
function writeAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* it was never created */
    }
    throw err;
  }
}

export type RegistryResult =
  | { ok: true }
  | { ok: false; reason: "exists" | "missing" | "corrupt" | "failed"; message: string };

/**
 * Read `workspaces.json` for a WRITE.
 *
 * Deliberately not `listWorkspaces()`, which answers `[]` for a corrupt file: `[]` is a fine
 * thing to render, and a catastrophic thing to write back — it would erase every other
 * registration. A file we cannot parse is reported instead, and the caller refuses the write.
 */
function readRegistryForWrite():
  | { ok: true; workspaces: Workspace[] }
  | { ok: false; message: string } {
  const file = path.join(awHome(), "workspaces.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    // No registry yet is normal — the first registration creates it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, workspaces: [] };
    return { ok: false, message: "workspaces.json could not be read" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, message: "workspaces.json is not valid JSON — fix it by hand first" };
  }
  const parsed = WorkspacesFile.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: "workspaces.json is not a valid workspaces file — fix it by hand first" };
  }
  return { ok: true, workspaces: parsed.data.workspaces };
}

/** Add one entry to `workspaces.json`. Never replaces an existing name. */
export function addWorkspace(entry: Workspace): RegistryResult {
  const registry = readRegistryForWrite();
  if (!registry.ok) return { ok: false, reason: "corrupt", message: registry.message };
  if (registry.workspaces.some((w) => w.name === entry.name)) {
    return { ok: false, reason: "exists", message: `workspace "${entry.name}" is already registered` };
  }
  const next = { workspaces: [...registry.workspaces, entry] };
  try {
    writeAtomic(path.join(awHome(), "workspaces.json"), `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed", message: "workspaces.json could not be written" };
  }
}

/**
 * Remove one entry from `workspaces.json` and NOTHING else.
 *
 * No repo file is touched and no run directory is touched — that is the promise the confirm
 * dialog makes (T21 step 2), and the reason this function has no other filesystem call in it.
 */
export function removeWorkspace(name: string): RegistryResult {
  const registry = readRegistryForWrite();
  if (!registry.ok) return { ok: false, reason: "corrupt", message: registry.message };
  const next = registry.workspaces.filter((w) => w.name !== name);
  if (next.length === registry.workspaces.length) {
    return { ok: false, reason: "missing", message: `workspace "${name}" is not registered` };
  }
  try {
    writeAtomic(path.join(awHome(), "workspaces.json"), `${JSON.stringify({ workspaces: next }, null, 2)}\n`);
    return { ok: true };
  } catch {
    return { ok: false, reason: "failed", message: "workspaces.json could not be written" };
  }
}

// ---------------------------------------------------------------------------
// aw.config.json (T21 step 2)
// ---------------------------------------------------------------------------

/**
 * Where a workspace's config lives: `<repoRoot>/aw.config.json`, with `repoRoot` taken from the
 * REGISTRY — never from the caller.
 *
 * This is the whole containment story for `/api/config`. The request names a workspace; the
 * workspace is looked up in `$AW_HOME/workspaces.json`; the only path that is ever opened is the
 * one that lookup produced, joined with a constant file name. A caller cannot express a path at
 * all, so there is nothing to traverse out of. (`repoRoot` itself is trusted for the same reason
 * `aw init` trusts it: it is a local file the developer owns, and the CLI already runs commands
 * in that directory.)
 */
export function configPathFor(workspace: string): string | null {
  const name = safeSegment(workspace);
  if (name === null) return null;
  const entry = listWorkspaces().find((w) => w.name === name);
  if (entry === undefined) return null;
  if (!path.isAbsolute(entry.repoRoot)) return null;
  return path.join(entry.repoRoot, "aw.config.json");
}

export type ConfigRead =
  | { ok: true; path: string; text: string; data: Record<string, unknown> }
  | { ok: false; path: string | null; message: string };

/** Read a workspace's `aw.config.json` as RAW JSON (not zod-parsed — the caller decides). */
export function readConfigFile(workspace: string): ConfigRead {
  const file = configPathFor(workspace);
  if (file === null) {
    return { ok: false, path: null, message: `workspace "${workspace}" is not registered` };
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      path: file,
      message:
        code === "ENOENT"
          ? "aw.config.json does not exist in this repo — run `npx tsx src/cli.ts init` there"
          : "aw.config.json could not be read",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    return { ok: false, path: file, message: `aw.config.json is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, path: file, message: "aw.config.json is not a JSON object" };
  }
  return { ok: true, path: file, text, data: raw as Record<string, unknown> };
}

/** Write `aw.config.json` atomically (temp file + `rename` in the same directory). */
export function writeConfigFile(file: string, text: string): boolean {
  try {
    writeAtomic(file, text);
    return true;
  } catch {
    return false;
  }
}
