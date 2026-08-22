/**
 * Display-layer scrubbing for strings the panel did not write.
 *
 * SPEC § Dashboard security invariants #3: every string out of a run manifest, log, diff, config
 * or feedback queue is attacker-authored. React already escapes markup, so nothing here is about
 * XSS — it is about the two classes of character that survive escaping and still change what a
 * reader sees or what their terminal does.
 *
 * Node-free on purpose (no `node:` imports), so both server and client components can use it.
 */

/**
 * Bidirectional formatting characters: the explicit overrides/embeddings (U+202A–U+202E), the
 * isolates (U+2066–U+2069), the marks (U+200E/U+200F) and the Arabic letter mark (U+061C).
 *
 * A path with U+202E before `gj.suoicilam` and U+202C after it renders as
 * `src/malicious.jg/utils.js`. A reviewer names one file
 * and the panel displays another — and reporting which file a finding is about is the panel's
 * entire job, so a path that lies is a defect even though nothing executes.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/**
 * C0 and C7F control characters other than tab and newline, plus the C1 range.
 *
 * The reason is the copy button, and `design-data.ts`'s `validateFeedbackText` states it for the
 * text a human types: a copied string is pasted into a terminal, and an ESC (0x1B) in it is an
 * ANSI sequence the terminal ACTS ON — it can rewrite the visible line so what is displayed is not
 * what runs. `shellQuote` makes the shell treat the bytes as data; it does nothing about what the
 * terminal renders.
 */
export const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

const CONTROL_CHARS_G = new RegExp(CONTROL_CHARS.source, "g");

/**
 * An identifier a machine wrote and a human is expected to act on — a path, a run or case id, a
 * screen name, a model id. Bidi controls and stray control characters are removed; everything else
 * is left exactly as it was, because a path that has been "cleaned up" is also a path that lies.
 */
export function machineText(value: string): string {
  return value.replace(BIDI_CONTROLS, "").replace(CONTROL_CHARS_G, "");
}

/**
 * A string that is about to become part of a command someone pastes into a terminal.
 *
 * Same rule as `machineText`, named separately because the two are allowed to diverge: evidence
 * blocks (a captured request or response body) are deliberately byte-exact and must NOT go through
 * either of these — being able to see the bytes that came back is the point of that block.
 */
export function commandText(value: string): string {
  return machineText(value);
}

/** Does this string carry a control character the queue must never hand to a terminal? */
export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}
