import fs from "node:fs";
import path from "node:path";
import { fail, guardMutation, json, readJsonBody } from "@/lib/api-guard";
import { readRun, realRunDir, resolveRunFile } from "@/lib/store";
import {
  FEEDBACK_FILE,
  FEEDBACK_MAX_ITEMS,
  strictFeedbackQueue,
  validateFeedbackText,
  type FeedbackEntry,
} from "@/components/design-data";

/**
 * `POST /api/feedback` — append one item to `<runDir>/feedback-queue.json` (T20 step 3).
 *
 * This is the panel's FIRST write path, and everything below follows from one fact: the body is
 * user input that lands on disk in a directory an agent later reads and a human later pastes into
 * a terminal. So:
 *
 * 1. **The body is typed, not coerced.** `ws`, `runId` and `text` must each be a plain string
 *    (`validateFeedbackText` checks `typeof` FIRST, before anything could stringify an object or
 *    an array into the file), the text is capped at 2000 characters, and control characters are
 *    rejected outright — see `design-data.ts` for why an ESC in a copyable command is not merely
 *    untidy.
 * 2. **The run must exist and be a design-loop run.** `readRun` resolves the run directory with
 *    `realpath` and re-checks it against the resolved `$AW_HOME`, so a symlinked workspace or run
 *    directory cannot relocate the write; `realRunDir` (the store's own helper — this route used
 *    to keep a private copy of it) is called again to obtain the resolved path to write into, with
 *    the REQUEST's `ws`/`runId` and not the manifest's. Those two can disagree: a manifest is run
 *    content and run content is untrusted (SPEC § Dashboard security invariants #3), and a
 *    manifest declaring someone else's `runId` used to redirect this write into that run's
 *    directory. Anything that fails answers 404 — the same answer a run that does not exist gets,
 *    and never a message naming a real path (SPEC § Dashboard security invariants #2).
 * 3. **The write is atomic.** A temp file in the same directory, then `rename`, which is atomic
 *    within a filesystem: a reader (the Design tab renders on every request) sees either the old
 *    array or the new one, never a half-written file. Writes are also serialised per run
 *    directory, because tmp+rename alone stops truncation but not a lost update between two
 *    read-modify-write cycles.
 * 4. **A queue file we do not fully understand is never overwritten.** The read-modify-write uses
 *    `strictFeedbackQueue`, not the lenient parser the Design tab RENDERS with. The lenient one
 *    drops entries it cannot represent and keeps only `text`/`createdAt` — fine for display, and
 *    data loss when the result is written back over the file (measured: a hand-written note with
 *    no `createdAt` disappeared, and a sibling's `appliedAt`/`author` fields were stripped). The
 *    strict one refuses the whole file with a 409 instead, which is the rule `readRegistryForWrite`
 *    already states for `workspaces.json`: `[]` is a fine thing to render and a catastrophic thing
 *    to write back.
 * 5. **The shared front door.** `guardMutation` from `@/lib/api-guard` — Host pinned to loopback
 *    (the DNS-rebinding gate), `Origin` matched against it, `Sec-Fetch-Site` refused when it says
 *    cross-site, JSON content type required. This route re-implemented a weaker version of that
 *    (no `Sec-Fetch-Site` check, and `{ok:false,error}` where every other route answers
 *    `{ok:false,message}`) until it was folded back onto the shared one.
 *
 * Not covered here: actually running the CLI. T22 owns that, and SPEC § Dashboard security
 * invariants #4 (argv arrays, per-kind allowlists) applies there. This route only writes JSON;
 * the queued text reaches a shell only when a human copies the command the tab renders, which is
 * why that command is single-quoted at the point it is built.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A queue file larger than this is treated as unusable rather than parsed. */
const MAX_QUEUE_BYTES = 256 * 1024;

type QueueRead = { state: "ok"; entries: FeedbackEntry[] } | { state: "unusable" };

/**
 * The queue as it stands. A missing file is an empty queue, not an error.
 *
 * The file is resolved through the store's `resolveRunFile` before it is read: an agent with
 * `write_file` could have replaced `feedback-queue.json` with a symlink to something outside the
 * run, and reading through it would turn this endpoint into a file-disclosure primitive (the
 * contents come back in the response). The WRITE side does not need the same care — `rename`
 * replaces a symlink rather than following it — but it must not write through one either, which is
 * why `writeQueue` uses the unresolved name.
 *
 * `strictFeedbackQueue`, not `parseFeedbackQueue`: see gate 4 in the header comment.
 */
function readQueue(ws: string, runId: string, realDir: string): QueueRead {
  const file = resolveRunFile(ws, runId, FEEDBACK_FILE);
  if (file === null) {
    // Either nothing is there (an empty queue) or something is and it is not a contained regular
    // file (a symlink, a directory) — which must never be read or replaced silently.
    try {
      fs.lstatSync(path.join(realDir, FEEDBACK_FILE));
      return { state: "unusable" };
    } catch {
      return { state: "ok", entries: [] };
    }
  }
  let raw: string;
  try {
    if (fs.statSync(file).size > MAX_QUEUE_BYTES) return { state: "unusable" };
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { state: "unusable" };
  }
  const entries = strictFeedbackQueue(raw);
  return entries === null ? { state: "unusable" } : { state: "ok", entries };
}

/**
 * Serialise writes per run directory.
 *
 * tmp+rename guarantees no reader sees a truncated file; it does not stop two overlapping
 * requests from both reading `[a]`, both appending, and one of the two items vanishing. The panel
 * runs in a single Node process, so a promise chain keyed by directory is a complete answer to
 * that — no lock file, no dependency. The map entry is dropped once the chain drains so it cannot
 * grow with the number of runs visited.
 */
const chains = new Map<string, Promise<void>>();

function serialised<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  // `then(work, work)` and not `then(work)`: a rejected predecessor must not skip this request.
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, settled);
  void settled.then(() => {
    // Only the LAST writer clears the slot. An earlier one deleting it would let a request that
    // arrives next start in parallel with one still queued behind this chain.
    if (chains.get(key) === settled) chains.delete(key);
  });
  return next;
}

/** Write the array atomically: temp file in the same directory, then `rename` over the target. */
function writeQueue(realDir: string, entries: FeedbackEntry[]): boolean {
  // NOT the realpath: `rename` replaces the name, so a planted symlink at `feedback-queue.json`
  // is overwritten rather than written through.
  const target = path.join(realDir, FEEDBACK_FILE);
  const tmp = path.join(
    realDir,
    `.${FEEDBACK_FILE}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    // `wx` — never follow or clobber an existing temp file; the random suffix makes a collision a
    // real bug rather than something to retry through.
    fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The temp file was never created, or is already gone. Either way the queue is unchanged.
    }
    return false;
  }
}

/**
 * The largest body this route will parse.
 *
 * The cap on the NOTE is 2000 characters, but it is applied after `request.json()` has already
 * materialised the whole body — a 10 MB POST was read into memory in full and then rejected. Route
 * Handlers have no default body limit, so this is the only thing bounding it. A few kB is generous
 * for a 2000-character note plus two run ids.
 */
const MAX_BODY_BYTES = 16 * 1024;

/** `413` before the body is read, when the caller was honest about its size. */
function tooLarge(request: Request): Response | null {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(`body is larger than ${MAX_BODY_BYTES} bytes`, 413);
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const guard = guardMutation(request);
    if (guard !== null) return guard;
    const oversize = tooLarge(request);
    if (oversize !== null) return oversize;

    const body = await readJsonBody(request);
    if (body === undefined) return fail("body is not valid JSON", 400);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return fail("body must be a JSON object", 400);
    }

    const { ws, runId, text } = body as Record<string, unknown>;
    if (typeof ws !== "string" || typeof runId !== "string") {
      return fail("ws and runId must be strings", 400);
    }
    const validated = validateFeedbackText(text);
    if (!validated.ok) return fail(validated.error, 400);

    // The manifest is the authorisation check: it proves the run exists, sits inside `$AW_HOME`,
    // and is a design-loop run. A 404 for all three, so a caller cannot tell them apart.
    const run = readRun(ws, runId);
    if (run === null || run.kind !== "design-loop") return fail("no such design-loop run", 404);

    // The REQUEST's names, never the manifest's — see gate 2. `readRun` has already proven they
    // resolve inside `$AW_HOME`, and `loadManifest` now anchors the manifest's own identity to the
    // directory it was read from, so a disagreement here is a store that moved under us.
    const realDir = realRunDir(ws, runId);
    if (realDir === null) return fail("no such design-loop run", 404);

    return await serialised(realDir, async () => {
      const current = readQueue(ws, runId, realDir);
      if (current.state === "unusable") {
        return fail(
          `${FEEDBACK_FILE} exists but is not a readable feedback queue — move it aside and retry`,
          409,
        );
      }
      if (current.entries.length >= FEEDBACK_MAX_ITEMS) {
        return fail(`the queue already holds ${FEEDBACK_MAX_ITEMS} items`, 409);
      }

      const entries = [...current.entries, { text: validated.value, createdAt: new Date().toISOString() }];
      if (!writeQueue(realDir, entries)) return fail("the queue could not be written", 409);
      return json({ ok: true, queue: entries });
    });
  } catch {
    // Same rule as /api/artifact: a mutating local endpoint answers with a short message, never a
    // stack and never a path.
    return fail("the queue could not be written", 500);
  }
}

/**
 * `DELETE /api/feedback { ws, runId, text, createdAt }` — retire ONE queued item (T22 step 3).
 *
 * T20 only ever appended, because until T22 the queue was applied by copying a command into a
 * terminal and nothing could tell the panel it had happened. "Apply now" can: it starts the
 * `--iterate` run itself, and the item has to leave the queue or the next click starts the same
 * run again.
 *
 * The item is identified by its CONTENT (`text` + `createdAt`), never by an index. An index is a
 * position in a file two tabs and a CLI can all be appending to; between the render that showed
 * item 3 and the request that deletes item 3, item 3 may be a different note. Matching on content
 * removes the item that was actually on screen, or nothing at all. Exactly one occurrence is
 * removed even when the same note was queued twice.
 *
 * It goes through the same `serialised` chain as the append, so a delete and an append that
 * overlap cannot lose each other's work, and it refuses an unparseable queue file for the same
 * reason the append does.
 */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const guard = guardMutation(request);
    if (guard !== null) return guard;
    const oversize = tooLarge(request);
    if (oversize !== null) return oversize;

    const body = await readJsonBody(request);
    if (body === undefined) return fail("body is not valid JSON", 400);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return fail("body must be a JSON object", 400);
    }

    const { ws, runId, text, createdAt } = body as Record<string, unknown>;
    if (typeof ws !== "string" || typeof runId !== "string") {
      return fail("ws and runId must be strings", 400);
    }
    if (typeof text !== "string" || typeof createdAt !== "string") {
      return fail("text and createdAt must be strings", 400);
    }

    const run = readRun(ws, runId);
    if (run === null || run.kind !== "design-loop") return fail("no such design-loop run", 404);

    const realDir = realRunDir(ws, runId);
    if (realDir === null) return fail("no such design-loop run", 404);

    return await serialised(realDir, async () => {
      const current = readQueue(ws, runId, realDir);
      if (current.state === "unusable") {
        return fail(
          `${FEEDBACK_FILE} exists but is not a readable feedback queue — move it aside and retry`,
          409,
        );
      }
      const index = current.entries.findIndex((e) => e.text === text && e.createdAt === createdAt);
      if (index < 0) {
        // Already gone — another tab applied it, or the file was edited. Reporting the queue as it
        // stands lets the caller resynchronise instead of retrying forever.
        return json({ ok: true, removed: false, queue: current.entries }, 200);
      }
      const entries = current.entries.filter((_, i) => i !== index);
      if (!writeQueue(realDir, entries)) return fail("the queue could not be written", 409);
      return json({ ok: true, removed: true, queue: entries }, 200);
    });
  } catch {
    return fail("the queue could not be written", 500);
  }
}
