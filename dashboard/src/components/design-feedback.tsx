"use client";

/**
 * `YOUR FEEDBACK` and the queue it writes (handoff § 04c, right column).
 *
 * Two rules govern the copyable command block, and neither changed with the restyle:
 *
 * 1. **The queued text is untrusted** (SPEC § Dashboard security invariants #3). It is rendered as
 *    text — never `dangerouslySetInnerHTML`, never a link, never a URL the page will fetch.
 * 2. **The command must be safe to paste.** `iterateCommand` single-quotes every interpolated
 *    value, so `'; rm -rf ~; echo '` in the box copies as data, not as three commands. See
 *    `design-data.ts` for why single quotes and not double.
 *
 * The same `validateFeedbackText` the route enforces runs here first. That is a courtesy — an
 * error without a round-trip — and never the gate: the route re-validates every request.
 *
 * `SEND & ITERATE` is the handoff's own definition of the button (§ Interactions: "posts the note
 * and starts a new design-loop run linked to the previous task id"), so it is the two existing
 * calls composed in the only order that is safe: queue it, start the run, and retire the queued
 * item ONLY once the run has actually started. Retiring first would lose the note when the run
 * could not start (a workspace already busy is a 409, and the commonest one); never retiring would
 * leave a button that starts the same run again on every click.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { CommandStrip, PrimaryButton, QuietButton } from "@/components/ledger/chrome";
import { LabelHead, shortWhen } from "@/components/task-header";
import {
  combinedFeedback,
  FEEDBACK_FILE,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_MAX_ITEMS,
  iterateCommand,
  validateFeedbackText,
  type FeedbackEntry,
} from "@/components/design-data";

export interface DesignFeedbackProps {
  ws: string;
  runId: string;
  /** The feature this run implemented; `""` when the manifest recorded none. */
  feature: string;
  /** The queue as the server read it from disk. */
  initialQueue: FeedbackEntry[];
  /** Set when `feedback-queue.json` exists but could not be parsed — queuing is refused. */
  queueError: string | null;
}

const PLACEHOLDER = "what should change before the next pass…";

export function DesignFeedback({
  ws,
  runId,
  feature,
  initialQueue,
  queueError,
}: DesignFeedbackProps) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [queue, setQueue] = useState<FeedbackEntry[]>(initialQueue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  /*
   * Server truth wins whenever it arrives.
   *
   * `queue` starts as a copy of the prop so a POST can update the list without a round-trip, but
   * the file on disk is the real thing: after `router.refresh()` the server re-reads it and hands
   * down a NEW array, and this resets local state to it. Without the reset, a queue emptied or
   * edited outside the panel would stay on screen until a full reload.
   */
  const [seen, setSeen] = useState(initialQueue);
  if (seen !== initialQueue) {
    setSeen(initialQueue);
    setQueue(initialQueue);
  }

  const full = queue.length >= FEEDBACK_MAX_ITEMS;
  const tooLong = text.length > FEEDBACK_MAX_CHARS;
  const blocked = queueError !== null;
  const canSubmit = !busy && !blocked && !full && !tooLong && text.trim() !== "";

  // A manifest with no feature text still gets a runnable-looking command, with an obvious
  // placeholder where the feature goes — quoted like everything else, so pasting it runs
  // design-loop on a feature literally called `<feature>` rather than doing something surprising.
  const featureArg = feature === "" ? "<feature>" : feature;

  /** Queue one note. Returns the entry the SERVER wrote, so it can be retired by exact identity. */
  const queueNote = useCallback(async (): Promise<FeedbackEntry | null> => {
    const validated = validateFeedbackText(text);
    if (!validated.ok) {
      setError(validated.error);
      return null;
    }
    const response = await fetch("/api/feedback", {
      method: "POST",
      // The route requires this exact content type; a cross-site page cannot send it without a
      // preflight, which is the panel's CSRF defence (see the route's header comment).
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ws, runId, text: validated.value }),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; message?: string; queue?: FeedbackEntry[] }
      | null;
    if (!response.ok || body?.ok !== true || !Array.isArray(body.queue)) {
      setError(body?.message ?? `the queue could not be written (HTTP ${response.status})`);
      return null;
    }
    setQueue(body.queue);
    setText("");
    // The route appends, so the entry it just wrote is the LAST one carrying this text. Retiring
    // needs its exact `createdAt` (the DELETE route matches on both fields), which only the server
    // knows — inventing one here would silently fail to remove anything.
    const written = [...body.queue].reverse().find((e) => e.text === validated.value);
    return written ?? { text: validated.value, createdAt: "" };
  }, [runId, text, ws]);

  const send = useCallback(async () => {
    setError(null);
    setFlash(null);
    setBusy(true);
    try {
      const note = await queueNote();
      if (note === null) return;

      if (feature === "") {
        // Nothing to run: `design-loop` needs the feature as its positional argument, and this
        // manifest never recorded one. The note is queued, which is the half that can be done.
        setFlash("Queued — this run recorded no feature text, so it cannot start the next pass.");
        router.refresh();
        return;
      }

      const started = await fetch("/api/trigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The feature and the feedback go as JSON FIELDS, never as the command line shown above.
        // `/api/trigger` builds its own argv from them through the per-kind allowlist (SPEC §
        // Dashboard security invariants #4), so the text reaches the CLI as one literal argument
        // and is never parsed by a shell.
        body: JSON.stringify({ ws, kind: "design-loop", args: { feature, iterate: note.text } }),
      });
      const body = (await started.json().catch(() => null)) as
        | { ok?: boolean; pid?: number; message?: string; runningPid?: number }
        | null;

      if (!started.ok || body?.ok !== true || typeof body.pid !== "number") {
        setError(
          `${body?.message ?? `the run could not be started (HTTP ${started.status})`} — the note stays queued.`,
        );
        router.refresh();
        return;
      }

      await retire(ws, runId, [note]);
      router.push(`/ws/${encodeURIComponent(ws)}/live?pid=${body.pid}`);
    } catch {
      setError("the panel could not reach the server");
    } finally {
      setBusy(false);
    }
  }, [feature, queueNote, router, runId, ws]);

  return (
    <section className="pane-live flex min-w-0 flex-col gap-3 p-5" data-design-feedback>
      <LabelHead>your feedback</LabelHead>

      <form
        data-feedback-form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex min-w-0 flex-col gap-3"
      >
        <div className="field-row relative min-w-0">
          <label htmlFor="design-feedback-text" className="sr-only">
            What should the next iteration change?
          </label>
          <textarea
            id="design-feedback-text"
            name="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={blocked}
            data-feedback-input
            className="mono block min-h-[86px] w-full min-w-0 resize-y bg-transparent pb-2.5 text-[11.5px] leading-[1.7] text-fg outline-none disabled:opacity-50"
          />
          {text === "" ? (
            // The artboard's placeholder + blinking caret. `pointer-events-none` so it is scenery:
            // every click still lands on the textarea underneath it.
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-[13px] top-[8px] flex items-start gap-[2px] pt-px"
            >
              <span className="mono text-[11.5px] leading-[1.7] text-muted">{PLACEHOLDER}</span>
              <span className="anim-caret mt-[3px] block h-[15px] w-px bg-accent" />
            </div>
          ) : null}
        </div>

        <CommandStrip
          command={iterateCommand(featureArg, text.trim() === "" ? "<feedback>" : text.trim(), ws)}
          className="min-w-0"
        />

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-[18px] gap-y-2">
          <span
            className={`mono mr-auto text-[9px] ${tooLong ? "font-medium text-danger" : "text-muted"}`}
            data-feedback-count
          >
            {text.length}/{FEEDBACK_MAX_CHARS}
          </span>
          <QuietButton type="button" disabled={busy || text === ""} onClick={() => setText("")}>
            discard
          </QuietButton>
          <span data-feedback-submit>
            <PrimaryButton accent type="submit" disabled={!canSubmit}>
              {busy ? "sending…" : "send & iterate"}
            </PrimaryButton>
          </span>
        </div>

        {error !== null ? (
          <p className="min-w-0 text-[11.5px] leading-[1.5] break-words text-danger" data-feedback-error>
            {error}
          </p>
        ) : flash !== null ? (
          <p className="min-w-0 text-[11.5px] leading-[1.5] text-ok" data-feedback-flash>
            {flash}
          </p>
        ) : null}

        {blocked ? (
          <p className="text-[11.5px] leading-[1.5] text-danger" data-feedback-blocked>
            <span className="mono">{FEEDBACK_FILE}</span> in this run&rsquo;s directory is not a
            readable queue, so nothing new can be queued without overwriting it. Move it aside and
            reload.
          </p>
        ) : full ? (
          <p className="text-[11.5px] text-ink-2">
            The queue holds its maximum of {FEEDBACK_MAX_ITEMS} items.
          </p>
        ) : null}
      </form>

      <QueueList
        queue={queue}
        feature={feature}
        featureArg={featureArg}
        ws={ws}
        runId={runId}
      />
    </section>
  );
}

/** Drop applied notes from the queue on disk. Reported but never fatal — the run is what mattered. */
async function retire(ws: string, runId: string, entries: readonly FeedbackEntry[]): Promise<void> {
  for (const entry of entries) {
    await fetch("/api/feedback", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ws, runId, text: entry.text, createdAt: entry.createdAt }),
    }).catch(() => null);
  }
}

/**
 * The notes queued but not yet run, and the exact command that applies each.
 *
 * One command per item because `--iterate` takes ONE feedback string (`src/commands/design-loop.ts`
 * registers it as `-i, --iterate <feedback>`), so four queued notes are four runs — unless you
 * want them in one pass, which is what the combined command at the bottom is for.
 */
function QueueList({
  queue,
  feature,
  featureArg,
  ws,
  runId,
}: {
  queue: FeedbackEntry[];
  feature: string;
  featureArg: string;
  ws: string;
  runId: string;
}) {
  if (queue.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-3 pt-2" data-feedback-queue>
      <LabelHead>queued · {queue.length}</LabelHead>

      {feature === "" ? (
        <p className="text-[11.5px] leading-[1.5] text-ink-2">
          This run&rsquo;s manifest recorded no feature text, so the commands below carry a
          placeholder — replace <span className="mono">&lt;feature&gt;</span> before running them.
        </p>
      ) : null}

      <ol className="flex min-w-0 flex-col gap-4">
        {queue.map((entry, index) => (
          <li key={`${entry.createdAt}-${index}`} data-queue-item className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="mono shrink-0 text-[9px] text-muted">
                {String(index + 1).padStart(2, "0")} · {shortWhen(entry.createdAt)}
              </span>
              <Apply
                ws={ws}
                runId={runId}
                feature={feature}
                iterate={entry.text}
                retireEntries={[entry]}
                label="apply"
              />
            </div>
            {/* Untrusted text, rendered as text. `whitespace-pre-wrap` keeps the newlines a human
                typed without letting them become markup. */}
            <p
              className="min-w-0 text-[12.5px] leading-[1.55] break-words whitespace-pre-wrap text-ink-2"
              data-queue-text
            >
              {entry.text}
            </p>
            <CommandStrip command={iterateCommand(featureArg, entry.text, ws)} className="min-w-0" />
          </li>
        ))}
      </ol>

      {queue.length > 1 ? (
        <div className="flex min-w-0 flex-col gap-2 border-t border-dotted border-line pt-3">
          <p className="text-[11.5px] leading-[1.5] text-ink-2">
            …or all {queue.length} in one run (<span className="mono">--iterate</span> takes a single
            string, so they are numbered into one):
          </p>
          <CommandStrip
            command={iterateCommand(featureArg, combinedFeedback(queue), ws)}
            className="min-w-0"
          />
          <div className="flex justify-end">
            <Apply
              ws={ws}
              runId={runId}
              feature={feature}
              iterate={combinedFeedback(queue)}
              retireEntries={queue}
              label={`apply all ${queue.length}`}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Start the `--iterate` run one queued note describes, then retire it. */
function Apply({
  ws,
  runId,
  feature,
  iterate,
  retireEntries,
  label,
}: {
  ws: string;
  runId: string;
  /** The run's own feature text; `""` means the manifest recorded none and this cannot run. */
  feature: string;
  iterate: string;
  retireEntries: readonly FeedbackEntry[];
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningPid, setRunningPid] = useState<number | null>(null);

  const apply = async () => {
    setError(null);
    setRunningPid(null);
    setBusy(true);
    try {
      const response = await fetch("/api/trigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ws, kind: "design-loop", args: { feature, iterate } }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; pid?: number; message?: string; runningPid?: number }
        | null;

      if (!response.ok || body?.ok !== true || typeof body.pid !== "number") {
        setError(body?.message ?? `the run could not be started (HTTP ${response.status})`);
        setRunningPid(typeof body?.runningPid === "number" ? body.runningPid : null);
        setBusy(false);
        return;
      }

      await retire(ws, runId, retireEntries);
      router.push(`/ws/${encodeURIComponent(ws)}/live?pid=${body.pid}`);
    } catch {
      setError("the panel could not reach /api/trigger");
      setBusy(false);
    }
  };

  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <span data-apply-now>
        <QuietButton
          type="button"
          disabled={busy || feature === ""}
          title={feature === "" ? "This run's manifest recorded no feature text" : undefined}
          onClick={() => void apply()}
        >
          {busy ? "starting…" : label}
        </QuietButton>
      </span>
      {error !== null ? (
        <span className="max-w-[240px] text-[10px] break-words text-danger" data-apply-error>
          {error}
          {runningPid !== null ? (
            <>
              {" "}
              <a href={`/ws/${encodeURIComponent(ws)}/live?pid=${runningPid}`} className="underline">
                watch it
              </a>
            </>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}
