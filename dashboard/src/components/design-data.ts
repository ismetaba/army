/**
 * Pure helpers behind the Design tab (T20). No React, no `node:` imports, no fs.
 *
 * Three consumers share this module and that is why it exists:
 *   - `design-panel.tsx` (server) groups screens and reads the queue file off disk;
 *   - `design-gallery.tsx` / `design-feedback.tsx` (client) group the same screens for the
 *     compare view and re-validate the textarea before it posts;
 *   - `app/api/feedback/route.ts` validates the POST body and re-serialises the queue.
 *
 * The validation rules live HERE rather than in the route so the browser and the server apply the
 * identical rule — but the route calls them again on every request regardless. The client copy is
 * a courtesy (an error message before a round-trip); the server copy is the actual gate.
 *
 * `@shared/schemas` is imported with `import type` only: the types come from the single source of
 * truth (SPEC § Types) while zod stays out of the client bundle.
 */
import type { RunManifest, ScreenShot } from "@shared/schemas";
import { featureLabel, slugify } from "./report-data";

export type Viewport = ScreenShot["viewport"];

/** Both viewports, in display order — mobile first, matching `viewports` in SPEC § AwConfig. */
export const VIEWPORTS: readonly Viewport[] = ["mobile", "desktop"];

// ---------------------------------------------------------------------------
// screens
// ---------------------------------------------------------------------------

/**
 * One screenshot as the panel renders it: the manifest's `screen`/`viewport`, plus the
 * `/api/artifact` URL the store resolved for it.
 *
 * `href` is `null` when the manifest names a file the run directory does not actually contain —
 * a run that was killed between writing the manifest and flushing a PNG, or an artifact deleted
 * since. That case renders as a labelled gap, never as a broken `<img>`.
 *
 * The URL is built on the SERVER by `artifactHref` and passed down as a string. The client half
 * never sees a filesystem path and never assembles one: images and video load through
 * `/api/artifact` (T20 requirement), which is the only path-confined reader in the panel.
 */
export interface ScreenShotView {
  screen: string;
  viewport: Viewport;
  /** `/api/artifact?…` — never a filesystem path, never an absolute URL. */
  href: string | null;
  /** The manifest-relative path, shown when the file is missing so the gap is diagnosable. */
  path: string;
}

/** One screen's pair of captures. Either side may be absent — most runs shoot only some. */
export interface ScreenGroup {
  screen: string;
  mobile: ScreenShotView | null;
  desktop: ScreenShotView | null;
}

/**
 * Screens grouped into mobile/desktop pairs, in first-appearance order.
 *
 * Manifest order is kept rather than sorted alphabetically: it is the order the ui-designer
 * visited the screens in, which is the order the feature reads in. If a manifest lists the same
 * screen+viewport twice — a workflow bug, not something the schema forbids — the FIRST wins, so
 * the grid is a deterministic function of the file instead of showing one cell twice.
 */
export function groupScreens(shots: readonly ScreenShotView[]): ScreenGroup[] {
  const groups = new Map<string, ScreenGroup>();
  for (const shot of shots) {
    let group = groups.get(shot.screen);
    if (group === undefined) {
      group = { screen: shot.screen, mobile: null, desktop: null };
      groups.set(shot.screen, group);
    }
    if (group[shot.viewport] === null) group[shot.viewport] = shot;
  }
  return [...groups.values()];
}

/** Look one screen+viewport up in a grouped list — the compare view's cell lookup. */
export function pick(groups: readonly ScreenGroup[], screen: string, viewport: Viewport) {
  return groups.find((g) => g.screen === screen)?.[viewport] ?? null;
}

/**
 * The screen names to render when comparing two runs: this run's screens first, in its own order,
 * then any screen only the other run captured.
 *
 * The union, not the intersection. A screen that exists in only one of the two runs is the single
 * most interesting row in a comparison — it is a screen the feature just gained or just lost —
 * and an intersection would silently drop exactly that row.
 */
export function unionScreens(
  current: readonly ScreenGroup[],
  other: readonly ScreenGroup[],
): string[] {
  const names = current.map((g) => g.screen);
  for (const g of other) if (!names.includes(g.screen)) names.push(g.screen);
  return names;
}

/** The viewports worth a row for one screen: those either run captured. */
export function comparedViewports(
  current: readonly ScreenGroup[],
  other: readonly ScreenGroup[],
  screen: string,
): Viewport[] {
  return VIEWPORTS.filter(
    (v) => pick(current, screen, v) !== null || pick(other, screen, v) !== null,
  );
}

// ---------------------------------------------------------------------------
// feedback queue
// ---------------------------------------------------------------------------

/** One queued item, exactly as `<runDir>/feedback-queue.json` stores it (T20 step 3). */
export interface FeedbackEntry {
  text: string;
  /** ISO 8601, written by the server. */
  createdAt: string;
}

/**
 * Length cap for one queued item, in UTF-16 code units.
 *
 * This is user input landing on disk in a directory an agent later reads, so it is capped at the
 * gate rather than trusted to be sane. 2000 characters is several paragraphs of design feedback —
 * far more than the one or two sentences `--iterate` is built for — and small enough that a
 * pathological paste cannot grow the run directory meaningfully.
 */
export const FEEDBACK_MAX_CHARS = 2000;

/** Cap on queue length, so a stuck loop of POSTs cannot grow the file without bound. */
export const FEEDBACK_MAX_ITEMS = 50;

/** The queue file's name inside the run directory. Same string on the read and write sides. */
export const FEEDBACK_FILE = "feedback-queue.json";

/**
 * C0/C7F control characters other than tab and newline.
 *
 * Rejected, not stripped, and the reason is the copy button: queued text is interpolated into a
 * command a human pastes into a terminal. An ESC (0x1B) in that string is an ANSI escape sequence
 * that the terminal ACTS ON when the command echoes — it can rewrite the visible line so that
 * what is displayed is not what is executed. Quoting (`shellQuote`) makes the shell treat the
 * bytes as data; it does nothing about what the terminal renders. So they never enter the file.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The one gate for queued feedback text. Order matters: type first, then shape, then size.
 *
 * `typeof value === "string"` is the "must be a plain string" rule and it is deliberately the
 * FIRST check — `{ text: ["a"] }` and `{ text: { toString() {…} } }` both reach the route as
 * parsed JSON, and anything that stringified them before type-checking would write an attacker's
 * shape into the file.
 */
export function validateFeedbackText(value: unknown): Validated<string> {
  if (typeof value !== "string") return { ok: false, error: "text must be a string" };

  // CRLF from a textarea is normalised before measuring, so the cap counts characters a human
  // typed rather than line endings the browser added.
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text === "") return { ok: false, error: "feedback is empty" };
  if (CONTROL_CHARS.test(text)) return { ok: false, error: "feedback contains control characters" };
  if (text.length > FEEDBACK_MAX_CHARS) {
    return { ok: false, error: `feedback is longer than ${FEEDBACK_MAX_CHARS} characters` };
  }
  return { ok: true, value: text };
}

/**
 * Parse `feedback-queue.json`. `null` means "there is a file and it is not a queue".
 *
 * `null` is NOT the same as `[]` and the caller must keep them apart: an empty array is an empty
 * queue, while `null` is a file whose contents we do not understand. Overwriting the latter would
 * throw away whatever it holds, so both the panel and the route refuse to touch it and say so.
 *
 * Individual malformed ENTRIES inside a well-formed array are dropped rather than fatal — one bad
 * record must not hide the other nine.
 */
export function parseFeedbackQueue(raw: string): FeedbackEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: FeedbackEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const { text, createdAt } = item as Record<string, unknown>;
    if (typeof text !== "string" || typeof createdAt !== "string") continue;
    if (text === "" || text.length > FEEDBACK_MAX_CHARS) continue;
    out.push({ text, createdAt });
  }
  return out;
}

/**
 * The same file, parsed for a WRITE. `null` means "do not touch this file".
 *
 * `parseFeedbackQueue` above is the DISPLAY parser and it is lenient on purpose — one malformed
 * record must not hide the other nine on the page. Feeding its output back into a
 * read-modify-write is a different matter entirely: every entry it dropped is deleted from disk,
 * and every field it does not know about (`appliedAt`, an `author`, anything a future CLI-side
 * writer adds) is stripped from the entries it kept. Measured on a real queue: a hand-written note
 * with no `createdAt` vanished after a single append, and a sibling entry lost two fields.
 *
 * So the write path asks a stricter question — "can this file be re-serialised without losing
 * anything?" — and answers `null` when it cannot, which the route turns into the same 409 an
 * unparseable file gets. `store.ts`'s `readRegistryForWrite` states the identical rule for
 * `workspaces.json`: `[]` is a fine thing to render and a catastrophic thing to write back.
 */
export function strictFeedbackQueue(raw: string): FeedbackEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const out: FeedbackEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    // Exactly the two fields this panel owns. An extra key is not "extra data we can carry" —
    // re-serialising drops it, so the honest answer is to refuse the file.
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "createdAt" || keys[1] !== "text") return null;
    if (typeof entry.text !== "string" || typeof entry.createdAt !== "string") return null;
    if (entry.text === "" || entry.text.length > FEEDBACK_MAX_CHARS) return null;
    out.push({ text: entry.text, createdAt: entry.createdAt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the copyable command
// ---------------------------------------------------------------------------

/**
 * POSIX single-quote escaping.
 *
 * Everything between single quotes is literal to the shell — there is no escape character inside
 * them — so the only thing that needs handling is a single quote itself: close the string, emit a
 * backslash-quote, reopen (`'` → `'\''`). The result is safe for `$(…)`, backticks, `$VAR`, `;`,
 * `&&`, newlines and globs alike.
 *
 * Double quotes (which T20 step 3's sketch of the command uses) would NOT be safe here: the
 * feature text comes out of a manifest an agent wrote and the feedback text is typed by whoever
 * has the panel open, and inside double quotes both `$(rm -rf …)` and `` `…` `` still execute.
 * SPEC § Dashboard security invariants #3 — run content is never something a shell interprets.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The exact command that applies one queued item, matching the real CLI surface
 * (`src/commands/design-loop.ts`): `design-loop <feature> --iterate <feedback> --workspace <ws>`.
 *
 * `--video` is deliberately not re-emitted even for a run that used it: the flag records the
 * session, it is not part of the feature, and a copied command that silently starts recording is
 * a surprise. Everything is quoted, including the workspace name.
 */
export function iterateCommand(feature: string, text: string, workspace: string): string {
  return [
    "npx tsx src/cli.ts design-loop",
    shellQuote(feature),
    "--iterate",
    shellQuote(text),
    "--workspace",
    shellQuote(workspace),
  ].join(" ");
}

/**
 * Several queued items as ONE run.
 *
 * `--iterate` takes a single string (commander, one value), so the only honest way to apply four
 * queued notes in one pass is to join them into one piece of feedback. `; ` keeps the command on
 * one line; the numbering keeps them from reading as a single rambling sentence.
 */
export function combinedFeedback(entries: readonly FeedbackEntry[]): string {
  return entries.map((e, i) => `(${i + 1}) ${e.text}`).join("; ");
}

/**
 * The feature text a design-loop run was started with.
 *
 * `featureLabel` from the Report tab's helpers, called rather than re-derived. It was re-derived
 * here at first, minus its third branch — which meant a run recorded as `design-loop add-footer
 * --workspace fixture` (no quoted span, no `input.feature`) yielded "add-footer" under the Report
 * tab's rule and "" under this one: no compare candidates, and a `<feature>` placeholder in the
 * copyable command. The CLI surface is the same shape for all three kinds (`<command> "<text>"
 * [flags]`, SPEC § CLI commands), so there is one rule and one place to change it.
 */
export function designFeature(input: RunManifest["input"]): string {
  return featureLabel(input);
}

/**
 * The key two design-loop runs must share to count as runs of the same feature — the compare
 * dropdown's filter (T20 step 2).
 *
 * `slugify` is imported from the Report tab's helpers rather than re-implemented: it already
 * encodes the two rules that matter here (fold Unicode, including Turkish dotted/dotless i, and
 * collapse punctuation), and a second copy would drift. A run whose feature is unrecorded gets
 * the empty slug, which is compared with `!== ""` at the call site so that "no feature" never
 * groups every featureless run together.
 */
export function designSlug(input: RunManifest["input"]): string {
  return slugify(designFeature(input));
}
