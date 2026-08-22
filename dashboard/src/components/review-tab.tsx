import fs from "node:fs";
import { artifactHref, resolveArtifact } from "@/lib/store";
import type { RunManifest } from "@/lib/store";
import { formatBytes } from "@/lib/format";
import { parseUnifiedDiff } from "@/lib/diff";
import { ReviewPanel } from "@/components/review-panel";

/**
 * Server half of the Review tab: turn `manifest.review` plus the run's `diff.patch` into props.
 *
 * SERVER ONLY — it imports `node:fs`, which makes using it from a client component a build error
 * rather than a subtle leak. The patch is read and parsed here so the browser receives rows, not
 * a 60 KB string plus a parser.
 *
 * `resolveArtifact` does the reading side of the path confinement (src/lib/store.ts): the
 * manifest is a file an agent wrote, so `diffArtifact` is untrusted input and is resolved the
 * same way `/api/artifact` resolves a query parameter — never joined onto the run directory here.
 *
 * A missing or unreadable patch is NOT an error page. The verdict and the findings are in the
 * manifest and are worth showing on their own; without a diff every finding simply lands in the
 * "Unanchored findings" list, with `notice` explaining why.
 */

/** Above this the patch is not rendered. Our own review budget caps diffs at 60 KB. */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;

export function ReviewTab({ run }: { run: RunManifest }) {
  const review = run.review;
  if (review === undefined) {
    // The page only mounts this tab for `review` runs, and the schema gives those a review block.
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        This run recorded no review result.
      </p>
    );
  }

  const artifact = resolveArtifact(run.workspace, run.runId, review.diffArtifact);
  let patch = "";
  let notice: string | null = null;

  if (artifact === null) {
    notice = `The manifest names ${review.diffArtifact}, but that file is not in this run's directory — findings cannot be pinned to a diff.`;
  } else if (artifact.size > MAX_PATCH_BYTES) {
    notice = `${review.diffArtifact} is ${formatBytes(artifact.size)}, too large to render inline.`;
  } else {
    try {
      patch = fs.readFileSync(artifact.absPath, "utf8");
    } catch (err) {
      // The errno, never `err.message`: Node puts the ABSOLUTE path in the message for EACCES,
      // EISDIR, ELOOP, ENAMETOOLONG and EIO, which would print the reader's whole run-store
      // layout into the page — SPEC § Dashboard security invariants #2 forbids an error naming a
      // real path. The two branches above already name only the manifest-relative path.
      const code = err instanceof Error && "code" in err ? String(err.code) : "read error";
      notice = `${review.diffArtifact} could not be read (${code}) — findings cannot be pinned to a diff.`;
    }
    if (notice === null && patch.trim() === "") {
      notice = `${review.diffArtifact} is empty — this run recorded no diff.`;
    }
  }

  const files = parseUnifiedDiff(patch);
  if (notice === null && files.length === 0) {
    notice = `${review.diffArtifact} does not look like a unified diff, so no rows could be rendered.`;
  }

  return (
    <ReviewPanel
      verdict={review.verdict}
      findings={review.findings}
      files={files}
      diffHref={artifact === null ? null : artifactHref(run.workspace, run.runId, artifact.relPath)}
      notice={notice}
    />
  );
}
