/**
 * T22 — what the panel is allowed to put on a CLI command line, and how.
 *
 * SPEC § Dashboard security invariants #4: *"Mutating routes take an argv array, never a shell
 * string, and accept only a per-kind allowlist of arguments."* This module is that allowlist. It
 * is pure — no `node:` imports, no fs, no `child_process` — so it is shared, unchanged, by three
 * places that must not be able to disagree:
 *
 *   - `dashboard/src/lib/runner.ts` (server) builds the argv it hands to `spawn`;
 *   - `dashboard/src/app/api/trigger/route.ts` validates the POST body;
 *   - `dashboard/src/components/new-run-modal.tsx` (client) renders one field per spec entry and
 *     re-checks it before posting, so a typo is an error message instead of a round trip.
 *
 * Two properties are the whole point, and both come from `FIELDS` being the only thing the
 * builder ever iterates:
 *
 * 1. **Nothing a caller sends can become an argv element unless a field spec names it.** The
 *    builder walks the SPEC and looks each field up in the request; it never walks the request.
 *    An unknown key cannot be forwarded even by accident — and it is reported rather than
 *    ignored, because a silently dropped `--allow-destructive` is worse than an error.
 * 2. **A value can only ever be ONE argv element.** Values are never split, never joined, never
 *    interpolated into a string, and the result is a `string[]` that goes straight to
 *    `spawn(cmd, argv)` with `shell: false`. `; rm -rf ~`, `$(id)`, backticks and newlines are
 *    therefore data: `execve` copies the bytes into `process.argv` and no shell ever sees them.
 *
 * The one character that cannot survive that trip is NUL: `execve` arguments are NUL-terminated
 * C strings, so a NUL byte would truncate the argument rather than be passed along (Node throws
 * outright). It is refused here, at the gate, with its own message.
 *
 * `--config` is deliberately NOT in any allowlist. It names a FILESYSTEM PATH, and a path chosen
 * by a browser request is exactly what SPEC § Dashboard security invariants #2 exists to prevent;
 * the workspace already resolves the config through `workspaces.json`, which the runner appends
 * as `--workspace <ws>` from a validated registry entry rather than from the request body.
 */
import type { RunManifest } from "@shared/schemas";
import { shellQuote } from "@/components/design-data";

/**
 * The three workflows the panel can start.
 *
 * `satisfies` ties the list to SPEC § Types: renaming a kind in `shared/schemas.ts` fails this
 * file to compile. It is written out rather than taken from the zod enum's `.options` so that the
 * client bundle does not pull zod in for a three-element list.
 */
export const TRIGGER_KINDS = ["review", "test-feature", "design-loop"] as const satisfies
  readonly RunManifest["kind"][];

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export function isTriggerKind(value: unknown): value is TriggerKind {
  return typeof value === "string" && (TRIGGER_KINDS as readonly string[]).includes(value);
}

/**
 * The four `RunManifest.status` values, tied to the schema the same way.
 *
 * Lives here rather than in `store.ts` because the consumer is a CLIENT component (`live-log.tsx`
 * narrows a status out of an SSE frame), and `store.ts` imports `node:fs`. It was a hand-copied
 * literal list in that component, which is exactly the pattern `store.ts` and this file document
 * as forbidden: a fifth status added to `shared/schemas.ts` would type-check happily there and be
 * rendered as a green `done` badge. Now it fails the build.
 */
export const RUN_STATUSES = ["running", "done", "error", "cancelled"] as const satisfies
  readonly RunManifest["status"][];

export function isRunStatus(value: unknown): value is RunManifest["status"] {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

/** SPEC § Types — `ProviderId`. Same reason as above for not importing the zod enum. */
export const PROVIDERS = ["lmstudio", "openai", "anthropic", "claude-cli"] as const satisfies
  readonly RunManifest["provider"][];

/**
 * `claude-cli` is offered in the select but flagged: the workflows refuse it (SPEC § Agent session
 * loop — it does not execute AI SDK tools). Showing it with the reason is more useful than hiding
 * it and letting someone wonder why the panel disagrees with `aw.config.json`.
 */
export const REFUSED_PROVIDER = "claude-cli";

export type FieldKind =
  /** One line of free text: no line breaks, no control characters. */
  | "line"
  /** Multi-line free text — the feature description. Tabs and newlines are allowed. */
  | "text"
  /** One line, additionally required to parse as an http(s) URL. */
  | "url"
  /** One of `PROVIDERS`, or empty for "whatever the config resolves to". */
  | "provider"
  /** A boolean switch: present in argv as a bare `--flag`, absent otherwise. */
  | "flag";

export interface FieldSpec {
  /** The key in the request's `args` object. */
  name: string;
  kind: FieldKind;
  label: string;
  /** The CLI long option, without `--`. Omitted for a positional argument. */
  flag?: string;
  /** True for the workflow's `<desc>` / `<feature>` positional. */
  positional?: boolean;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  help?: string;
}

const PROVIDER_FIELDS: FieldSpec[] = [
  {
    name: "provider",
    kind: "provider",
    label: "Provider",
    flag: "provider",
    help: "Overrides aw.config.json for this run only.",
  },
  {
    name: "model",
    kind: "line",
    label: "Model",
    flag: "model",
    maxLength: 200,
    placeholder: "qwen3-coder-30b-a3b-instruct",
    help: "Required when the provider differs from the config default.",
  },
];

/**
 * The allowlist, per kind, in the order the modal renders it.
 *
 * Every entry mirrors an option `src/commands/*.ts` actually registers with commander — the CLI
 * surface in SPEC § CLI commands. A flag the CLI does not have would be rejected by commander at
 * the far end, which is a confusing way to find out about a typo here.
 */
export const FIELDS: Record<TriggerKind, readonly FieldSpec[]> = {
  review: [
    {
      name: "base",
      kind: "line",
      label: "Base ref",
      flag: "base",
      maxLength: 300,
      placeholder: "main",
      help: "The diff reviewed is <base>...HEAD. Defaults to main.",
    },
    ...PROVIDER_FIELDS,
  ],
  "test-feature": [
    {
      name: "desc",
      kind: "text",
      label: "What to verify",
      positional: true,
      required: true,
      maxLength: 4000,
      placeholder: "the health endpoint returns 200 with build info",
    },
    {
      name: "url",
      kind: "url",
      label: "Target URL",
      flag: "url",
      maxLength: 2000,
      placeholder: "http://localhost:3001",
      help: "Defaults to app.baseUrl in aw.config.json.",
    },
    {
      name: "allowDestructive",
      kind: "flag",
      label: "Allow destructive requests",
      flag: "allow-destructive",
      help: "Permits POST/PUT/PATCH/DELETE against a non-local target.",
    },
    ...PROVIDER_FIELDS,
  ],
  "design-loop": [
    {
      name: "feature",
      kind: "text",
      label: "Feature",
      positional: true,
      required: true,
      maxLength: 4000,
      placeholder: "a settings page with a dark-mode toggle",
      help: "A description, or a path to a spec file in the target repo.",
    },
    {
      name: "iterate",
      kind: "text",
      label: "Iterate on feedback",
      flag: "iterate",
      maxLength: 4000,
      placeholder: "center the footer text and make it muted grey",
      help: "Applies feedback to the existing implementation instead of starting fresh.",
    },
    {
      name: "video",
      kind: "flag",
      label: "Record the browser session",
      flag: "video",
      help: "Writes screenshots/<slug>/video.webm. Slower, and much larger.",
    },
    ...PROVIDER_FIELDS,
  ],
};

export function fieldsFor(kind: TriggerKind): readonly FieldSpec[] {
  return FIELDS[kind];
}

/** The default `args` object for a kind — every field present, so React inputs stay controlled. */
export function emptyArgs(kind: TriggerKind): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const field of fieldsFor(kind)) out[field.name] = field.kind === "flag" ? false : "";
  return out;
}

export type TriggerArgs = Record<string, unknown>;

export interface ArgsError {
  message: string;
  /** Which field the message belongs next to; `null` for a whole-object problem. */
  field: string | null;
}

/** Anything that can go wrong here is a client error with a field to hang it on. */
export type Rejected = { ok: false; error: ArgsError };

export type Built = { ok: true; argv: string[] } | Rejected;

const fail = (message: string, field: string | null = null): Rejected => ({
  ok: false,
  error: { message, field },
});

/**
 * C0 controls and DEL, minus tab and newline.
 *
 * Same rule (and the same reason) as T20's queued feedback: these strings are echoed into a run
 * log, rendered in the panel, and shown as a copyable command. An ESC is an ANSI sequence a
 * terminal ACTS on when the line is echoed, which quoting does not address. Carriage returns are
 * normalised away first rather than rejected — a browser textarea produces them.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
/** The same set plus tab/newline: for fields that are one line by nature (a ref, a URL, a model). */
const CONTROL_CHARS_OR_BREAK = /[\u0000-\u001F\u007F]/;

type Cleaned = { ok: true; value: string } | Rejected;

/** Validate one string field. Returns the cleaned value, or the error to show beside it. */
function cleanString(field: FieldSpec, raw: unknown): Cleaned {
  if (typeof raw !== "string") return fail(`${field.label} must be a string`, field.name);

  // NUL first and by name: it is the one byte that cannot reach `execve` at all, and "must be a
  // string without null bytes" thrown from deep inside `child_process` is not an error anyone
  // should have to decode.
  if (raw.includes("\0")) {
    return fail(`${field.label} contains a NUL byte, which cannot be passed to a process`, field.name);
  }

  const value = raw.replace(/\r\n?/g, "\n").trim();
  if (value === "") {
    return field.required === true
      ? fail(`${field.label} is required`, field.name)
      : { ok: true, value: "" };
  }

  const pattern = field.kind === "text" ? CONTROL_CHARS : CONTROL_CHARS_OR_BREAK;
  if (pattern.test(value)) {
    return fail(
      field.kind === "text"
        ? `${field.label} contains control characters`
        : `${field.label} must be a single line without control characters`,
      field.name,
    );
  }

  const max = field.maxLength ?? 1000;
  if (value.length > max) {
    return fail(`${field.label} is longer than ${max} characters`, field.name);
  }

  if (field.kind === "provider" && !(PROVIDERS as readonly string[]).includes(value)) {
    return fail(`${field.label} must be one of ${PROVIDERS.join(", ")}`, field.name);
  }

  if (field.kind === "url") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return fail(`${field.label} is not a URL`, field.name);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fail(`${field.label} must be an http:// or https:// URL`, field.name);
    }
  }

  return { ok: true, value };
}

/**
 * Build the argv TAIL for one workflow: `[<kind>, …positionals, …flags]`.
 *
 * The caller prepends the interpreter and `src/cli.ts` and appends `--workspace <ws>` from the
 * registry, so nothing in this function's output can name a path or a workspace.
 *
 * Read the loop, not the prose: it iterates `fieldsFor(kind)`. `args` is only ever *looked up*,
 * never enumerated into argv, which is what makes "only a per-kind allowlist of arguments" a
 * property of the code rather than a promise about it.
 */
export function buildTriggerArgv(kind: TriggerKind, args: TriggerArgs): Built {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return fail("args must be a JSON object");
  }

  const specs = fieldsFor(kind);
  const known = new Set(specs.map((f) => f.name));
  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      return fail(`"${key}" is not an argument of ${kind}`, key);
    }
  }

  const positionals: string[] = [];
  const flags: string[] = [];

  for (const field of specs) {
    const raw = args[field.name];

    if (field.kind === "flag") {
      if (raw === undefined || raw === false) continue;
      if (raw !== true) return fail(`${field.label} must be true or false`, field.name);
      flags.push(`--${field.flag}`);
      continue;
    }

    if (raw === undefined) {
      if (field.required === true) return fail(`${field.label} is required`, field.name);
      continue;
    }

    const cleaned = cleanString(field, raw);
    if (!cleaned.ok) return cleaned;
    if (cleaned.value === "") continue;

    if (field.positional === true) positionals.push(cleaned.value);
    else flags.push(`--${field.flag}`, cleaned.value);
  }

  return { ok: true, argv: [kind, ...positionals, ...flags] };
}

/**
 * The command line the panel SHOWS for a run — for the live view's header and the run log.
 *
 * Display only. Nothing is ever executed from this string: it is built from the argv array that
 * was already validated, and every element is single-quoted with T20's `shellQuote` (`'` →
 * `'\''`), so pasting it into a terminal runs the same command rather than a different one.
 */
export function displayCommand(argv: readonly string[]): string {
  return ["npx tsx src/cli.ts", ...argv.map((a) => (SAFE_BARE.test(a) ? a : shellQuote(a)))].join(" ");
}

/** Characters that need no quoting at all — keeps the common command readable. */
const SAFE_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;
