import { describe, expect, it } from "vitest";
import { matchRunSaved, runCwd } from "./runner";

/**
 * The `run saved: <ws>/<runId>` marker (src/store.ts `finish`, T16 step 2) is how a triggered run
 * learns its own id, and it was missed whenever a pipe chunk boundary landed mid-line just before
 * it: the old pattern anchored on `^` with the `m` flag, and both pipes fed ONE scan buffer, so a
 * stdout chunk that ended without a newline left the marker somewhere other than a line start.
 * Measured at the first 64 KB pipe boundary — a ~71 KB model reply lost it 6 times out of 6, which
 * orphaned the transcript in `pending/` and made the live view say "this process ended without
 * saving a run" for a run that had been saved.
 *
 * `attachLog` now scans the stderr tail alone (the marker is a single `writeSync(2, …)`), and the
 * pattern accepts a marker that begins a line OR follows a newline anywhere in the buffer.
 */
describe("matchRunSaved", () => {
  it("finds the marker in a clean stream", () => {
    expect(matchRunSaved("run design-loop done in 12 ms\nrun saved: fixture/review-1\n")).toEqual({
      ws: "fixture",
      runId: "review-1",
    });
  });

  it("finds it at the very start of the buffer, with no trailing newline", () => {
    expect(matchRunSaved("run saved: fixture/design-loop-20260822-004725")).toEqual({
      ws: "fixture",
      runId: "design-loop-20260822-004725",
    });
  });

  it("finds it after a chunk boundary spliced a partial line in front of it", () => {
    // Exactly the shape a 64 KB stdout chunk used to produce in the shared buffer.
    const spliced = `${"x".repeat(4000)}\nrun saved: fixture/review-20260822-084315\n`;
    expect(matchRunSaved(spliced)).toEqual({ ws: "fixture", runId: "review-20260822-084315" });
  });

  it("does not match a marker glued to the end of another line", () => {
    // Still a real rule: `…output.run saved: x/y` is text that happens to contain the words, not
    // a line the CLI printed. The fix is the separate stderr buffer, not accepting mid-line text.
    expect(matchRunSaved("some outputrun saved: fixture/review-1\n")).toBeNull();
  });

  it("ignores lines that only look like the marker", () => {
    expect(matchRunSaved("run saved: fixture\n")).toBeNull();
    expect(matchRunSaved("run saved: ../etc/passwd\n")).toBeNull();
    expect(matchRunSaved("run saved: fixture/../other\n")).toBeNull();
    expect(matchRunSaved("the agent wrote: run saved: fixture/review-1\n")).toBeNull();
  });
});

/**
 * T23: the panel spawns each kind in the PRIMARY target's repo — design-loop in the frontend,
 * test-feature in the backend, review wherever its (validated) `target` argument says. This is
 * the panel-side half of "each spawn uses that target's own repoRoot as cwd", and the one place
 * a mistake means the CLI runs in the wrong repository.
 */
describe("runCwd", () => {
  const two = { repoRoot: "/api", backendRepo: "/api", frontendRepo: "/ui" };
  const legacy = { repoRoot: "/one" };
  const frontendOnly = { repoRoot: "/ui", frontendRepo: "/ui" };

  it("design-loop runs in the frontend repo", () => {
    expect(runCwd(two, "design-loop", {})).toBe("/ui");
    expect(runCwd(legacy, "design-loop", {})).toBe("/one");
  });

  it("test-feature runs in the backend repo", () => {
    expect(runCwd(two, "test-feature", {})).toBe("/api");
    expect(runCwd(legacy, "test-feature", {})).toBe("/one");
  });

  it("review follows its target argument, defaulting to the backend", () => {
    expect(runCwd(two, "review", {})).toBe("/api");
    expect(runCwd(two, "review", { target: "backend" })).toBe("/api");
    expect(runCwd(two, "review", { target: "frontend" })).toBe("/ui");
    expect(runCwd(legacy, "review", {})).toBe("/one");
  });

  it("a frontend-only workspace reviews its frontend by default", () => {
    expect(runCwd(frontendOnly, "review", {})).toBe("/ui");
  });
});
