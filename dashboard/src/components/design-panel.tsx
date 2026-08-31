/**
 * The Design-loop result (handoff § 04c) — what the ui-designer produced, and what to tell it next.
 *
 * SERVER COMPONENT. It imports `node:fs` (through `@/lib/store`), which makes reaching it from a
 * client component a build error rather than a subtle leak. Everything path-shaped happens here:
 * every screenshot, the video and the queue file are resolved with `resolveArtifact`, the same
 * confinement `/api/artifact` uses, and the client halves receive `/api/artifact?…` URLs and plain
 * strings — never a filesystem path.
 *
 * The body is the artboard's `1fr 340px`. Left: the galleries grouped by screen, then the
 * recording. Right, in the order a reviewer asks: why did it stop (the amber callout), what did
 * the agent decide on its own (judgment calls), what has already been asked for (feedback
 * history), and what should change now (the feedback box).
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
import { EmptyNote, LabelHead, ledgerStatus } from "@/components/task-header";
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
  const logHref = `/ws/${encodeURIComponent(run.workspace)}/run/${encodeURIComponent(run.runId)}?tab=log`;

  if (!design) {
    // Reachable only for a design-loop run that died before writing its result block — the tab is
    // shown for the run's KIND, not for the presence of the data.
    return (
      <EmptyNote>
        This run has no design results in its <span className="mono">manifest.json</span>
        {run.status === "error" ? " — it ended in an error before the designer reported." : "."}
      </EmptyNote>
    );
  }

  const groups = groupScreens(resolveScreens(run, design.screens));
  const video = design.video ? resolveArtifact(run.workspace, run.runId, design.video) : null;
  const queue = readQueue(run);
  const feature = designFeature(run.input);
  const awaiting = ledgerStatus(run) === "awaiting";

  return (
    <div
      className="grid min-w-0 grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,1fr)_340px]"
      data-design-panel
    >
      <DesignGallery
        runId={run.runId}
        workspace={run.workspace}
        createdAt={run.createdAt}
        groups={groups}
        compare={compareCandidates(run)}
        videoHref={video === null ? null : artifactHref(run.workspace, run.runId, video.relPath)}
        videoMissing={design.video && video === null ? design.video : null}
        logHref={logHref}
      />

      <div className="flex min-w-0 flex-col gap-[26px]">
        {awaiting ? (
          <div className="flex min-w-0 flex-col gap-2.5 rounded-[16px] border border-accent-line bg-warn-tint px-[18px] py-4">
            <span className="flex items-center gap-2">
              <span aria-hidden className="mark mark-awaiting" />
              <span
                className="mono text-[9px] font-medium text-warn uppercase"
                style={{ letterSpacing: "0.14em" }}
              >
                awaiting feedback
              </span>
            </span>
            <p className="text-[12.5px] leading-[1.55] text-ink-3 [text-wrap:pretty]">
              The loop stopped here on purpose. It resumes when you send a note back.
            </p>
          </div>
        ) : null}

        <TextList
          title="judgment calls"
          empty="The designer recorded no judgment calls for this run."
          items={design.judgmentCalls}
          testId="judgment-calls"
        />

        <FeedbackHistory items={design.feedbackHistory} />

        <DesignFeedback
          ws={run.workspace}
          runId={run.runId}
          feature={feature}
          initialQueue={queue.entries}
          queueError={queue.error}
        />
      </div>
    </div>
  );
}

/** Numbered lines of agent-written text — rendered as text, wrapping preserved, nothing parsed. */
function TextList({
  title,
  empty,
  items,
  testId,
}: {
  title: string;
  empty: string;
  items: readonly string[];
  testId: string;
}) {
  return (
    <section className="pane-quiet flex min-w-0 flex-col gap-3 rounded-[18px]! p-5" data-design-list={testId}>
      <LabelHead>
        {title}
        {items.length > 0 ? ` · ${items.length}` : ""}
      </LabelHead>
      {items.length === 0 ? (
        <p className="text-[12.5px] leading-[1.55] text-ink-2">{empty}</p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-3">
          {items.map((item, index) => (
            <li key={index} className="flex min-w-0 gap-[11px]">
              <span className="mono shrink-0 pt-[3px] text-[9px] text-accent">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-ink-2 [text-wrap:pretty]">
                {item}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * What has already been asked for, newest first.
 *
 * `design.feedbackHistory` is a plain array of strings (SPEC § Types) with no timestamps, so the
 * artboard's `19 Aug 09:41 · iteration 1` line becomes `iteration 1` — the iteration number is
 * printed EXPLICITLY precisely because the list is reversed, so "newest first" can never be
 * misread as "this is what I asked for first".
 */
function FeedbackHistory({ items }: { items: readonly string[] }) {
  return (
    <section
      className="pane-quiet flex min-w-0 flex-col gap-3 rounded-[18px]! p-5"
      data-design-list="feedback-history"
    >
      <LabelHead>feedback history{items.length > 0 ? ` · ${items.length}` : ""}</LabelHead>
      {items.length === 0 ? (
        <p className="text-[12.5px] leading-[1.55] text-ink-2">
          No feedback has been applied to this feature yet — this is the first pass.
        </p>
      ) : (
        <ol className="flex min-w-0 flex-col gap-3">
          {items
            .map((text, index) => ({ text, iteration: index + 1 }))
            .reverse()
            .map((entry, i) => (
              <li
                key={entry.iteration}
                className={`flex min-w-0 flex-col gap-1.5 ${
                  i === 0 ? "" : "border-t border-dotted border-line pt-3"
                }`}
              >
                <span className="mono text-[9px] text-muted">iteration {entry.iteration}</span>
                <span className="min-w-0 text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-ink-2 [text-wrap:pretty]">
                  {entry.text}
                </span>
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
 * Other design-loop runs of the SAME feature, newest first.
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
      href: `/ws/${encodeURIComponent(r.workspace)}/run/${encodeURIComponent(r.runId)}`,
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
 * `resolveArtifact` returning `null` is ambiguous on its own — missing file, a directory with that
 * name, or a symlink pointing out of the run — so an `lstat` (which does NOT follow the link)
 * tells the two apart. It runs on the LEXICAL run directory, which `runDir` has validated as two
 * safe path segments, and only to ask "is anything there"; nothing is read through it.
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
