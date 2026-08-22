/**
 * The Design tab of a run page (T20) — what the ui-designer produced, and what to tell it next.
 *
 * SERVER COMPONENT. It imports `node:fs` (through `@/lib/store`), which makes reaching it from a
 * client component a build error rather than a subtle leak. Everything path-shaped happens here:
 * every screenshot, the video and the queue file are resolved with `resolveArtifact`, the same
 * confinement `/api/artifact` uses, and the client halves receive `/api/artifact?…` URLs and
 * plain strings — never a filesystem path.
 *
 * Top to bottom the tab answers three questions in the order a reviewer asks them:
 *   1. What does it look like — the screen grid, the compare dropdown, the session video;
 *   2. What did the agent decide on its own — judgment calls, and the feedback already applied;
 *   3. What should change — the feedback box, which queues to `feedback-queue.json` and hands
 *      over a copyable `--iterate` command (running it is T22).
 *
 * Every string on this page that came out of a manifest is untrusted (SPEC § Dashboard security
 * invariants #3): screen names, judgment calls and feedback history are agent-written, and they
 * are rendered as text — no HTML, no link built out of them, and the one place a manifest string
 * reaches a shell (the copyable command) is single-quoted where it is built.
 */
import fs from "node:fs";
import path from "node:path";
import { artifactHref, listRuns, resolveArtifact, runDir } from "@/lib/store";
import type { RunManifest } from "@/lib/store";
import { DesignGallery, type CompareRun } from "@/components/design-gallery";
import { DesignFeedback } from "@/components/design-feedback";
import {
  designFeature,
  designSlug,
  groupScreens,
  parseFeedbackQueue,
  FEEDBACK_FILE,
  type FeedbackEntry,
  type ScreenShotView,
} from "@/components/design-data";

/** A queue file bigger than this is refused rather than parsed — same cap as the write route. */
const MAX_QUEUE_BYTES = 256 * 1024;

/**
 * How many other runs the compare dropdown offers.
 *
 * Each candidate costs a `realpath` + `stat` per screenshot to resolve its images, and a feature
 * iterated on twenty times has long since stopped being comparable to run number one. Newest
 * first, so the cut always falls on the oldest.
 */
const MAX_COMPARE_RUNS = 20;

export function DesignPanel({ run }: { run: RunManifest }) {
  const design = run.design;
  if (!design) {
    // Reachable only for a design-loop run that died before writing its result block — the tab is
    // shown for the run's KIND, not for the presence of the data.
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        This run has no design results in its <span className="font-mono">manifest.json</span>
        {run.status === "error" ? " — it ended in an error before the designer reported." : "."}
      </p>
    );
  }

  const groups = groupScreens(resolveScreens(run, design.screens));
  const video = design.video ? resolveArtifact(run.workspace, run.runId, design.video) : null;
  const queue = readQueue(run);
  const feature = designFeature(run.input);

  return (
    <div className="flex min-w-0 flex-col gap-8" data-design-panel>
      <DesignGallery
        runId={run.runId}
        workspace={run.workspace}
        createdAt={run.createdAt}
        groups={groups}
        compare={compareCandidates(run)}
        videoHref={video === null ? null : artifactHref(run.workspace, run.runId, video.relPath)}
        videoMissing={design.video && video === null ? design.video : null}
      />

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
        <TextList
          title="Judgment calls"
          empty="The designer recorded no judgment calls for this run."
          items={design.judgmentCalls}
          testId="judgment-calls"
        />
        <TextList
          title="Feedback history"
          empty="No feedback has been applied to this feature yet — this is the first pass."
          items={design.feedbackHistory}
          numbered
          testId="feedback-history"
        />
      </div>

      <DesignFeedback
        ws={run.workspace}
        runId={run.runId}
        feature={feature}
        initialQueue={queue.entries}
        queueError={queue.error}
      />
    </div>
  );
}

/**
 * A list of agent-written lines, numbered or bulleted.
 *
 * `feedbackHistory` is numbered with the LATEST LAST (T20 step 1) — it is a transcript of what
 * was asked for, in order, and reversing it would make "then I asked for X" read as "first I
 * asked for X". Judgment calls have no order, so they are bullets.
 */
function TextList({
  title,
  empty,
  items,
  numbered = false,
  testId,
}: {
  title: string;
  empty: string;
  items: readonly string[];
  numbered?: boolean;
  testId: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-design-list={testId}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
        {title}{" "}
        {items.length > 0 ? <span className="font-normal normal-case">({items.length})</span> : null}
      </h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-sm text-muted">
          {empty}
        </p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3">
          {items.map((item, index) => (
            <li key={index} className="flex min-w-0 gap-2 text-sm">
              <span className="shrink-0 font-mono text-xs text-muted">
                {numbered ? `${index + 1}.` : "•"}
              </span>
              {/* Untrusted manifest text: rendered as text, wrapping preserved, nothing parsed. */}
              <span className="min-w-0 break-words whitespace-pre-wrap">{item}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// server-side data
// ---------------------------------------------------------------------------

/**
 * Manifest screenshots → renderable cells.
 *
 * Each `path` is a string an agent wrote, so it is resolved exactly the way `/api/artifact`
 * resolves a query parameter — never joined onto the run directory here. A path that does not
 * resolve to a real file inside the run yields `href: null` and renders as a labelled gap.
 *
 * The href is built from `artifact.relPath` (the post-`realpath` name) rather than from the
 * manifest string, so the URL the browser requests is the one the store already proved contained.
 */
function resolveScreens(
  run: RunManifest,
  screens: readonly { screen: string; viewport: "mobile" | "desktop"; path: string }[],
): ScreenShotView[] {
  return screens.map((shot) => {
    const artifact = resolveArtifact(run.workspace, run.runId, shot.path);
    return {
      screen: shot.screen,
      viewport: shot.viewport,
      path: shot.path,
      href: artifact === null ? null : artifactHref(run.workspace, run.runId, artifact.relPath),
    };
  });
}

/**
 * Other design-loop runs of the SAME feature, newest first (T20 step 2).
 *
 * Same workspace only: a run in another workspace is a different repo, so a "then vs now" pair
 * across two of them would compare screenshots of two different applications. The match is on the
 * feature slug (`designSlug`), and an empty slug matches nothing — a run whose feature was never
 * recorded must not become the neighbour of every other featureless run.
 */
function compareCandidates(run: RunManifest): CompareRun[] {
  const slug = designSlug(run.input);
  if (slug === "") return [];

  return listRuns(run.workspace)
    .filter((r) => r.kind === "design-loop" && r.runId !== run.runId && r.design !== undefined)
    .filter((r) => designSlug(r.input) === slug)
    .slice(0, MAX_COMPARE_RUNS)
    .map((r) => ({
      runId: r.runId,
      createdAt: r.createdAt,
      href: `/ws/${encodeURIComponent(r.workspace)}/run/${encodeURIComponent(r.runId)}?tab=design`,
      // ISO 8601 sorts lexically, and `listRuns` already sorted on it.
      older: r.createdAt < run.createdAt,
      iterate: iterateFeedback(r),
      groups: groupScreens(resolveScreens(r, r.design?.screens ?? [])),
    }));
}

/** The `--iterate` feedback a run was started with: its last history entry, if any. */
function iterateFeedback(run: RunManifest): string | null {
  const history = run.design?.feedbackHistory ?? [];
  return history.length > 0 ? history[history.length - 1] : null;
}

/**
 * The feedback queue as it stands on disk.
 *
 * `error` is set only for a file that EXISTS and is not a queue — never for a run that simply has
 * none. The distinction is what the feedback box needs: an unparseable file blocks queuing
 * (writing would destroy it), while a missing one is the normal first-time state.
 *
 * `resolveArtifact` returning `null` is ambiguous on its own — missing file, a directory with
 * that name, or a symlink pointing out of the run — so an `lstat` (which does NOT follow the
 * link) tells the two apart. It runs on the LEXICAL run directory, which `runDir` has validated
 * as two safe path segments, and only to ask "is anything there"; nothing is read through it.
 */
function readQueue(run: RunManifest): { entries: FeedbackEntry[]; error: string | null } {
  const unusable = {
    entries: [] as FeedbackEntry[],
    error: `${FEEDBACK_FILE} exists but is not a readable feedback queue`,
  };
  const empty = { entries: [] as FeedbackEntry[], error: null };

  const artifact = resolveArtifact(run.workspace, run.runId, FEEDBACK_FILE);
  if (artifact === null) {
    const dir = runDir(run.workspace, run.runId);
    if (dir === null) return empty;
    try {
      fs.lstatSync(path.join(dir, FEEDBACK_FILE));
      return unusable; // something is there that resolveArtifact refused
    } catch {
      return empty; // nothing queued yet — the normal case
    }
  }
  if (artifact.size > MAX_QUEUE_BYTES) return unusable;

  let raw: string;
  try {
    raw = fs.readFileSync(artifact.absPath, "utf8");
  } catch {
    return unusable;
  }
  // The same parser the write route uses, so a file one of them accepts is never rejected by the
  // other — a queue that rendered fine but could not be appended to would be baffling.
  const entries = parseFeedbackQueue(raw);
  return entries === null ? unusable : { entries, error: null };
}
