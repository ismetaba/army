import fs from "node:fs";
import { Readable } from "node:stream";
import { guardHost } from "@/lib/api-guard";
import { resolveArtifact } from "@/lib/store";

/**
 * `GET /api/artifact?ws=&run=&path=` — stream one file out of a run directory.
 *
 * This is the only endpoint that turns a URL into a filesystem read, so it is written to be
 * boring in exactly two ways:
 *
 * 1. **It answers 404 or it answers the file. Never 500.** Every failure up to the point the
 *    stream is handed to the Response — a bad workspace name, a traversal attempt, a missing
 *    file, a dangling symlink — takes the same `notFound()` exit. A stack trace in the response
 *    would hand an attacker the absolute path of the store, and a 500 would tell them the
 *    difference between "rejected" and "does not exist"; a uniform 404 tells them nothing.
 *    A read error AFTER streaming has begun is the one failure HTTP cannot re-status: the client
 *    sees an aborted 200/206 body (a short read against the declared `content-length`), which a
 *    browser treats as a failed transfer — still no stack, still no path.
 * 2. **Path confinement lives in one function.** `resolveArtifact` (src/lib/store.ts) does the
 *    segment validation, the `..` scan, the lexical containment check and the post-`realpath`
 *    re-check. Note that `URLSearchParams` has already percent-decoded the value by the time it
 *    is read here, so `%2e%2e%2f` reaches the checks as `../`, and nothing decodes it again
 *    afterwards — a second decode after validation is the classic way this bug comes back.
 *
 * Content types come from a small allow-list; `.html`/`.svg` are deliberately not on it and fall
 * back to `application/octet-stream`, so an agent-written artifact cannot execute script on the
 * panel's origin. `X-Content-Type-Options: nosniff` stops the browser from overruling that.
 *
 * Being read-only does not exempt it from `guardHost`. What it reads out is a repo diff, a report
 * and design screenshots — private data by SPEC's preamble — and to a DNS-rebound page the panel
 * IS the same origin, so CORS would not withhold the body. The `Host` header must name loopback.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A single `bytes=start-end` range, clamped to the file, or `null` for "send the whole thing".
 *
 * Only the one-range form is honoured — that is what a `<video>` element sends when it seeks,
 * and multi-range replies need multipart bodies for no benefit here. Anything unparseable or
 * unsatisfiable falls back to the full 200 response rather than erroring.
 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (header === null || size === 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;
  if (rawStart === "") {
    if (rawEnd === "") return null;
    // `bytes=-500`: the last 500 bytes.
    start = Math.max(0, size - Number(rawEnd));
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

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
    const host = guardHost(request);
    if (host !== null) return host;

    const params = new URL(request.url).searchParams;
    const ws = params.get("ws");
    const run = params.get("run");
    const relPath = params.get("path");
    if (ws === null || run === null || relPath === null) return notFound();

    const artifact = resolveArtifact(ws, run, relPath);
    if (artifact === null) return notFound();

    // Streamed rather than buffered: design-loop videos and screenshots are the big artifacts,
    // and the panel should not hold one in memory to hand it to a <video> tag. That same tag
    // needs byte ranges to seek, so a single `bytes=` range is answered with a 206 over a
    // positioned stream; `accept-ranges` on the 200 is what tells the player it may ask.
    const range = parseRange(request.headers.get("range"), artifact.size);
    const file = fs.createReadStream(
      artifact.absPath,
      range === null ? undefined : { start: range.start, end: range.end },
    );
    // `toWeb` propagates errors into the web stream; this listener is the belt to that brace, so
    // a file truncated mid-transfer can never surface as an unhandled 'error' event. The response
    // itself is already on the wire by then — see the header comment.
    file.on("error", () => file.destroy());
    const stream = Readable.toWeb(file) as unknown as ReadableStream<Uint8Array>;

    return new Response(stream, {
      status: range === null ? 200 : 206,
      headers: {
        "content-type": artifact.contentType,
        "content-length": String(range === null ? artifact.size : range.end - range.start + 1),
        "accept-ranges": "bytes",
        ...(range === null
          ? {}
          : { "content-range": `bytes ${range.start}-${range.end}/${artifact.size}` }),
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
