"use client";

/**
 * The Design tab's feedback box and the queue it writes (T20 step 3).
 *
 * The queue is the handover to the next `--iterate` run. T20 only WROTE it and rendered the
 * command that applies it; T22 adds the "Apply now" button that starts that run from here (and
 * retires the item once it has). The copyable command stays — it is what you paste into a
 * terminal when you want the run in a shell you can watch, and it is the thing to read when you
 * want to know exactly what "Apply now" is about to do. Two rules govern that block:
 *
 * 1. **The queued text is untrusted** (SPEC § Dashboard security invariants #3). It is rendered as
 *    text — never `dangerouslySetInnerHTML`, never a link, never a URL the page will fetch.
 * 2. **The command must be safe to paste.** `iterateCommand` single-quotes every interpolated
 *    value, so `'; rm -rf ~; echo '` in the box copies as data, not as three commands. See
 *    `design-data.ts` for why single quotes and not the double quotes T20's sketch shows.
 *
 * The same `validateFeedbackText` the route enforces runs here first. That is a courtesy — an
 * error without a round-trip — and never the gate: the route re-validates every request.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatWhen } from "@/lib/format";
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

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setError(null);
      setFlash(null);

      const validated = validateFeedbackText(text);
      if (!validated.ok) {
        setError(validated.error);
        return;
      }

      setBusy(true);
      try {
        const response = await fetch("/api/feedback", {
          method: "POST",
          // The route requires this exact content type; a cross-site page cannot send it without
          // a preflight, which is the panel's CSRF defence (see the route's header comment).
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, runId, text: validated.value }),
        });
        const body = (await response.json().catch(() => null)) as
          // `message`, like every other route in the panel: `/api/feedback` used to be the one
          // that answered `{ ok: false, error }`, which this component then had to read two ways.
          | { ok?: boolean; message?: string; queue?: FeedbackEntry[] }
          | null;

        if (!response.ok || body?.ok !== true || !Array.isArray(body.queue)) {
          setError(body?.message ?? `the queue could not be written (HTTP ${response.status})`);
          return;
        }

        setQueue(body.queue);
        setText("");
        setFlash("Queued.");
        // Re-render the server component so a later reload — and anything else reading the run —
        // matches what is on screen.
        router.refresh();
      } catch {
        setError("the panel could not reach /api/feedback");
      } finally {
        setBusy(false);
      }
    },
    [router, runId, text, ws],
  );

  return (
    <section className="flex min-w-0 flex-col gap-4" data-design-feedback>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Feedback</h2>

      <form
        onSubmit={submit}
        data-feedback-form
        className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3"
      >
        <label htmlFor="design-feedback-text" className="text-sm text-muted">
          What should the next iteration change?
        </label>
        <textarea
          id="design-feedback-text"
          name="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          disabled={blocked}
          placeholder="center the footer text and make it muted grey"
          data-feedback-input
          className="min-w-0 resize-y rounded border border-line bg-surface-2 px-2 py-1.5 font-sans text-sm text-fg placeholder:text-muted disabled:opacity-50"
        />

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <button
            type="submit"
            disabled={!canSubmit}
            data-feedback-submit
            className="rounded border border-line bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-link disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Queueing…" : "Queue feedback"}
          </button>

          <span
            className={`text-xs ${tooLong ? "font-semibold text-error-fg" : "text-muted"}`}
            data-feedback-count
          >
            {text.length}/{FEEDBACK_MAX_CHARS}
          </span>

          {error !== null ? (
            <span className="min-w-0 text-xs font-medium break-words text-error-fg" data-feedback-error>
              {error}
            </span>
          ) : flash !== null ? (
            <span className="text-xs text-done-fg" data-feedback-flash>
              {flash}
            </span>
          ) : null}
        </div>

        {blocked ? (
          <p className="text-xs text-error-fg" data-feedback-blocked>
            <span className="font-mono">{FEEDBACK_FILE}</span> in this run&rsquo;s directory is not
            a readable queue, so nothing new can be queued without overwriting it. Move it aside
            and reload.
          </p>
        ) : full ? (
          <p className="text-xs text-muted">
            The queue holds its maximum of {FEEDBACK_MAX_ITEMS} items.
          </p>
        ) : null}
      </form>

      <QueueList queue={queue} feature={feature} ws={ws} runId={runId} />
    </section>
  );
}

/**
 * The queued items and, for each, the exact command that applies it.
 *
 * One command per item because `--iterate` takes ONE feedback string (`src/commands/design-loop.ts`
 * registers it as `-i, --iterate <feedback>`), so four queued notes are four runs — unless you
 * want them in one pass, which is what the combined command at the bottom is for.
 */
function QueueList({
  queue,
  feature,
  ws,
  runId,
}: {
  queue: FeedbackEntry[];
  feature: string;
  ws: string;
  runId: string;
}) {
  if (queue.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
        Nothing queued yet. Queued feedback is written to{" "}
        <span className="font-mono">{FEEDBACK_FILE}</span> in this run&rsquo;s directory and
        survives a reload.
      </p>
    );
  }

  // A manifest with no feature text still gets a runnable-looking command, with an obvious
  // placeholder where the feature goes — quoted like everything else, so pasting it runs
  // design-loop on a feature literally called `<feature>` rather than doing something surprising.
  const featureArg = feature === "" ? "<feature>" : feature;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-feedback-queue>
      <h3 className="text-xs uppercase tracking-wide text-muted">
        Queued ({queue.length}) — apply with
      </h3>

      {feature === "" ? (
        <p className="text-xs text-muted">
          This run&rsquo;s manifest recorded no feature text, so the commands below carry a
          placeholder — replace <span className="font-mono">&lt;feature&gt;</span> before running
          them.
        </p>
      ) : null}

      <ol className="flex min-w-0 list-none flex-col gap-3">
        {queue.map((entry, index) => (
          <li
            key={`${entry.createdAt}-${index}`}
            data-queue-item
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3"
          >
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xs font-semibold text-muted">{index + 1}.</span>
              {/* Untrusted text, rendered as text. `whitespace-pre-wrap` keeps the newlines a
                  human typed without letting them become markup. */}
              <p className="min-w-0 flex-1 text-sm break-words whitespace-pre-wrap" data-queue-text>
                {entry.text}
              </p>
              <time className="text-xs text-muted" dateTime={entry.createdAt}>
                {formatWhen(entry.createdAt)}
              </time>
            </div>
            <CommandBlock command={iterateCommand(featureArg, entry.text, ws)} />
            <ApplyNow
              ws={ws}
              runId={runId}
              feature={feature}
              iterate={entry.text}
              retire={[entry]}
              label="Apply now"
            />
          </li>
        ))}
      </ol>

      {queue.length > 1 ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-dashed border-line p-3">
          <p className="text-xs text-muted">
            …or all {queue.length} in one run (<span className="font-mono">--iterate</span> takes a
            single string, so they are numbered into one):
          </p>
          <CommandBlock
            command={iterateCommand(featureArg, combinedFeedback(queue), ws)}
            testId="combined"
          />
          <ApplyNow
            ws={ws}
            runId={runId}
            feature={feature}
            iterate={combinedFeedback(queue)}
            retire={queue}
            label={`Apply all ${queue.length} now`}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Apply now" — start the `--iterate` run this item describes (T22 step 3).
 *
 * The request carries the feature and the feedback as JSON FIELDS, not as the command line shown
 * above it. `/api/trigger` builds its own argv array from them through the per-kind allowlist
 * (SPEC § Dashboard security invariants #4), so the queued text — which anyone with the panel
 * open can type — reaches the CLI as one literal argument and is never parsed by a shell. The
 * pretty command block is a rendering of the same two values, and the two cannot drift because
 * both come from this component's props.
 *
 * The item is retired only AFTER the trigger succeeds. Order matters both ways round:
 * deleting first would lose the note if the run could not start (a workspace already busy is a
 * 409, and the commonest one), while never deleting would leave a button that starts the same run
 * again on every click. "Success" is the run STARTING, not finishing: the feedback is in the
 * child's argv by then and the workflow records it in `design.feedbackHistory`, which is where it
 * belongs once it has been handed over.
 */
function ApplyNow({
  ws,
  runId,
  feature,
  iterate,
  retire,
  label,
}: {
  ws: string;
  runId: string;
  /** The run's own feature text; `""` means the manifest recorded none and this cannot run. */
  feature: string;
  iterate: string;
  /** The queue entries to remove once the run has started. */
  retire: readonly FeedbackEntry[];
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningPid, setRunningPid] = useState<number | null>(null);

  const disabled = busy || feature === "";

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
        return;
      }

      // Retire the applied items. A failure here is reported but does not undo the run: the run
      // is the thing that was asked for, and a note that is still queued can be deleted by hand.
      for (const entry of retire) {
        await fetch("/api/feedback", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ws, runId, text: entry.text, createdAt: entry.createdAt }),
        }).catch(() => null);
      }
      router.push(`/ws/${encodeURIComponent(ws)}/live?pid=${body.pid}`);
    } catch {
      setError("the panel could not reach /api/trigger");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => void apply()}
        disabled={disabled}
        data-apply-now
        title={feature === "" ? "This run's manifest recorded no feature text" : undefined}
        className="shrink-0 rounded border border-link bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg transition-colors hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Starting…" : label}
      </button>

      {error !== null ? (
        <span className="min-w-0 text-xs font-medium break-words text-error-fg" data-apply-error>
          {error}
          {runningPid !== null ? (
            <>
              {" "}
              <a href={`/ws/${encodeURIComponent(ws)}/live?pid=${runningPid}`} className="underline">
                Watch it
              </a>
              .
            </>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** A copyable command line. Wide, so it scrolls INSIDE its box and never widens the page. */
function CommandBlock({ command, testId }: { command: string; testId?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <code
        data-iterate-command={testId ?? "item"}
        className="min-w-0 flex-1 overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs whitespace-pre"
      >
        {command}
      </code>
      <CopyButton value={command} />
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

/**
 * Copy-to-clipboard with a real fallback.
 *
 * `navigator.clipboard` needs a secure context, which `http://127.0.0.1:4400` is; it is still
 * absent when the panel is opened over a LAN address, and a button that silently did nothing
 * there would be worse than the deprecated `execCommand` path.
 */
function CopyButton({ value }: { value: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const show = (next: CopyState) => {
    setState(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  };

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        show("copied");
        return;
      }
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      show(ok ? "copied" : "failed");
    } catch {
      show("failed");
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      data-copy-command
      className="shrink-0 rounded border border-line px-2 py-0.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </button>
  );
}
