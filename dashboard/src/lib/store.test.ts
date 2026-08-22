import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteRun,
  listArchivedRuns,
  listRuns,
  moveRun,
  readLogTail,
  readRun,
  resolveRunFile,
} from "./store";

/**
 * The mutation gates and the run-file resolver, against a real `$AW_HOME` with symlinks planted in
 * it — which is the store the panel actually reads. SPEC § Dashboard security invariants #2 and
 * #3: the panel reads a directory that agents with `write_file` and an unconfined `bash` also
 * write to, so "a name inside the store" and "a directory inside the store" are different claims.
 *
 * `config-patch.test.ts` covered the merge and nothing covered these, which is how a destination
 * that followed a symlinked `archive/` — moving a run OUT of the store and reporting success —
 * survived a 97-probe acceptance run that only ever planted links on the `runs/` side.
 */
let home: string;
let outside: string;

function writeManifest(dir: string, runId: string, workspace = "ws", extra: object = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      runId,
      kind: "review",
      workspace,
      createdAt: "2026-01-01T00:00:00.000Z",
      agent: "code-reviewer",
      provider: "lmstudio",
      model: "m",
      status: "done",
      input: { args: "review" },
      ...extra,
    }),
  );
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aw-store-test-"));
  home = path.join(root, "home");
  outside = path.join(root, "outside");
  fs.mkdirSync(path.join(home, "ws", "runs"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  process.env.AW_HOME = home;
});

afterEach(() => {
  delete process.env.AW_HOME;
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

describe("moveRun — the destination is confined too", () => {
  it("archives and restores a normal run", () => {
    writeManifest(path.join(home, "ws", "runs", "review-1"), "review-1");
    expect(moveRun("ws", "review-1", "runs", "archive")).toBe("ok");
    expect(fs.existsSync(path.join(home, "ws", "archive", "review-1"))).toBe(true);
    expect(listRuns("ws")).toHaveLength(0);
    expect(listArchivedRuns("ws")).toHaveLength(1);

    expect(moveRun("ws", "review-1", "archive", "runs")).toBe("ok");
    expect(listRuns("ws")).toHaveLength(1);
  });

  it("refuses when archive/ is a symlink pointing outside the store", () => {
    writeManifest(path.join(home, "ws", "runs", "review-1"), "review-1");
    fs.symlinkSync(outside, path.join(home, "ws", "archive"));

    expect(moveRun("ws", "review-1", "runs", "archive")).toBe("not-found");
    // The run is still where it was, and nothing landed outside.
    expect(fs.existsSync(path.join(home, "ws", "runs", "review-1", "manifest.json"))).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses when archive/ is a symlink to another workspace's runs/", () => {
    fs.mkdirSync(path.join(home, "other", "runs"), { recursive: true });
    writeManifest(path.join(home, "ws", "runs", "review-1"), "review-1");
    fs.symlinkSync(path.join(home, "other", "runs"), path.join(home, "ws", "archive"));

    expect(moveRun("ws", "review-1", "runs", "archive")).toBe("not-found");
    expect(fs.readdirSync(path.join(home, "other", "runs"))).toEqual([]);
  });

  it("refuses when the workspace directory itself is a symlink", () => {
    fs.mkdirSync(path.join(outside, "runs", "review-1"), { recursive: true });
    writeManifest(path.join(outside, "runs", "review-1"), "review-1", "sym");
    fs.symlinkSync(outside, path.join(home, "sym"));

    expect(moveRun("sym", "review-1", "runs", "archive")).toBe("not-found");
  });

  it("refuses a run directory that is itself a symlink (source gate)", () => {
    fs.mkdirSync(path.join(outside, "planted"), { recursive: true });
    writeManifest(path.join(outside, "planted"), "planted");
    fs.symlinkSync(path.join(outside, "planted"), path.join(home, "ws", "runs", "review-1"));

    expect(moveRun("ws", "review-1", "runs", "archive")).toBe("not-found");
    expect(fs.existsSync(path.join(outside, "planted", "manifest.json"))).toBe(true);
  });

  it("reports an existing destination rather than overwriting it — even a dangling link", () => {
    writeManifest(path.join(home, "ws", "runs", "review-1"), "review-1");
    fs.mkdirSync(path.join(home, "ws", "archive"), { recursive: true });
    fs.symlinkSync(path.join(outside, "gone"), path.join(home, "ws", "archive", "review-1"));

    expect(moveRun("ws", "review-1", "runs", "archive")).toBe("exists");
    expect(fs.existsSync(path.join(home, "ws", "runs", "review-1", "manifest.json"))).toBe(true);
  });

  it("refuses traversal-shaped names", () => {
    writeManifest(path.join(home, "ws", "runs", "review-1"), "review-1");
    expect(moveRun("ws", "../../etc", "runs", "archive")).toBe("not-found");
    expect(moveRun("../..", "review-1", "runs", "archive")).toBe("not-found");
    expect(moveRun("ws", "review-1", "runs", "elsewhere" as never)).toBe("not-found");
  });
});

describe("deleteRun", () => {
  it("deletes exactly the named run directory", () => {
    writeManifest(path.join(home, "ws", "runs", "review-1"), "review-1");
    writeManifest(path.join(home, "ws", "runs", "review-2"), "review-2");

    expect(deleteRun("ws", "review-1")).toBe("ok");
    expect(fs.existsSync(path.join(home, "ws", "runs", "review-1"))).toBe(false);
    expect(fs.existsSync(path.join(home, "ws", "runs", "review-2"))).toBe(true);
  });

  it("refuses a symlinked run directory, and leaves its target alone", () => {
    fs.mkdirSync(path.join(outside, "victim"), { recursive: true });
    fs.writeFileSync(path.join(outside, "victim", "keep.txt"), "keep");
    fs.symlinkSync(path.join(outside, "victim"), path.join(home, "ws", "runs", "review-1"));

    expect(deleteRun("ws", "review-1")).toBe("not-found");
    expect(fs.existsSync(path.join(outside, "victim", "keep.txt"))).toBe(true);
  });

  it("unlinks a symlink INSIDE a run without touching its target", () => {
    const dir = path.join(home, "ws", "runs", "review-1");
    writeManifest(dir, "review-1");
    fs.mkdirSync(path.join(dir, "artifacts"));
    fs.writeFileSync(path.join(outside, "precious.txt"), "precious");
    fs.symlinkSync(path.join(outside, "precious.txt"), path.join(dir, "artifacts", "link.txt"));

    expect(deleteRun("ws", "review-1")).toBe("ok");
    expect(fs.readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("precious");
  });
});

describe("resolveRunFile — the log.txt symlink escape", () => {
  it("resolves a real file inside the run", () => {
    const dir = path.join(home, "ws", "runs", "review-1");
    writeManifest(dir, "review-1");
    fs.writeFileSync(path.join(dir, "log.txt"), "hello\n");

    expect(resolveRunFile("ws", "review-1", "log.txt")).toBe(path.join(dir, "log.txt"));
    expect(readLogTail("ws", "review-1").text).toBe("hello");
  });

  it("refuses a log.txt that is a symlink to a file outside the store", () => {
    const dir = path.join(home, "ws", "runs", "review-1");
    writeManifest(dir, "review-1");
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET-CANARY\n");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "log.txt"));

    expect(resolveRunFile("ws", "review-1", "log.txt")).toBeNull();
    const tail = readLogTail("ws", "review-1");
    expect(tail.text).toBe("");
    expect(tail.exists).toBe(false);
  });

  it("refuses a directory, a missing file and a caller-supplied path", () => {
    const dir = path.join(home, "ws", "runs", "review-1");
    writeManifest(dir, "review-1");
    fs.mkdirSync(path.join(dir, "artifacts"));

    expect(resolveRunFile("ws", "review-1", "artifacts")).toBeNull();
    expect(resolveRunFile("ws", "review-1", "log.txt")).toBeNull();
    expect(resolveRunFile("ws", "review-1", "../manifest.json")).toBeNull();
    expect(resolveRunFile("ws", "review-1", "artifacts/report.md")).toBeNull();
  });
});

describe("manifest identity is the directory, not the file's own claim", () => {
  it("overrides a runId/workspace that disagree with the path", () => {
    writeManifest(path.join(home, "ws", "runs", "review-copy"), "review-original", "elsewhere");

    const listed = listRuns("ws");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.runId).toBe("review-copy");
    expect(listed[0]!.workspace).toBe("ws");

    const read = readRun("ws", "review-copy");
    expect(read?.runId).toBe("review-copy");
    expect(read?.workspace).toBe("ws");
  });

  it("means a duplicated run directory can only ever be acted on by its own name", () => {
    writeManifest(path.join(home, "ws", "runs", "review-1"), "review-1");
    writeManifest(path.join(home, "ws", "runs", "review-1-copy"), "review-1");

    expect(listRuns("ws").map((r) => r.runId).sort()).toEqual(["review-1", "review-1-copy"]);
    expect(deleteRun("ws", "review-1-copy")).toBe("ok");
    expect(fs.existsSync(path.join(home, "ws", "runs", "review-1", "manifest.json"))).toBe(true);
  });
});
