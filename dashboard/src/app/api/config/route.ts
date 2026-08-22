/**
 * `GET/PUT /api/config?ws=` — read and write one workspace's `aw.config.json` (T21 step 2).
 *
 * The path is never a parameter. A request names a WORKSPACE; `configPathFor()` looks that name
 * up in `$AW_HOME/workspaces.json` and joins the registered `repoRoot` with the constant file
 * name. There is no string a caller can send that becomes part of a path, so there is nothing to
 * traverse out of — the containment argument here is "no path input exists", which is stronger
 * than any amount of `..` filtering.
 *
 * What PUT writes is the developer's file, so it is written the way `aw init` writes it
 * (src/commands/init.ts) and for the same reasons:
 *
 * - the patch is merged into the RAW parsed JSON, not into `AwConfig.parse()`'s output, so keys
 *   the schema does not know about survive;
 * - the merged object is validated with `AwConfig` BEFORE anything is written, and a failure
 *   returns its issues with dotted paths for the form to place next to the fields — nothing
 *   reaches disk;
 * - a save that changes nothing writes nothing, leaving a hand-formatted file byte-identical;
 * - the write itself is `tmp` + `rename`, so a reader (the CLI, mid-run) never sees half a file;
 * - a password can neither arrive (the patch schema is strict and has no such field) nor be
 *   re-persisted (the existing file is scanned first). SPEC § Dashboard security invariants #5.
 */
import { AwConfig } from "@shared/schemas";
import { fail, guardHost, guardMutation, issuesOf, json, readJsonBody } from "@/lib/api-guard";
import {
  ConfigPutBody,
  configRuleIssues,
  findSecretKeys,
  mergeConfig,
  mergeIssues,
  prototypeKeys,
  sameJson,
  serializeConfig,
  toFieldIssues,
} from "@/lib/config-patch";
import { readConfigFile, writeConfigFile } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  // Read-only, but it hands back the developer's `aw.config.json` — including the absolute path of
  // their repo — so it is pinned to loopback like every other route.
  const host = guardHost(request);
  if (host !== null) return host;

  const ws = new URL(request.url).searchParams.get("ws");
  if (ws === null || ws.trim() === "") return fail("ws is required", 400);

  const read = readConfigFile(ws);
  if (!read.ok) return fail(read.message, 404, { path: read.path });

  // Reported alongside the raw config: the form shows the values, the page shows whether the CLI
  // would accept them. A config that is already invalid on disk (hand-edited, or written by an
  // older schema) must not look fine just because the panel can render it.
  const parsed = AwConfig.safeParse(read.data);
  const issues = mergeIssues(
    configRuleIssues(read.data),
    parsed.success ? [] : toFieldIssues(parsed.error.issues),
  );
  return json({ ok: true, ws, path: read.path, config: read.data, valid: issues.length === 0, issues });
}

export async function PUT(request: Request): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;

  const raw = await readJsonBody(request);

  // Before zod: `__proto__` never reaches a `strictObject`'s unknown-key check, because assigning
  // that name during the rebuild sets a prototype instead of an own property — so it used to be
  // dropped with a 200 while every other unknown key was a clean 400. See `prototypeKeys`.
  const forbidden = prototypeKeys(raw);
  if (forbidden.length > 0) {
    return fail(`${forbidden.join(", ")} is not a field of this request`, 400);
  }

  const body = ConfigPutBody.safeParse(raw);
  if (!body.success) {
    return fail("invalid request body", 400, { issues: issuesOf(body.error) });
  }
  const { ws, patch } = body.data;

  // Belt and braces: the patch schema is strict, so this can only fire if a future edit widens
  // it. It is one line and it is the difference between a bug and a stored password.
  const incoming = findSecretKeys(patch);
  if (incoming.length > 0) {
    return fail(
      `refusing to write ${incoming.join(", ")}: aw.config.json stores the NAME of the environment ` +
        "variable holding a password (passEnv), never a password or key",
      400,
    );
  }

  const read = readConfigFile(ws);
  if (!read.ok) return fail(read.message, 404, { path: read.path });

  // The file already contains something secret-shaped. Rewriting it would persist that secret in
  // a file the panel just took responsibility for, and silently dropping the key would delete
  // something the developer put there by hand. Refuse, name the key, change nothing.
  const existingSecrets = findSecretKeys(read.data);
  if (existingSecrets.length > 0) {
    return fail(
      `aw.config.json already contains ${existingSecrets.join(", ")} — move the value into an ` +
        "environment variable and reference it with passEnv, then save again. Nothing was written.",
      400,
      { path: read.path },
    );
  }

  const merged = mergeConfig(read.data, patch as Record<string, unknown>);

  // Two validators, one answer. `AwConfig` owns the shape (SPEC § Types); `configRuleIssues`
  // owns the rules a shape cannot express — an empty model, a port typed as words, a `passEnv`
  // that is not an identifier. Both run against the merged object BEFORE anything is written.
  const validated = AwConfig.safeParse(merged);
  const issues = mergeIssues(
    configRuleIssues(merged),
    validated.success ? [] : toFieldIssues(validated.error.issues),
  );
  if (issues.length > 0) {
    return fail("the resulting config is invalid — nothing was written", 400, {
      path: read.path,
      issues,
    });
  }

  if (sameJson(merged, read.data)) {
    // Byte-identical outcome: do not touch the file. `aw init` has the same property, and it is
    // what keeps a hand-formatted config out of the repo's diff after an accidental Save.
    return json({ ok: true, ws, path: read.path, config: read.data, unchanged: true });
  }

  if (!writeConfigFile(read.path, serializeConfig(merged))) {
    return fail("aw.config.json could not be written (check its permissions)", 500, {
      path: read.path,
    });
  }
  return json({ ok: true, ws, path: read.path, config: merged, unchanged: false });
}
