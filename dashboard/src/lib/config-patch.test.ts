import { describe, expect, it } from "vitest";
import {
  ConfigPatch,
  ConfigPutBody,
  configRuleIssues,
  findSecretKeys,
  mergeConfig,
  mergeIssues,
  prototypeKeys,
  sameJson,
  serializeConfig,
} from "./config-patch";

/** A config in the shape `aw init` writes, used as the "file on disk" in the merge tests. */
const base = {
  workspace: "fixture",
  repoRoot: "/tmp/fixture",
  defaults: { provider: "lmstudio", model: "qwen3" },
  app: {
    backend: { start: "npm run dev:api", port: 3001, healthPath: "/health" },
    frontend: { start: "npm run dev", port: 5173 },
    baseUrl: "http://localhost:3001",
  },
  viewports: { mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } },
} as const;

describe("mergeConfig", () => {
  it("keeps keys the patch does not mention, including ones the schema never heard of", () => {
    const existing = { ...base, notes: "hand written", app: { ...base.app, env: { CI: "1" } } };
    const merged = mergeConfig(existing, { defaults: { model: "new-model" } });
    expect(merged.notes).toBe("hand written");
    expect(merged.workspace).toBe("fixture");
    expect(merged.repoRoot).toBe("/tmp/fixture");
    expect((merged.app as Record<string, unknown>).env).toEqual({ CI: "1" });
    // and the mentioned key is replaced, with its sibling intact
    expect(merged.defaults).toEqual({ provider: "lmstudio", model: "new-model" });
  });

  it("deletes a key when the patch sends null, at any depth", () => {
    const merged = mergeConfig(base, { app: { frontend: null }, viewports: null });
    expect((merged.app as Record<string, unknown>).frontend).toBeUndefined();
    expect(Object.hasOwn(merged.app as object, "frontend")).toBe(false);
    expect(merged.viewports).toBeUndefined();
    expect((merged.app as Record<string, unknown>).backend).toEqual(base.app.backend);
  });

  it("replaces arrays wholesale and never mutates the input", () => {
    const existing = { ...base, offLimits: ["a", "b"] };
    const merged = mergeConfig(existing, { offLimits: ["c"] });
    expect(merged.offLimits).toEqual(["c"]);
    expect(existing.offLimits).toEqual(["a", "b"]);
  });

  it("adds a nested object that did not exist", () => {
    const merged = mergeConfig(base, { agents: { "code-reviewer": { provider: "anthropic", model: "claude-sonnet-5" } } });
    expect(merged.agents).toEqual({ "code-reviewer": { provider: "anthropic", model: "claude-sonnet-5" } });
  });

  it("strips nulls out of a subtree whose key does not exist yet", () => {
    // The form always sends all three agent rows; the two without an override are null. Writing
    // those nulls into a config that has no `agents` key at all produces a file AwConfig rejects.
    const merged = mergeConfig(base, {
      agents: {
        "code-reviewer": { provider: "anthropic", model: "claude-sonnet-5" },
        "ui-designer": null,
        "qa-tester": null,
      },
    });
    expect(merged.agents).toEqual({ "code-reviewer": { provider: "anthropic", model: "claude-sonnet-5" } });
    expect(JSON.stringify(merged)).not.toContain("null");
  });

  it("drops a subtree the patch emptied instead of writing {}", () => {
    const merged = mergeConfig(base, { agents: { "ui-designer": null, "qa-tester": null, "code-reviewer": null } });
    expect(Object.hasOwn(merged, "agents")).toBe(false);
  });

  it("keeps an existing subtree that the patch emptied, so a deletion is visible", () => {
    const existing = { ...base, agents: { "code-reviewer": { model: "x" } } };
    const merged = mergeConfig(existing, { agents: { "code-reviewer": null } });
    expect(merged.agents).toEqual({});
  });
});

describe("sameJson", () => {
  it("is true for a patch that changes nothing (so nothing is written)", () => {
    expect(sameJson(mergeConfig(base, { defaults: { model: "qwen3" } }), base)).toBe(true);
  });
  it("is false when a value or a key differs", () => {
    expect(sameJson(mergeConfig(base, { defaults: { model: "other" } }), base)).toBe(false);
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJson({ a: [1, 2] }, { a: [1] })).toBe(false);
  });
});

describe("findSecretKeys", () => {
  it("finds a password or key however it is spelled", () => {
    expect(findSecretKeys({ app: { testAccount: { password: "hunter2" } } })).toEqual([
      "app.testAccount.password",
    ]);
    expect(findSecretKeys({ API_KEY: "sk-1" })).toEqual(["API_KEY"]);
    expect(findSecretKeys({ nested: { "api-key": "x", clientSecret: "y" } }).sort()).toEqual([
      "nested.api-key",
      "nested.clientSecret",
    ]);
  });

  it("does NOT flag passEnv — the NAME of the variable is the whole point", () => {
    expect(findSecretKeys({ app: { testAccount: { user: "a@b.c", passEnv: "AW_TEST_PASSWORD" } } })).toEqual([]);
    expect(findSecretKeys(base)).toEqual([]);
  });
});

describe("ConfigPatch", () => {
  it("rejects a password field even though the form could never send one", () => {
    const parsed = ConfigPatch.safeParse({ testAccount: { user: "a", passEnv: "P", password: "x" } });
    expect(parsed.success).toBe(false);
  });

  it("rejects keys it does not own, including the workspace identity and the legacy app block", () => {
    expect(ConfigPatch.safeParse({ repoRoot: "/elsewhere" }).success).toBe(false);
    expect(ConfigPatch.safeParse({ workspace: "other" }).success).toBe(false);
    expect(ConfigPatch.safeParse({ agents: { reviewer: null } }).success).toBe(false);
    // T23: the flat `app` block is a READ-side legacy shape; the form writes targets.
    expect(ConfigPatch.safeParse({ app: { baseUrl: "http://x" } }).success).toBe(false);
  });

  it("accepts the shape the form sends, nulls and raw strings included", () => {
    const parsed = ConfigPutBody.safeParse({
      ws: "fixture",
      patch: {
        defaults: { provider: "lmstudio", model: "m" },
        agents: { "code-reviewer": { provider: "anthropic", model: "claude-sonnet-5" }, "qa-tester": null },
        backend: { repoRoot: "/tmp/api", start: "s", port: "eighty", url: null, healthPath: null },
        frontend: null,
        testAccount: null,
        stagingUrl: null,
        viewports: { mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } },
        offLimits: null,
      },
    });
    expect(parsed.success).toBe(true);
  });
});

/** The same fixture in the T23 target shape — what `configRuleIssues` reads after migration. */
const targetBase = {
  workspace: "fixture",
  backend: { repoRoot: "/tmp/fixture", start: "npm run dev:api", port: 3001, healthPath: "/health" },
  frontend: { repoRoot: "/tmp/fixture-ui", start: "npm run dev", port: 5173 },
  defaults: { provider: "lmstudio", model: "qwen3" },
  viewports: { mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } },
} as const;

describe("configRuleIssues", () => {
  it("passes a config the CLI can run", () => {
    expect(configRuleIssues(base)).toEqual([]);
    expect(configRuleIssues(targetBase)).toEqual([]);
  });

  it("requires each declared target to name an absolute repo folder (T23)", () => {
    const missing = configRuleIssues({ ...targetBase, backend: { start: "x", port: 3001 } });
    expect(missing).toEqual([
      { path: "backend.repoRoot", message: expect.stringContaining("needs its repo folder") },
    ]);
    const relative = configRuleIssues({ ...targetBase, frontend: { repoRoot: "ui", port: 5173 } });
    expect(relative).toEqual([
      { path: "frontend.repoRoot", message: expect.stringContaining("absolute path") },
    ]);
  });

  it("requires a default model", () => {
    expect(configRuleIssues({ ...base, defaults: { provider: "lmstudio", model: "  " } })).toEqual([
      { path: "defaults.model", message: expect.stringContaining("model id is required") },
    ]);
  });

  it("uses the CLI's own wording when an override changes provider without a model", () => {
    const issues = configRuleIssues({ ...base, agents: { "code-reviewer": { provider: "anthropic" } } });
    expect(issues).toEqual([
      {
        path: "agents.code-reviewer.model",
        message:
          'model required: provider "anthropic" selected without a model (use --model or agents.code-reviewer.model)',
      },
    ]);
  });

  it("accepts claude-cli on an agent — the MCP bridge runs it on the local Claude login", () => {
    // It used to be refused here: the provider ignored AI SDK tools, so a tool-using workflow
    // could not run on it. `src/providers/claude-cli.ts` bridges the toolset over MCP, so the
    // only rule left is the ordinary one — an override on a different provider needs its own
    // model, because `defaults.model` belongs to the default provider.
    expect(
      configRuleIssues({
        ...base,
        agents: { "ui-designer": { provider: "claude-cli", model: "sonnet" } },
      }),
    ).toEqual([]);

    const bare = configRuleIssues({ ...base, agents: { "qa-tester": { provider: "claude-cli" } } });
    expect(bare.map((i) => i.path)).toEqual(["agents.qa-tester.model"]);
  });

  it("allows an override that only changes the model, or that repeats the default provider", () => {
    expect(configRuleIssues({ ...base, agents: { "qa-tester": { model: "other" } } })).toEqual([]);
    expect(configRuleIssues({ ...base, agents: { "qa-tester": { provider: "lmstudio" } } })).toEqual([]);
  });

  it("rejects a port that is not a whole number in range, however it was typed", () => {
    const issues = configRuleIssues({
      ...targetBase,
      backend: { repoRoot: "/tmp/fixture", start: "x", port: "eighty" },
    });
    expect(issues).toEqual([
      { path: "backend.port", message: expect.stringContaining("whole number between 1 and 65535") },
    ]);
    expect(
      configRuleIssues({ ...targetBase, frontend: { repoRoot: "/tmp/fixture-ui", port: 0 } }),
    ).toHaveLength(1);
    expect(
      configRuleIssues({ ...targetBase, frontend: { repoRoot: "/tmp/fixture-ui", port: 70000 } }),
    ).toHaveLength(1);
  });

  it("rejects viewport dimensions that are not whole numbers", () => {
    const issues = configRuleIssues({
      ...base,
      viewports: { mobile: { width: "wide", height: 812 }, desktop: { width: 1440, height: 900 } },
    });
    expect(issues.map((i) => i.path)).toEqual(["viewports.mobile.width"]);
  });

  it("insists that passEnv is an environment variable NAME", () => {
    const issues = configRuleIssues({
      ...targetBase,
      testAccount: { user: "a@b.c", passEnv: "hunter2!" },
    });
    expect(issues).toEqual([
      { path: "testAccount.passEnv", message: expect.stringContaining("never the password itself") },
    ]);
    expect(
      configRuleIssues({ ...targetBase, testAccount: { user: "a@b.c", passEnv: "AW_TEST_PASSWORD" } }),
    ).toEqual([]);
  });
});

describe("mergeIssues", () => {
  it("lets a rule explain a path instead of the schema's generic message", () => {
    const merged = mergeIssues(
      [{ path: "app.backend.port", message: "the backend port must be a whole number" }],
      [
        { path: "app.backend.port", message: "Invalid input: expected number, received string" },
        { path: "defaults.provider", message: "Invalid option" },
      ],
    );
    expect(merged).toEqual([
      { path: "app.backend.port", message: "the backend port must be a whole number" },
      { path: "defaults.provider", message: "Invalid option" },
    ]);
  });
});

describe("serializeConfig", () => {
  it("writes two-space JSON with a trailing newline, like aw init", () => {
    expect(serializeConfig({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe("prototypeKeys", () => {
  it("finds `__proto__` in a body zod's strictObject would never see", () => {
    // `JSON.parse`, not an object literal: a literal's `__proto__` sets a prototype, and the whole
    // point is that the RAW parsed body does carry it as an own property.
    const raw = JSON.parse('{"ws":"fixture","patch":{"__proto__":{"defaults":{"model":"pwn"}}}}');
    expect(prototypeKeys(raw)).toEqual(["patch.__proto__"]);
    // ...and the strict schema is happy with it, which is the bug this scan exists for.
    expect(ConfigPutBody.safeParse(raw).success).toBe(true);
  });

  it("finds them nested and inside arrays", () => {
    const raw = JSON.parse('{"patch":{"offLimits":[{"constructor":1}],"a":{"b":{"prototype":2}}}}');
    expect(prototypeKeys(raw).sort()).toEqual([
      "patch.a.b.prototype",
      "patch.offLimits.0.constructor",
    ]);
  });

  it("says nothing about an ordinary patch", () => {
    expect(prototypeKeys({ ws: "fixture", patch: { defaults: { model: "m" }, offLimits: ["z"] } })).toEqual(
      [],
    );
    expect(prototypeKeys(null)).toEqual([]);
    expect(prototypeKeys("__proto__")).toEqual([]);
  });
});
