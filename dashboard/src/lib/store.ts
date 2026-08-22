/**
 * The dashboard's READ side of the run store (T17 step 3).
 *
 * SERVER ONLY. Every function here touches `node:fs`, so this module must never be reached from
 * a `"use client"` component — the import of `node:fs` makes that a hard build error rather than
 * a subtle leak, which is the guarantee we want. Nothing in `src/app/` is a client component;
 * data is read in server components and passed down as plain values.
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
 */
function realRunDir(workspace: string, runId: string): string | null {
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

/** Parse one `manifest.json`. `null` for anything unreadable, invalid, or not a RunManifest. */
function loadManifest(dir: string): RunManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = RunManifest.safeParse(raw);
  return parsed.success ? parsed.data : null;
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
  const dir = realRunDir(workspace, runId);
  if (dir === null) return absent;
  const file = path.join(dir, "log.txt");

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
    return {
      ...absent,
      exists: true,
      bytes: size,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // A byte offset lands mid-line (and possibly mid-UTF-8-character); the first line goes.
  if (partial) text = text.slice(text.indexOf("\n") + 1);

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
