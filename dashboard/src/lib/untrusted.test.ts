import { describe, expect, it } from "vitest";
import { commandText, hasControlChars, machineText } from "./untrusted";

/*
 * The two character classes that survive React's escaping, and what the panel does about them.
 * Every string here is the kind of thing a run manifest, a log line or `feedback-queue.json` can
 * legitimately contain — all three are written by agents, not by this panel. The characters are
 * spelled as `\u…` escapes on purpose: a raw U+202E in a source file reverses the source too.
 */

/** Right-to-left override, and the pop that ends it. */
const RLO = "\u202E";
const PDF = "\u202C";
const ESC = "\u001B";

describe("machineText", () => {
  it("removes the bidi override that makes a path display as a different path", () => {
    const planted = `src/${RLO}gj.suoicilam${PDF}/utils.js`;
    expect(machineText(planted)).toBe("src/gj.suoicilam/utils.js");
    expect(machineText(planted)).not.toContain(RLO);
  });

  it("removes isolates and directional marks too", () => {
    expect(machineText("a\u2066b\u2069c\u200Ed\u200Fe")).toBe("abcde");
  });

  it("removes ANSI escapes, so a log line cannot repaint the console", () => {
    expect(machineText(`done${ESC}[2Jgone`)).toBe("done[2Jgone");
    expect(machineText("bell\u0007")).toBe("bell");
  });

  it("leaves tabs, newlines and ordinary text exactly as they are", () => {
    const plain = "api/server.mjs:22\tconst TOKEN = 'sk_live_...'\nnext line - unicode: ok";
    expect(machineText(plain)).toBe(plain);
  });
});

describe("commandText", () => {
  it("strips the escapes that would be acted on when a copied command echoes", () => {
    const fix = `npm i safe-regex ${ESC}[31mRED${ESC}[0m${ESC}]0;pwned\u0007 && echo done`;
    expect(commandText(fix)).toBe("npm i safe-regex [31mRED[0m]0;pwned && echo done");
    expect(commandText(fix)).not.toContain(ESC);
  });
});

describe("hasControlChars", () => {
  it("is true for the escapes the feedback queue must never carry", () => {
    expect(hasControlChars(`make it blue ${ESC}[2J`)).toBe(true);
    expect(hasControlChars("a\u0000b")).toBe(true);
    // C1: U+009B is the single-byte CSI introducer, an ANSI control in its own right.
    expect(hasControlChars("a\u009Bb")).toBe(true);
  });

  it("is false for the whitespace a human actually types", () => {
    expect(hasControlChars("line one\nline two\tindented")).toBe(false);
  });
});
