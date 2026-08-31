import { describe, expect, it } from "vitest";
import {
  buildTriggerArgv,
  displayCommand,
  emptyArgs,
  fieldsFor,
  isTriggerKind,
  PROVIDERS,
  TRIGGER_KINDS,
} from "./trigger-args";

/**
 * The allowlist is the security boundary of `/api/trigger`, so these tests are written as claims
 * about what CANNOT happen rather than as a tour of the happy path: a value cannot become two
 * argv elements, a key nobody declared cannot become an argument at all, and a NUL byte cannot
 * reach `spawn`.
 */

describe("kinds", () => {
  it("accepts exactly the three workflows", () => {
    expect([...TRIGGER_KINDS]).toEqual(["review", "test-feature", "design-loop"]);
    expect(isTriggerKind("review")).toBe(true);
    expect(isTriggerKind("init")).toBe(false);
    expect(isTriggerKind("ping")).toBe(false);
    expect(isTriggerKind(null)).toBe(false);
    expect(isTriggerKind("__proto__")).toBe(false);
  });

  it("declares no field named config — a path must never come from a request", () => {
    for (const kind of TRIGGER_KINDS) {
      expect(fieldsFor(kind).map((f) => f.name)).not.toContain("config");
      expect(fieldsFor(kind).map((f) => f.flag)).not.toContain("config");
      // Nor a workspace: the runner appends `--workspace` from the registry itself.
      expect(fieldsFor(kind).map((f) => f.name)).not.toContain("workspace");
    }
  });

  it("gives every field a starting value, so the form's inputs stay controlled", () => {
    for (const kind of TRIGGER_KINDS) {
      const values = emptyArgs(kind);
      for (const field of fieldsFor(kind)) {
        expect(values[field.name]).toBe(field.kind === "flag" ? false : "");
      }
    }
  });
});

describe("review", () => {
  it("builds the documented command line", () => {
    const built = buildTriggerArgv("review", { base: "main", provider: "lmstudio", model: "qwen3" });
    expect(built).toEqual({
      ok: true,
      argv: ["review", "--base", "main", "--provider", "lmstudio", "--model", "qwen3"],
    });
  });

  it("omits every empty field rather than passing an empty argument", () => {
    const built = buildTriggerArgv("review", { base: "", target: "", provider: "", model: "  " });
    expect(built).toEqual({ ok: true, argv: ["review"] });
  });

  it("accepts a missing args object entirely", () => {
    expect(buildTriggerArgv("review", {})).toEqual({ ok: true, argv: ["review"] });
  });

  it("passes the target through as a fixed enum (T23)", () => {
    expect(buildTriggerArgv("review", { target: "frontend" })).toEqual({
      ok: true,
      argv: ["review", "--target", "frontend"],
    });
    expect(buildTriggerArgv("review", { target: "backend" })).toEqual({
      ok: true,
      argv: ["review", "--target", "backend"],
    });
  });

  it("refuses a target outside the enum — never an arbitrary string", () => {
    const built = buildTriggerArgv("review", { target: "prod; rm -rf ~" });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.field).toBe("target");
      expect(built.error.message).toContain("backend, frontend");
    }
    expect(buildTriggerArgv("review", { target: "Backend" }).ok).toBe(false);
  });

  it("no other kind accepts a target", () => {
    expect(buildTriggerArgv("design-loop", { feature: "x", target: "frontend" } as never).ok).toBe(false);
    expect(buildTriggerArgv("test-feature", { desc: "x", target: "backend" } as never).ok).toBe(false);
  });
});

describe("test-feature", () => {
  it("puts the description first, as the CLI's positional", () => {
    const built = buildTriggerArgv("test-feature", {
      desc: "the health endpoint returns 200",
      url: "http://localhost:3001",
      allowDestructive: true,
    });
    expect(built).toEqual({
      ok: true,
      argv: [
        "test-feature",
        "the health endpoint returns 200",
        "--url",
        "http://localhost:3001",
        "--allow-destructive",
      ],
    });
  });

  it("requires the description", () => {
    const built = buildTriggerArgv("test-feature", { desc: "   " });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.field).toBe("desc");
  });

  it("refuses a boolean flag that is not a boolean", () => {
    for (const value of ["true", 1, {}, null, []]) {
      const built = buildTriggerArgv("test-feature", { desc: "x", allowDestructive: value });
      expect(built.ok).toBe(false);
    }
  });

  it("refuses a URL that is not http(s)", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url", "//evil.test"]) {
      const built = buildTriggerArgv("test-feature", { desc: "x", url });
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.error.field).toBe("url");
    }
  });
});

describe("design-loop", () => {
  it("builds feature + iterate + video", () => {
    const built = buildTriggerArgv("design-loop", {
      feature: "a settings page",
      iterate: "center the footer",
      video: true,
    });
    expect(built).toEqual({
      ok: true,
      argv: ["design-loop", "a settings page", "--iterate", "center the footer", "--video"],
    });
  });
});

describe("the allowlist itself", () => {
  it("refuses a key no field declares, instead of dropping it", () => {
    const built = buildTriggerArgv("review", { base: "main", config: "/etc/passwd" });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.field).toBe("config");
      expect(built.error.message).toContain("is not an argument of review");
    }
  });

  it("refuses a field that belongs to a different kind", () => {
    expect(buildTriggerArgv("review", { feature: "x" }).ok).toBe(false);
    expect(buildTriggerArgv("design-loop", { base: "main" }).ok).toBe(false);
    expect(buildTriggerArgv("test-feature", { desc: "x", iterate: "y" }).ok).toBe(false);
  });

  it("refuses a non-object args", () => {
    for (const args of [null, [], "base=main", 42]) {
      expect(buildTriggerArgv("review", args as never).ok).toBe(false);
    }
  });

  it("refuses a non-string where a string is expected", () => {
    for (const base of [1, true, {}, ["main"], null]) {
      const built = buildTriggerArgv("review", { base });
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.error.field).toBe("base");
    }
  });

  it("only accepts the four provider ids", () => {
    for (const provider of PROVIDERS) {
      expect(buildTriggerArgv("review", { provider, model: "m" }).ok).toBe(true);
    }
    expect(buildTriggerArgv("review", { provider: "openai; id" }).ok).toBe(false);
    expect(buildTriggerArgv("review", { provider: "LMSTUDIO" }).ok).toBe(false);
  });
});

describe("hostile values stay one argument", () => {
  const HOSTILE = '; rm -rf ~ && $(id) `whoami` | tee /tmp/x #\nsecond line\t& echo done';

  it("passes a shell-metacharacter salad through as a single element", () => {
    const built = buildTriggerArgv("test-feature", { desc: HOSTILE });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.argv).toHaveLength(2);
    expect(built.argv[0]).toBe("test-feature");
    expect(built.argv[1]).toBe(HOSTILE);
  });

  it("does the same for a flag VALUE, which is a separate element from its flag", () => {
    const built = buildTriggerArgv("design-loop", { feature: "f", iterate: HOSTILE });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.argv).toEqual(["design-loop", "f", "--iterate", HOSTILE]);
  });

  it("keeps a value that LOOKS like a flag as a value", () => {
    const built = buildTriggerArgv("review", { base: "--allow-destructive" });
    expect(built).toEqual({ ok: true, argv: ["review", "--base", "--allow-destructive"] });
  });

  it("refuses a NUL byte by name — it cannot survive execve", () => {
    const built = buildTriggerArgv("test-feature", { desc: "before\u0000after" });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.field).toBe("desc");
      expect(built.error.message).toContain("NUL byte");
    }
  });

  it("refuses ESC and other control characters, which a terminal would act on", () => {
    for (const desc of ["a\u001B[2Kb", "a\u0007b", "a\u007Fb"]) {
      expect(buildTriggerArgv("test-feature", { desc }).ok).toBe(false);
    }
    // …but keeps the two a textarea legitimately produces.
    const built = buildTriggerArgv("test-feature", { desc: "line one\nline\ttwo" });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.argv[1]).toBe("line one\nline\ttwo");
  });

  it("normalises CRLF instead of rejecting it — a browser textarea sends it", () => {
    const built = buildTriggerArgv("test-feature", { desc: "a\r\nb\rc" });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.argv[1]).toBe("a\nb\nc");
  });

  it("refuses a line break in a field that is one line by nature", () => {
    expect(buildTriggerArgv("review", { base: "main\n--provider" }).ok).toBe(false);
    expect(buildTriggerArgv("review", { model: "a\tb" }).ok).toBe(false);
  });

  it("caps length", () => {
    expect(buildTriggerArgv("test-feature", { desc: "x".repeat(4000) }).ok).toBe(true);
    expect(buildTriggerArgv("test-feature", { desc: "x".repeat(4001) }).ok).toBe(false);
    expect(buildTriggerArgv("review", { base: "x".repeat(301) }).ok).toBe(false);
  });
});

describe("displayCommand", () => {
  it("single-quotes anything a shell would otherwise interpret", () => {
    const line = displayCommand(["test-feature", "; rm -rf ~", "--workspace", "fixture"]);
    expect(line).toBe("npx tsx src/cli.ts test-feature '; rm -rf ~' --workspace fixture");
  });

  it("escapes an embedded single quote so the whole argument stays one word", () => {
    expect(displayCommand(["design-loop", "it's fine"])).toBe(
      "npx tsx src/cli.ts design-loop 'it'\\''s fine'",
    );
  });

  it("leaves an ordinary argument unquoted", () => {
    expect(displayCommand(["review", "--base", "main"])).toBe("npx tsx src/cli.ts review --base main");
  });
});
