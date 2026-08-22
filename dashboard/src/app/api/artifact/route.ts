import fs from "node:fs";
import { Readable } from "node:stream";
import { resolveArtifact } from "@/lib/store";

/**
 * `GET /api/artifact?ws=&run=&path=` — stream one file out of a run directory.
 *
 * This is the only endpoint that turns a URL into a filesystem read, so it is written to be
 * boring in exactly two ways:
 *
 * 1. **It answers 404 or it answers the file. Never 500.** Every failure — a bad workspace name,
 *    a traversal attempt, a missing file, a dangling symlink, a read error mid-stream — takes the
 *    same `notFound()` exit. A stack trace in the response would hand an attacker the absolute
 *    path of the store, and a 500 would tell them the difference between "rejected" and "does not
 *    exist"; a uniform 404 tells them nothing.
 * 2. **Path confinement lives in one function.** `resolveArtifact` (src/lib/store.ts) does the
 *    segment validation, the `..` scan, the lexical containment check and the post-`realpath`
 *    re-check. Note that `URLSearchParams` has already percent-decoded the value by the time it
 *    is read here, so `%2e%2e%2f` reaches the checks as `../`, and nothing decodes it again
 *    afterwards — a second decode after validation is the classic way this bug comes back.
 *
 * Content types come from a small allow-list; `.html`/`.svg` are deliberately not on it and fall
 * back to `application/octet-stream`, so an agent-written artifact cannot execute script on the
 * panel's origin. `X-Content-Type-Options: nosniff` stops the browser from overruling that.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("404 — no such artifact\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const ws = params.get("ws");
    const run = params.get("run");
    const relPath = params.get("path");
    if (ws === null || run === null || relPath === null) return notFound();

    const artifact = resolveArtifact(ws, run, relPath);
    if (artifact === null) return notFound();

    // Streamed rather than buffered: design-loop videos and screenshots are the big artifacts,
    // and the panel should not hold one in memory to hand it to a <video> tag.
    const stream = Readable.toWeb(
      fs.createReadStream(artifact.absPath),
    ) as unknown as ReadableStream<Uint8Array>;

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": artifact.contentType,
        "content-length": String(artifact.size),
        // `inline` so images and markdown open in the tab; the filename is the artifact's own
        // basename, quoted, and it came from a path we already resolved inside the run directory.
        "content-disposition": `inline; filename="${artifact.fileName.replace(/["\\]/g, "_")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  } catch {
    return notFound();
  }
}
