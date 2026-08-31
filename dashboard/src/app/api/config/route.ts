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
import fs from "node:fs";
import path from "node:path";
import { migrateConfig, parseAwConfig } from "@shared/schemas";
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
import { readConfigFile, updateWorkspaceTargets, writeConfigFile } from "@/lib/store";

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

  // T23: the form edits the TARGET shape, so a pre-T23 file is served in its migrated form —
  // the same mapping the CLI applies on read. The file on disk is not touched by a GET.
  const config = migrateConfig(read.data) as Record<string, unknown>;

  // Reported alongside the config: the form shows the values, the page shows whether the CLI
  // would accept them. A config that is already invalid on disk (hand-edited, or written by an
  // older schema) must not look fine just because the panel can render it.
  const parsed = parseAwConfig(config);
  const issues = mergeIssues(
    configRuleIssues(config),
    parsed.success ? [] : toFieldIssues(parsed.error.issues),
  );
  return json({ ok: true, ws, path: read.path, config, valid: issues.length === 0, issues });
}

/**
 * T23: a target's `repoRoot` is editable from the form, so the route holds it to the same bar
 * `aw init` and `POST /api/workspaces` apply to a repo path: it must name a git repository.
 * (`configRuleIssues` already required it to be absolute; this is the half that needs `fs`.)
 */
function targetRepoIssues(config: unknown): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (typeof config !== "object" || config === null) return issues;
  for (const key of ["backend", "frontend"] as const) {
    const target = (config as Record<string, unknown>)[key];
    if (typeof target !== "object" || target === null || Array.isArray(target)) continue;
    const repoRoot = (target as Record<string, unknown>).repoRoot;
    if (typeof repoRoot !== "string" || !path.isAbsolute(repoRoot)) continue; // rules cover these
    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      issues.push({
        path: `${key}.repoRoot`,
        message: `not a git repository: ${repoRoot} (no .git found)`,
      });
    }
  }
  return issues;
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

  // T23: the patch describes the TARGET shape, so it merges into the MIGRATED form of the file.
  // A save that actually changes something therefore rewrites a pre-T23 file into the new shape
  // — which is the "the panel's settings save writes the new shape" half of the migration rule —
  // while a no-op save still writes nothing (compared against the migrated form below).
  const base = migrateConfig(read.data) as Record<string, unknown>;
  const merged = mergeConfig(base, patch as Record<string, unknown>);

  // Two validators, one answer. `AwConfig` owns the shape (SPEC § Types); `configRuleIssues`
  // owns the rules a shape cannot express — an empty model, a port typed as words, a `passEnv`
  // that is not an identifier. Both run against the merged object BEFORE anything is written,
  // plus the one rule that needs the filesystem: a target repoRoot must name a git repo.
  const validated = parseAwConfig(merged);
  const issues = mergeIssues(
    [...configRuleIssues(merged), ...targetRepoIssues(merged)],
    validated.success ? [] : toFieldIssues(validated.error.issues),
  );
  if (issues.length > 0) {
    return fail("the resulting config is invalid — nothing was written", 400, {
      path: read.path,
      issues,
    });
  }

  if (sameJson(merged, base)) {
    // Byte-identical outcome: do not touch the file. `aw init` has the same property, and it is
    // what keeps a hand-formatted config out of the repo's diff after an accidental Save.
    return json({ ok: true, ws, path: read.path, config: base, unchanged: true });
  }

  if (!writeConfigFile(read.path, serializeConfig(merged))) {
    return fail("aw.config.json could not be written (check its permissions)", 500, {
      path: read.path,
    });
  }
  // T23: the runner spawns with the registry's per-target roots, so they follow the config.
  // Best-effort — the config write already succeeded and stands either way.
  if (validated.success) {
    updateWorkspaceTargets(ws, {
      backendRepo: validated.data.backend?.repoRoot,
      frontendRepo: validated.data.frontend?.repoRoot,
    });
  }
  return json({ ok: true, ws, path: read.path, config: merged, unchanged: false });
}
