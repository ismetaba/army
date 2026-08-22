/**
 * `POST /api/runs/archive?ws=&run=` — move a run out of the way without destroying it (T21
 * step 2), and `?action=restore` to move it back.
 *
 * Archiving is a `rename` from `$AW_HOME/<ws>/runs/<runId>` to `$AW_HOME/<ws>/archive/<runId>`:
 * atomic, instant even for a run carrying a video, and reversible. Both ends are built from the
 * resolved store root plus two validated segments (`mutableRunDir` / `moveRun` in
 * `src/lib/store.ts`), so neither side of the move can be aimed anywhere else, and an existing
 * destination is reported rather than overwritten — `rename` would replace it silently.
 *
 * `restore` exists because a one-way archive button in a UI is a trap: the panel would be able to
 * hide a run and offer no way back short of a terminal. It is the same move with the two
 * directories swapped, and it goes through exactly the same gate.
 */
import { z } from "zod";
import { fail, guardMutation, issuesOf, json } from "@/lib/api-guard";
import { moveRun } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ArchiveQuery = z.strictObject({
  ws: z.string().min(1),
  run: z.string().min(1),
  action: z.enum(["archive", "restore"]).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const guard = guardMutation(request, false);
  if (guard !== null) return guard;

  const url = new URL(request.url);
  const query = ArchiveQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return fail("ws and run are required", 400, { issues: issuesOf(query.error) });

  const { ws, run } = query.data;
  const action = query.data.action ?? "archive";
  const from = action === "archive" ? "runs" : "archive";
  const to = action === "archive" ? "archive" : "runs";

  const result = moveRun(ws, run, from, to);
  if (result === "not-found") return fail("no such run", 404);
  if (result === "exists") {
    return fail(`a run named ${run} is already in ${to}/ — remove it there first`, 409);
  }
  if (result !== "ok") return fail(`the run directory could not be moved to ${to}/`, 500);
  return json({ ok: true, ws, run, action, movedTo: to });
}
