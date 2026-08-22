/**
 * `POST /api/cancel { pid }` (T22 step 2).
 *
 * The dangerous shape of this route is obvious: it takes a number from a browser and it is next
 * to `process.kill`. It never passes one through. `cancelTriggeredRun` looks the pid up in the
 * runner's in-memory map of children THIS panel process spawned, and answers 404 for anything
 * else — so the endpoint's reach is "the workflows this panel started", not "any process on this
 * machine". Everything about how the kill is delivered (the process GROUP, SIGTERM first, SIGKILL
 * only after 10 s so the CLI's own handler can mark the manifest `cancelled` and stop the dev
 * servers it started) lives in `@/lib/runner`.
 */
import { fail, guardMutation, json, readJsonBody } from "@/lib/api-guard";
import { cancelTriggeredRun, CANCEL_ESCALATE_MS } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;

  const body = await readJsonBody(request);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("body must be a JSON object", 400);
  }

  const { pid } = body as Record<string, unknown>;
  const result = cancelTriggeredRun(pid);
  if (!result.ok) return fail(result.message, result.status);

  return json({
    ok: true,
    pid: result.run.pid,
    run: result.run,
    message: `SIGTERM sent to the process group; SIGKILL follows in ${CANCEL_ESCALATE_MS / 1000}s if it is still alive.`,
  });
}
