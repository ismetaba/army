/**
 * T21 — turning a settings form submission into a new `aw.config.json`, without losing anything.
 *
 * Pure functions only: no `node:fs`, no request objects. `/api/config` does the I/O; everything
 * that decides WHAT gets written lives here, where it is unit-testable (`config-patch.test.ts`).
 *
 * Three rules, and each of them is a rule because breaking it damages a file the developer owns:
 *
 * 1. **The patch is a key ALLOW-LIST.** `ConfigPatch` is strict at every level, so a field the
 *    form does not have — `password`, `apiKey`, `repoRoot`, anything at all — is a 400 and not a
 *    silent write. `workspace` and `repoRoot` are deliberately absent: they are the workspace's
 *    identity, `aw init` owns them, and a panel that could retarget a workspace at another
 *    directory would be a way to make the CLI review the wrong repo.
 * 2. **Merge into the RAW file, never into the zod-parsed copy.** `AwConfig.parse()` strips keys
 *    the schema does not know about, so writing its output would delete a developer's hand-added
 *    `"notes"` or `"app.backend.env"` the first time anyone pressed Save. This is exactly what
 *    `aw init` does (src/commands/init.ts: "the RAW merged object is what gets written").
 * 3. **A no-op save writes nothing.** `mergeConfig` is compared against the original, and an
 *    unchanged result leaves the file byte-identical — again matching `aw init`, which hands back
 *    the existing bytes rather than re-serialising and re-indenting a hand-formatted file.
 *
 * Values are typed as `unknown` on purpose. `AwConfig` is the single source of truth for what a
 * port or a provider may be (SPEC § Types), so the patch schema only bounds the key space; the
 * merged object is then validated by `AwConfig` itself and its issues are what the form shows
 * next to the fields. Two schemas disagreeing about a value is a bug waiting to happen.
 */
import { z } from "zod";
import { AgentName, ProviderId } from "@shared/schemas";

export { AgentName, ProviderId };

/** The three agents, in the order the form lists them. */
export const AGENT_NAMES = AgentName.options;
/** The four providers of SPEC § Types, for the selects. */
export const PROVIDER_IDS = ProviderId.options;

/**
 * `null` means "delete this key". It is the only way the form can express "the app has no
 * frontend any more" — an omitted key means "leave whatever is there alone", which is what makes
 * a partial patch safe.
 */
const Value = z.unknown().optional();

const ModelChoicePatch = z.strictObject({ provider: Value, model: Value });

const ViewportPatch = z.strictObject({ width: Value, height: Value });

export const ConfigPatch = z.strictObject({
  defaults: ModelChoicePatch.optional(),
  /**
   * Keyed by AgentName, so `agents.reviewer` (a typo) is rejected instead of written.
   * `partialRecord`, not `record`, for the reason `shared/schemas.ts` gives at the same field:
   * zod@4's `z.record(<enum>, v)` demands EVERY enum key, and a patch that mentions one agent is
   * the normal case.
   */
  agents: z.partialRecord(AgentName, ModelChoicePatch.nullable()).nullable().optional(),
  app: z
    .strictObject({
      backend: z.strictObject({ start: Value, port: Value, healthPath: Value }).nullable().optional(),
      frontend: z.strictObject({ start: Value, port: Value }).nullable().optional(),
      baseUrl: Value,
      // `passEnv` is the NAME of an environment variable. There is no field for a password and
      // no way to add one: the object is strict (SPEC § Dashboard security invariants #5).
      testAccount: z.strictObject({ user: Value, passEnv: Value }).nullable().optional(),
      stagingUrl: Value,
    })
    .nullable()
    .optional(),
  viewports: z.strictObject({ mobile: ViewportPatch, desktop: ViewportPatch }).optional(),
  offLimits: z.union([z.array(z.unknown()), z.null()]).optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatch>;

/**
 * Keys that never travel through a patch, whatever their value.
 *
 * `z.strictObject` rejects an unknown key by comparing against its own shape — and it never SEES
 * `__proto__`, because assigning that name during the rebuild sets a prototype instead of creating
 * an own property. So a patch carrying `{"__proto__":{"defaults":{"model":"pwn"}}}` answered 200
 * and silently dropped it, while every other unknown key (`evil`, `repoRoot`, `workspace`) got a
 * clean 400. The key is inert in practice — `mergeConfig` never sees it and `sameJson` reports
 * "unchanged" — but this module's contract is "a field the form does not have, anything at all, is
 * a 400 and not a silent write", and a contract that is true except in one case is worse than the
 * bug. `POST /api/trigger` already reports it (`"__proto__" is not an argument of review`).
 */
const FORBIDDEN_KEYS = ["__proto__", "constructor", "prototype"];

function prototypeKeysIn(value: unknown, path: string[] = []): string[] {
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => prototypeKeysIn(v, [...path, String(i)]));
  const out: string[] = [];
  // `Object.getOwnPropertyNames`, not `Object.keys`: `JSON.parse` DOES create `__proto__` as an
  // own (non-enumerable-safe) property, and it is the raw parsed body we are scanning here.
  for (const key of Object.getOwnPropertyNames(value)) {
    const here = [...path, key].join(".");
    if (FORBIDDEN_KEYS.includes(key)) out.push(here);
    out.push(...prototypeKeysIn((value as Record<string, unknown>)[key], [...path, key]));
  }
  return out;
}

/** The body of `PUT /api/config`. */
export const ConfigPutBody = z.strictObject({
  ws: z.string().min(1),
  patch: ConfigPatch,
});

/**
 * Prototype-shaped keys anywhere in the RAW body, dotted. `[]` when there are none.
 *
 * Called on the parsed-but-not-yet-zod-rebuilt body: after `ConfigPutBody.parse` the evidence is
 * gone, which is the whole reason this exists as a separate scan.
 */
export function prototypeKeys(raw: unknown): string[] {
  return prototypeKeysIn(raw);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge `patch` into `existing`, with three cases per key:
 *
 * - `null`  → the key is deleted;
 * - object  → recurse, so keys the patch does not mention survive and every `null` INSIDE it is
 *             applied as a deletion too;
 * - anything else → replace (arrays included: `offLimits` is a list, not a set of slots).
 *
 * The recursion happens whenever the PATCH side is an object, even when the existing side is
 * absent or a scalar — recursing into `{}` is what strips the nulls out of it. Assigning such a
 * patch object wholesale instead (the obvious shortcut) writes those nulls into the file: the
 * form always sends all three agent rows, so a config with no `agents` key would have gained
 * `"agents": { "ui-designer": null, … }` — which `AwConfig` then rejects as "expected object,
 * received null" on the NEXT save, leaving a file that can no longer be edited from the panel.
 *
 * The result is a new object; `existing` is never mutated (the caller still needs it to decide
 * whether anything actually changed).
 */
export function mergeConfig(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue; // key not mentioned — leave what is there
    if (value === null) {
      delete out[key];
      continue;
    }
    if (!isPlainObject(value)) {
      out[key] = value;
      continue;
    }
    const current = out[key];
    const merged = mergeConfig(isPlainObject(current) ? current : {}, value);
    // A subtree the patch emptied (every row cleared) is a key with nothing in it: drop it rather
    // than write `"agents": {}` into the developer's file.
    if (Object.keys(merged).length === 0 && !isPlainObject(current)) delete out[key];
    else out[key] = merged;
  }
  return out;
}

/**
 * Key names that must never reach `aw.config.json`. SPEC § Dashboard security invariants #5:
 * "Config writes must never persist a password or API key — only the env var NAME (`passEnv`)."
 *
 * Matched on the normalised key name (lower-cased, `-`/`_` removed) so `API_KEY`, `api-key` and
 * `apiKey` are one entry. `passEnv` normalises to `passenv`, which is deliberately NOT in the
 * list — the whole point is that the NAME of the variable is the safe thing to store.
 */
const SECRET_KEYS = new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "secret",
  "apikey",
  "apisecret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "credentials",
  "credential",
  "bearer",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

/** Every dotted path in `value` whose key name looks like a secret. `[]` is the happy case. */
export function findSecretKeys(value: unknown, prefix = ""): string[] {
  if (!isPlainObject(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEYS.has(normalizeKey(key))) found.push(dotted);
    found.push(...findSecretKeys(child, dotted));
  }
  return found;
}

/** Structural equality over JSON values — "would writing this change the file at all?". */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJson(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return false;
}

export interface FieldIssue {
  /** Dotted path into the config, e.g. `app.backend.port`. `""` for a whole-document issue. */
  path: string;
  message: string;
}

/** Turn a `AwConfig.safeParse` failure into dotted-path issues the form can place. */
export function toFieldIssues(issues: readonly { path: PropertyKey[]; message: string }[]): FieldIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join("."),
    message: issue.message,
  }));
}

/** `{ "a": 1 }` with two-space indentation and a trailing newline — the format `aw init` writes. */
export function serializeConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// rules AwConfig cannot express
// ---------------------------------------------------------------------------

function at(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Ports and viewport dimensions: a whole number in range, however it was typed. */
function portIssue(value: unknown, label: string, max: number): string | null {
  if (value === undefined) return null; // absent is AwConfig's problem to report, not this one
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (typeof value === "string" && value.trim() === "") return `${label} is required`;
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return `${label} must be a whole number between 1 and ${max}`;
  }
  return null;
}

/**
 * The checks `AwConfig` deliberately does not make, applied to the RAW merged object before it is
 * written (T21 acceptance 2: "shows a field error and writes nothing").
 *
 * `ModelChoice.model` is `z.string()`, which accepts `""` — the schema's job is the shape, and an
 * empty model only becomes wrong when something tries to RESOLVE it. That resolution lives in
 * `src/config.ts` (SPEC § Model resolution) and the panel cannot import it (node-only neighbours),
 * so the two rules that decide whether a config is *runnable* are mirrored here, with the CLI's
 * own wording for the one the CLI also prints:
 *
 *   model required: provider "<p>" selected without a model (use --model or agents.<name>.model)
 *
 * The rest are the same guards `aw init` applies to its flags: a port is a port, and `passEnv` is
 * the NAME of an environment variable, never a password (SPEC § Dashboard security invariants #5).
 *
 * Returned as dotted paths so the form places each one under its own field.
 */
export function configRuleIssues(config: unknown): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const push = (path: string, message: string) => issues.push({ path, message });

  const defaultsProvider = at(config, ["defaults", "provider"]);
  if (isBlank(at(config, ["defaults", "model"]))) {
    push("defaults.model", "a model id is required (the id shown in LM Studio, or the provider's model name)");
  }

  const agents = at(config, ["agents"]);
  if (isPlainObject(agents)) {
    for (const [name, entry] of Object.entries(agents)) {
      if (!isPlainObject(entry)) continue;
      const { provider, model } = entry;
      if (!isBlank(model)) continue;
      // The precedence rule of SPEC § Model resolution, at the only level the panel can set:
      // an agent whose provider differs from `defaults.provider` cannot inherit `defaults.model`,
      // because that model belongs to the other provider.
      if (!isBlank(provider) && provider !== defaultsProvider) {
        push(
          `agents.${name}.model`,
          `model required: provider "${String(provider)}" selected without a model ` +
            `(use --model or agents.${name}.model)`,
        );
      } else if (model !== undefined) {
        push(`agents.${name}.model`, "remove the override, or give it a model id");
      }
    }
  }

  for (const [path, label] of [
    ["app.backend.port", "the backend port"],
    ["app.frontend.port", "the frontend port"],
  ] as const) {
    const problem = portIssue(at(config, path.split(".")), label, 65535);
    if (problem !== null) push(path, problem);
  }

  for (const side of ["mobile", "desktop"] as const) {
    for (const axis of ["width", "height"] as const) {
      const problem = portIssue(at(config, ["viewports", side, axis]), `the ${side} ${axis}`, 20000);
      if (problem !== null) push(`viewports.${side}.${axis}`, problem);
    }
  }

  const account = at(config, ["app", "testAccount"]);
  if (isPlainObject(account)) {
    if (isBlank(account.user)) push("app.testAccount.user", "a user is required for a test account");
    const passEnv = account.passEnv;
    if (isBlank(passEnv)) {
      push("app.testAccount.passEnv", "name the environment variable holding the password");
    } else if (typeof passEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(passEnv)) {
      push(
        "app.testAccount.passEnv",
        "give the NAME of the environment variable holding the password (e.g. AW_TEST_PASSWORD), never the password itself",
      );
    }
  }

  return issues;
}

/** Rule issues first, then any schema issue for a path the rules did not already explain. */
export function mergeIssues(rules: FieldIssue[], schema: FieldIssue[]): FieldIssue[] {
  const seen = new Set(rules.map((i) => i.path));
  return [...rules, ...schema.filter((i) => !seen.has(i.path))];
}
