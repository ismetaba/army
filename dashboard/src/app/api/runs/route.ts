/**
 * `DELETE /api/runs?ws=&run=` — delete ONE run directory, recursively (T21 step 2).
 *
 * This is the most dangerous thing the panel can do, so the surface is deliberately tiny: two
 * query parameters, both single path segments, and one hard-coded shape they are allowed to
 * describe. There is no `area`, no `path`, no `recursive` flag — the only directory this route
 * can name is `$AW_HOME/<ws>/runs/<runId>`, and `mutableRunDir()` proves that segment by segment
 * against the resolved store root before anything is unlinked (see its doc comment: safe
 * segments, `lstat` so a symlink is refused rather than followed, and a depth-exact parent
 * chain). An archived run is not reachable from here at all — restore it first.
 *
 * Every rejection answers the same 404 as a run that simply does not exist. A traversal probe
 * learns nothing from the response, and nothing outside the run directory is ever touched.
 */
import { z } from "zod";
import { fail, guardHost, guardMutation, issuesOf, json } from "@/lib/api-guard";
import { deleteRun, isWorkspaceName, listRuns } from "@/lib/store";
import { listActiveRuns, listTriggeredRuns, streamStats } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/runs[?ws=]` — what the run tables poll every 5 s (T22 step 3).
 *
 * Two lists, because "is anything running" has two answers that can disagree:
 *
 *   - `runs` — the manifests on disk. A run started from a TERMINAL is only visible here, and a
 *     manifest still saying `running` an hour after its process died (SIGKILL, or a pulled plug —
 *     src/store.ts can cover neither) is also only visible here.
 *   - `active` — the children this panel process started, which is the only set it can cancel and
 *     the only set with a live transcript to stream.
 *
 * The client compares a digest of both against the last poll and calls `router.refresh()` when it
 * changes, so the table itself is still rendered on the server from the store — one source of
 * truth for what a run IS, and a poll that only decides WHEN to re-read it.
 *
 * Read-only, so no `guardMutation` — but `guardHost` still applies. A cross-origin `fetch` cannot
 * read the body without the CORS headers this route never sends; a DNS-rebound page is not
 * cross-origin, and this response enumerates every workspace and run id in the store, which is the
 * reconnaissance step in front of the write routes. `stream` reports the resources `/api/logs`
 * currently holds — see `streamStats`.
 */
const LIST_LIMIT = 200;

export async function GET(request: Request): Promise<Response> {
  const host = guardHost(request);
  if (host !== null) return host;

  const url = new URL(request.url);
  const wsParam = url.searchParams.get("ws");

  if (wsParam !== null && !isWorkspaceName(wsParam)) return fail("no such workspace", 404);
  const ws = wsParam ?? undefined;

  const runs = listRuns(ws)
    .slice(0, LIST_LIMIT)
    .map((r) => ({
      runId: r.runId,
      workspace: r.workspace,
      kind: r.kind,
      status: r.status,
      createdAt: r.createdAt,
      durationMs: r.durationMs ?? null,
    }));

  return json({
    ok: true,
    ws: ws ?? null,
    runs,
    running: runs.filter((r) => r.status === "running").map((r) => r.runId),
    active: listActiveRuns(ws),
    recent: listTriggeredRuns(ws).slice(0, 20),
    stream: streamStats(),
  });
}

/** Strict: an unexpected query parameter is a mistake worth reporting, not something to ignore. */
const RunQuery = z.strictObject({ ws: z.string().min(1), run: z.string().min(1) });

export async function DELETE(request: Request): Promise<Response> {
  const guard = guardMutation(request, false);
  if (guard !== null) return guard;

  const url = new URL(request.url);
  const query = RunQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return fail("ws and run are required", 400, { issues: issuesOf(query.error) });

  const { ws, run } = query.data;
  const result = deleteRun(ws, run, "runs");
  if (result === "not-found") return fail("no such run", 404);
  if (result !== "ok") return fail("the run directory could not be deleted", 500);
  return json({ ok: true, ws, run, deleted: true });
}
