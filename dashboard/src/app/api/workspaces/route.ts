/**
 * `POST /api/workspaces` (register an existing repo) and `DELETE /api/workspaces?name=`
 * (forget it again) — T21 step 2.
 *
 * Registration is the ONE place in the panel where a filesystem path legitimately comes from the
 * request, and it is the same path `aw init --repo` takes: the developer naming a checkout on
 * their own machine. It is not a traversal surface — nothing is read out of it here — but it is
 * still validated before it is stored, because everything downstream (`/api/config`, the CLI's
 * `--workspace`) trusts `workspaces.json` afterwards:
 *
 * - the name must be a legal directory segment (it becomes `$AW_HOME/<name>/`);
 * - the path must be absolute, so a registry entry cannot depend on anyone's cwd;
 * - `.git` and `aw.config.json` must both exist, else the 400 says to run `aw init` — the exact
 *   case T21 acceptance 4 asks for;
 * - the config must parse as `AwConfig` and must declare THIS workspace name, because
 *   `aw review --workspace <name>` resolves the repo through the registry and then takes the
 *   workspace identity from the config: a disagreement silently files runs under another name.
 *
 * Deleting only ever rewrites `workspaces.json`. `removeWorkspace()` has no other filesystem call
 * in it, which is what makes the confirm dialog's promise ("the repo and its runs are untouched")
 * checkable rather than aspirational.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseAwConfig } from "@shared/schemas";
import { fail, guardMutation, issuesOf, json, readJsonBody } from "@/lib/api-guard";
import { toFieldIssues } from "@/lib/config-patch";
import { addWorkspace, isWorkspaceName, removeWorkspace } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RegisterBody = z.strictObject({
  name: z.string().min(1),
  repoRoot: z.string().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const guard = guardMutation(request);
  if (guard !== null) return guard;

  const body = RegisterBody.safeParse(await readJsonBody(request));
  if (!body.success) return fail("invalid request body", 400, { issues: issuesOf(body.error) });

  const name = body.data.name.trim();
  const repoRoot = body.data.repoRoot.trim();

  if (!isWorkspaceName(name)) {
    return fail(
      `invalid workspace name "${name}" — use letters, digits, ".", "-" or "_" (it becomes a ` +
        "directory under the run store)",
      400,
      { field: "name" },
    );
  }
  if (repoRoot.includes("\0") || !path.isAbsolute(repoRoot)) {
    return fail("repoRoot must be an absolute path", 400, { field: "repoRoot" });
  }

  const resolved = path.resolve(repoRoot);
  if (!fs.existsSync(path.join(resolved, ".git"))) {
    return fail(`not a git repository: ${resolved} (no .git found)`, 400, { field: "repoRoot" });
  }
  const configPath = path.join(resolved, "aw.config.json");
  if (!fs.existsSync(configPath)) {
    return fail(
      `no aw.config.json in ${resolved} — run \`npx tsx src/cli.ts init --repo ${resolved}\` first`,
      400,
      { field: "repoRoot" },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  } catch (err) {
    return fail(`aw.config.json is not readable JSON: ${(err as Error).message}`, 400, {
      field: "repoRoot",
    });
  }
  // `parseAwConfig`, not a bare schema parse: a pre-T23 config (repoRoot + app) must register
  // exactly like a target-shaped one — migration on read, the file untouched.
  const parsed = parseAwConfig(raw);
  if (!parsed.success) {
    return fail(`aw.config.json in ${resolved} is not a valid config`, 400, {
      field: "repoRoot",
      issues: toFieldIssues(parsed.error.issues),
    });
  }
  if (parsed.data.workspace !== name) {
    return fail(
      `aw.config.json declares workspace "${parsed.data.workspace}" — register it under that ` +
        `name, or change the config first (the CLI takes the workspace identity from the file)`,
      400,
      { field: "name" },
    );
  }

  // T23: `repoRoot` stays the folder the config was FOUND in (it is what `--workspace` resolves
  // through); the per-target roots come from the config and are what the runner spawns with.
  const entry = {
    name,
    repoRoot: resolved,
    ...(parsed.data.backend ? { backendRepo: parsed.data.backend.repoRoot } : {}),
    ...(parsed.data.frontend ? { frontendRepo: parsed.data.frontend.repoRoot } : {}),
    createdAt: new Date().toISOString(),
  };
  const added = addWorkspace(entry);
  if (!added.ok) return fail(added.message, added.reason === "exists" ? 409 : 500);
  return json({ ok: true, workspace: entry }, 201);
}

export async function DELETE(request: Request): Promise<Response> {
  const guard = guardMutation(request, false);
  if (guard !== null) return guard;

  const name = new URL(request.url).searchParams.get("name");
  if (name === null || name.trim() === "") return fail("name is required", 400);

  const removed = removeWorkspace(name.trim());
  if (!removed.ok) return fail(removed.message, removed.reason === "missing" ? 404 : 500);
  return json({ ok: true, name: name.trim(), removed: "workspaces.json entry only" });
}
