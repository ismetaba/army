import { describe, expect, it } from "vitest";
import {
  combinedFeedback,
  comparedViewports,
  designFeature,
  designSlug,
  FEEDBACK_MAX_CHARS,
  groupScreens,
  iterateCommand,
  parseFeedbackQueue,
  strictFeedbackQueue,
  pick,
  shellQuote,
  unionScreens,
  validateFeedbackText,
  type ScreenShotView,
} from "./design-data";

const shot = (screen: string, viewport: "mobile" | "desktop", href: string | null = "/api/artifact?x"): ScreenShotView => ({
  screen,
  viewport,
  href,
  path: `artifacts/screenshots/${screen}-${viewport}.png`,
});

describe("groupScreens", () => {
  it("pairs the two viewports of one screen", () => {
    const groups = groupScreens([shot("home", "mobile"), shot("home", "desktop")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].screen).toBe("home");
    expect(groups[0].mobile?.viewport).toBe("mobile");
    expect(groups[0].desktop?.viewport).toBe("desktop");
  });

  it("keeps manifest order and leaves an uncaptured viewport null", () => {
    // The real fixture run design-loop-20260822-004725 is exactly this shape: about has only a
    // mobile capture, home has both.
    const groups = groupScreens([shot("about", "mobile"), shot("home", "desktop"), shot("home", "mobile")]);
    expect(groups.map((g) => g.screen)).toEqual(["about", "home"]);
    expect(groups[0].desktop).toBeNull();
    expect(groups[1].mobile).not.toBeNull();
  });

  it("keeps the first of a duplicated screen+viewport", () => {
    const first = shot("home", "mobile", "/api/artifact?first");
    const second = shot("home", "mobile", "/api/artifact?second");
    expect(groupScreens([first, second])[0].mobile?.href).toBe("/api/artifact?first");
  });

  it("carries a missing file through as href null", () => {
    expect(groupScreens([shot("home", "mobile", null)])[0].mobile?.href).toBeNull();
  });
});

describe("compare helpers", () => {
  const current = groupScreens([shot("home", "mobile"), shot("home", "desktop")]);
  const other = groupScreens([shot("home", "mobile"), shot("about", "desktop")]);

  it("unions screens with the current run's order first", () => {
    expect(unionScreens(current, other)).toEqual(["home", "about"]);
  });

  it("offers a viewport row when EITHER run captured it", () => {
    expect(comparedViewports(current, other, "home")).toEqual(["mobile", "desktop"]);
    expect(comparedViewports(current, other, "about")).toEqual(["desktop"]);
  });

  it("picks null for a cell neither side has", () => {
    expect(pick(current, "about", "mobile")).toBeNull();
    expect(pick(current, "home", "desktop")).not.toBeNull();
  });
});

describe("shellQuote", () => {
  it("wraps in single quotes", () => {
    expect(shellQuote("center the footer")).toBe("'center the footer'");
  });

  it("neutralises command substitution, variables and separators", () => {
    expect(shellQuote("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
    expect(shellQuote("`id`")).toBe("'`id`'");
    expect(shellQuote("a; rm -rf /")).toBe("'a; rm -rf /'");
    expect(shellQuote("$HOME && curl evil")).toBe("'$HOME && curl evil'");
  });

  it("closes and reopens around an embedded single quote", () => {
    // `'; rm -rf ~; echo '` must not be able to end the quoted argument.
    expect(shellQuote("'; rm -rf ~; echo '")).toBe(`''\\''; rm -rf ~; echo '\\'''`);
  });

  it("quotes the empty string as an empty argument", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("iterateCommand", () => {
  it("matches the CLI surface in src/commands/design-loop.ts", () => {
    expect(iterateCommand("add a footer", "center it", "fixture")).toBe(
      "npx tsx src/cli.ts design-loop 'add a footer' --iterate 'center it' --workspace 'fixture'",
    );
  });

  it("keeps hostile feedback as one argument", () => {
    const command = iterateCommand("f", "'; rm -rf ~; echo '", "fixture");
    expect(command).toContain(`--iterate ''\\''; rm -rf ~; echo '\\''' --workspace`);
    // Nothing outside the quoted spans can start a second command.
    expect(command.replace(/'(?:[^']|'\\'')*'/g, "''")).toBe(
      "npx tsx src/cli.ts design-loop '' --iterate '' --workspace ''",
    );
  });

  it("numbers several queued items into one --iterate string", () => {
    const combined = combinedFeedback([
      { text: "one", createdAt: "2026-08-22T00:00:00.000Z" },
      { text: "two", createdAt: "2026-08-22T00:00:01.000Z" },
    ]);
    expect(combined).toBe("(1) one; (2) two");
  });
});

describe("validateFeedbackText", () => {
  it("accepts a normal note and trims it", () => {
    expect(validateFeedbackText("  center the footer  ")).toEqual({
      ok: true,
      value: "center the footer",
    });
  });

  it("rejects anything that is not a plain string", () => {
    for (const value of [undefined, null, 42, true, ["a"], { text: "a" }, { toString: () => "a" }]) {
      expect(validateFeedbackText(value)).toEqual({ ok: false, error: "text must be a string" });
    }
  });

  it("rejects an empty or whitespace-only note", () => {
    expect(validateFeedbackText("   \n ").ok).toBe(false);
  });

  it("caps the length", () => {
    expect(validateFeedbackText("x".repeat(FEEDBACK_MAX_CHARS)).ok).toBe(true);
    const long = validateFeedbackText("x".repeat(FEEDBACK_MAX_CHARS + 1));
    expect(long).toEqual({ ok: false, error: `feedback is longer than ${FEEDBACK_MAX_CHARS} characters` });
  });

  it("rejects control characters but keeps tabs and newlines", () => {
    expect(validateFeedbackText("a\u001b[2Kmalicious").ok).toBe(false);
    expect(validateFeedbackText("a\u0000b").ok).toBe(false);
    expect(validateFeedbackText("line one\nline\ttwo")).toEqual({
      ok: true,
      value: "line one\nline\ttwo",
    });
  });

  it("normalises CRLF from a textarea", () => {
    expect(validateFeedbackText("a\r\nb")).toEqual({ ok: true, value: "a\nb" });
  });
});

describe("parseFeedbackQueue", () => {
  it("reads a well-formed queue", () => {
    expect(parseFeedbackQueue('[{"text":"a","createdAt":"2026-08-22T00:00:00.000Z"}]')).toEqual([
      { text: "a", createdAt: "2026-08-22T00:00:00.000Z" },
    ]);
  });

  it("returns null for anything that is not an array of entries", () => {
    expect(parseFeedbackQueue("")).toBeNull();
    expect(parseFeedbackQueue("not json")).toBeNull();
    expect(parseFeedbackQueue('{"text":"a"}')).toBeNull();
    expect(parseFeedbackQueue('[{"text":"a","createdAt":"x"}')).toBeNull(); // truncated write
  });

  it("drops malformed entries without losing the good ones", () => {
    const raw = JSON.stringify([
      { text: "keep", createdAt: "2026-08-22T00:00:00.000Z" },
      { text: 42, createdAt: "2026-08-22T00:00:00.000Z" },
      { text: "no timestamp" },
      null,
      { text: "x".repeat(FEEDBACK_MAX_CHARS + 1), createdAt: "2026-08-22T00:00:00.000Z" },
    ]);
    expect(parseFeedbackQueue(raw)).toEqual([{ text: "keep", createdAt: "2026-08-22T00:00:00.000Z" }]);
  });

  it("tells an empty queue apart from an unreadable one", () => {
    expect(parseFeedbackQueue("[]")).toEqual([]);
    expect(parseFeedbackQueue("{}")).toBeNull();
  });
});

describe("strictFeedbackQueue — the WRITE-path parser", () => {
  it("agrees with the display parser on a queue it can represent exactly", () => {
    const raw = '[{"text":"a","createdAt":"2026-08-22T00:00:00.000Z"}]';
    expect(strictFeedbackQueue(raw)).toEqual(parseFeedbackQueue(raw));
    expect(strictFeedbackQueue("[]")).toEqual([]);
  });

  it("refuses the whole file rather than silently dropping an entry", () => {
    // The display parser keeps "keep" and drops the rest; writing that back would delete the
    // hand-written note from disk for good.
    const raw = JSON.stringify([
      { text: "keep", createdAt: "2026-08-22T00:00:00.000Z" },
      { text: "no timestamp, hand written" },
    ]);
    expect(parseFeedbackQueue(raw)).toHaveLength(1);
    expect(strictFeedbackQueue(raw)).toBeNull();
  });

  it("refuses a file whose entries carry fields this panel would strip", () => {
    const raw = JSON.stringify([
      { text: "a", createdAt: "2026-08-22T00:00:00.000Z", appliedAt: "2026-08-22T01:00:00.000Z" },
    ]);
    expect(strictFeedbackQueue(raw)).toBeNull();
  });

  it("refuses an over-long entry rather than deleting it", () => {
    const raw = JSON.stringify([
      { text: "x".repeat(FEEDBACK_MAX_CHARS + 1), createdAt: "2026-08-22T00:00:00.000Z" },
    ]);
    expect(strictFeedbackQueue(raw)).toBeNull();
  });

  it("refuses everything the display parser refuses", () => {
    for (const raw of ["", "not json", '{"text":"a"}', "[[]]", "[null]"]) {
      expect(strictFeedbackQueue(raw)).toBeNull();
    }
  });
});

describe("designFeature / designSlug", () => {
  it("prefers the recorded feature", () => {
    expect(designFeature({ args: 'design-loop "x"', feature: "add a footer" })).toBe("add a footer");
  });

  it("falls back to the first quoted span of the args line", () => {
    expect(
      designFeature({
        args: 'design-loop "add a footer with the app version on every page" --workspace fixture',
      }),
    ).toBe("add a footer with the app version on every page");
  });

  it("groups the two real fixture runs of the same feature", () => {
    const a = designSlug({
      args: 'design-loop "add a footer with the app version on every page" --workspace fixture',
      feature: "add a footer with the app version on every page",
    });
    const b = designSlug({
      args: 'design-loop "add a footer with the app version on every page" --iterate "center the footer text and make it muted grey" --workspace fixture',
      feature: "add a footer with the app version on every page",
    });
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });

  it("keeps a different feature in a different bucket", () => {
    expect(designSlug({ args: "", feature: "add a Contact page with an email link" })).not.toBe(
      designSlug({ args: "", feature: "add a footer with the app version on every page" }),
    );
  });

  it("gives an unrecorded feature the empty slug, which the panel treats as 'matches nothing'", () => {
    expect(designSlug({ args: "design-loop --workspace fixture" })).toBe("");
  });
});
