/**
 * `POST /api/trigger { ws, kind, args }` → `{ ok: true, pid, … }` (T22 step 2).
 *
 * The only route in the panel that starts a process. Four gates, in this order, and each one
 * answers before the next can matter:
 *
 * 1. `guardMutation` — the same cross-site defence T21 put in front of every mutating route
 *    (`Origin` must match the `Host` it was addressed to, `Sec-Fetch-Site` must not say
 *    cross-site, and the body must be `application/json`). A page in another tab must not be able
 *    to make the developer's machine run a workflow.
 * 2. The body is a JSON object with a `kind` from a three-literal list.
 * 3. `startTriggeredRun` resolves `ws` through `workspaces.json` — the request never names a path
 *    — and `buildTriggerArgv` reduces `args` to an argv ARRAY through a per-kind allowlist
 *    (SPEC § Dashboard security invariants #4). An unknown key is a 400, not a silent drop.
 * 4. The 1-per-workspace guard answers 409 with the pid that is holding the workspace, so the
 *    modal can offer to watch it.
 *
 * The response deliberately echoes `argv` back. It is what the "New run" modal shows before the
 * live view opens, and it is the thing to look at when a run does something surprising: the array
 * is the truth, the pretty `display` string is only a rendering of it.
 */
import { fail, guardMutation, json, readJsonBody } from "@/lib/api-guard";
import { startTriggeredRun } from "@/lib/runner";
import { isTriggerKind, TRIGGER_KINDS } from "@/lib/trigger-args";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;

  const body = await readJsonBody(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("body must be a JSON object", 400);
  }

  const { ws, kind, args } = body as Record<string, unknown>;
  if (!isTriggerKind(kind)) {
    return fail(`kind must be one of ${TRIGGER_KINDS.join(", ")}`, 400, { field: "kind" });
  }

  const started = startTriggeredRun(ws, kind, (args ?? {}) as Record<string, unknown>);
  if (!started.ok) {
    return fail(started.message, started.status, {
      ...(started.field ? { field: started.field } : {}),
      ...(started.runningPid ? { runningPid: started.runningPid } : {}),
    });
  }

  return json({ ok: true, pid: started.run.pid, run: started.run });
}
