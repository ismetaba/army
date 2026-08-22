"use client";

/**
 * The 200px left margin (handoff § 02): the live entry, the `LOG` tail and `THIS WEEK`.
 *
 * One block that says two things depending on the workspace: `IN PROGRESS` while a task is
 * running, and `JUST FILED` — with the rotated verdict stamp — for the newest entry once nothing
 * is. It is deliberately the same block rather than two stacked ones: the margin is a single
 * column of the ledger's current state, and a screen showing both at once would be a screen where
 * neither is "the" answer.
 *
 * Every value here comes from the backend. The elapsed clock is computed from the run's
 * `startedAt`, the step and the progress rule are folded out of the run's own log (see
 * `progressOf` in `./model`), and the filed summary is read from the manifest — none of it is the
 * design reference's timer.
 */

import Link from "next/link";
import { useLiveRun } from "./live-run";
import {
  filedStamp,
  filedSummary,
  formatAgo,
  formatElapsed,
  kindMeta,
  resultCount,
  severityLine,
  type LedgerRow,
  type WeekSummary,
} from "./model";

export function LiveMargin({
  ws,
  lastFiled,
  week,
}: {
  ws: string;
  lastFiled: LedgerRow | null;
  week: WeekSummary;
}) {
  return (
    <aside className="flex w-[200px] flex-none flex-col gap-[30px]">
      <LiveEntry ws={ws} lastFiled={lastFiled} />
      <LogBlock />
      <WeekBlock week={week} />
    </aside>
  );
}

/**
 * The workspace's ONE polite live region (handoff § Accessibility: "the running log and elapsed
 * timer should be `aria-live="polite"` but throttled; announce the verdict once when it lands").
 *
 * Throttled by its CONTENT, not by a timer: the text is the elapsed time rounded to whole minutes,
 * so the region's text — and therefore the DOM — changes once a minute however often the clock
 * behind it ticks. An `aria-live` on the visible 30px clock was one announcement per second for the
 * whole life of the run; a reader could not hear anything else while a task was going.
 *
 * Rendered by the PAGE, once, outside both the 1440 margin and the 375 card. A live region only
 * announces a change to text that was already there, so it has to outlive the branch it describes:
 * mounted once, its first content (a run that landed hours ago) is silent and the switch from
 * `running` to the verdict is the single announcement that lands.
 */
export function LiveAnnounce({ lastFiled }: { lastFiled: LedgerRow | null }) {
  const { run, elapsed } = useLiveRun();

  let text = "";
  if (run !== null) {
    const minutes = elapsed === null ? 0 : Math.floor(elapsed / 60);
    text =
      minutes === 0
        ? "Task running."
        : `Task running — ${minutes} minute${minutes === 1 ? "" : "s"} elapsed.`;
  } else if (lastFiled !== null) {
    const stamp = filedStamp(lastFiled);
    text = `Run finished${stamp === null ? "" : ` — ${stamp.text}`}. ${filedSummary(lastFiled)}`;
  }

  return (
    <p aria-live="polite" className="sr-only">
      {text}
    </p>
  );
}

export function LiveEntry({ ws, lastFiled }: { ws: string; lastFiled: LedgerRow | null }) {
  const { run, elapsed, progress } = useLiveRun();

  if (run !== null) {
    return (
      <section data-live-entry="running" className="flex flex-col gap-2.5">
        <h2 className="mono text-[9.5px] font-medium tracking-[0.14em] text-accent">IN PROGRESS</h2>
        <p className="mono truncate text-[10px] leading-[1.7] tracking-[-0.04em] text-ink-2">
          {run.runId ?? `${kindMeta(run.kind).title.toLowerCase()} · pid ${run.pid}`}
        </p>
        {/* No `aria-live` here, for the reason `Elapsed` in live-log.tsx gives: a value that
            changes every second is noise, and a run lasts minutes. `LiveAnnounce` below carries the
            throttled announcement handoff § Accessibility actually asks for. */}
        <p className="text-[30px] font-semibold tracking-[-0.03em] tabular-nums">
          {elapsed === null ? "—" : formatElapsed(elapsed)}
        </p>

        <ProgressRule fraction={progress.fraction} />

        <p className="mono line-clamp-3 text-[10px] leading-[1.6] tracking-[-0.03em] break-words text-ink-3">
          {progress.step === "" ? "waiting for the first line…" : progress.step}
        </p>

        <div className="mt-0.5 flex items-baseline gap-2">
          {/* `key` on the value is what replays the flip: React remounts the node when the number
              changes and leaves it alone when it does not (handoff § Motion). */}
          <span key={progress.tools} className="anim-flip text-[18px] font-semibold tracking-[-0.02em]">
            {progress.tools}
          </span>
          <span className="mono text-[9.5px] tracking-[-0.03em] text-ink-3">tool calls</span>
        </div>

        <Link
          href={
            run.pid !== null
              ? `/ws/${encodeURIComponent(ws)}/live?pid=${run.pid}`
              : `/ws/${encodeURIComponent(ws)}/live?run=${encodeURIComponent(run.runId ?? "")}`
          }
          data-live-open
          className="mono mt-1 text-[9.5px] tracking-[0.04em] text-accent transition-colors duration-[180ms] hover:text-accent-hover"
        >
          {run.cancelRequested ? "CANCELLING ↗" : "OPEN ↗"}
        </Link>
      </section>
    );
  }

  if (lastFiled === null) {
    return (
      <section data-live-entry="idle" className="flex flex-col gap-2.5">
        <h2 className="mono text-[9.5px] font-medium tracking-[0.14em] text-ink-3">NOTHING RUNNING</h2>
        <p className="mono text-[10px] leading-[1.6] tracking-[-0.03em] text-muted">
          start a task and this margin follows it
        </p>
      </section>
    );
  }

  const stamp = filedStamp(lastFiled);
  const count = resultCount(lastFiled);
  const severities = severityLine(lastFiled.findings);

  return (
    <section data-live-entry="filed" className="flex flex-col gap-3">
      <h2 className="mono text-[9.5px] font-medium tracking-[0.14em] text-ok">JUST FILED</h2>
      <p className="mono truncate text-[10px] leading-[1.7] tracking-[-0.04em] text-ink-2">
        {lastFiled.runId}
      </p>

      {stamp !== null ? (
        <p
          data-live-stamp={stamp.text}
          className={`anim-stamp mono w-fit -rotate-3 border-2 px-2 py-1 text-[10px] font-medium tracking-[0.04em] ${
            stamp.tone === "danger"
              ? "border-danger text-danger"
              : stamp.tone === "ok"
                ? "border-ok text-ok"
                : "border-warn text-warn"
          }`}
        >
          {stamp.text}
        </p>
      ) : null}

      <p className="mono text-[10px] leading-[1.6] tracking-[-0.03em] break-words text-ink-3">
        {filedSummary(lastFiled)}
      </p>
      {severities === "" ? (
        <p className="mono text-[9.5px] tracking-[-0.03em] text-muted">
          {count.value} {count.noun} · {formatAgo(lastFiled.createdAt)}
        </p>
      ) : (
        <p className="mono text-[9.5px] tracking-[-0.03em] text-danger">{severities}</p>
      )}

      <Link
        href={`/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(lastFiled.runId)}`}
        data-live-open
        className="mono mt-0.5 text-[9.5px] tracking-[0.04em] text-accent transition-colors duration-[180ms] hover:text-accent-hover"
      >
        OPEN RESULT ↗
      </Link>
    </section>
  );
}

/**
 * The 2px rule with the 6×8px ink nib riding its right edge.
 *
 * `transition` rather than an animation, so a bar that jumps a phase slides there over .9s and a
 * bar that does not move stays perfectly still — handoff § Motion, "nothing else moves".
 */
export function ProgressRule({ fraction, className = "" }: { fraction: number; className?: string }) {
  const pct = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  return (
    <div
      role="progressbar"
      aria-label="Task progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(1, Math.max(0, fraction)) * 100)}
      className={`relative h-0.5 bg-line ${className}`}
    >
      <div
        style={{ width: pct }}
        // Accent fill, ink nib — the artboard's own pair (02's `barStyle` is #b4531f, `nibStyle`
        // #17150f), and what the 04d console rule in live-log.tsx already draws. An ink fill made
        // the nib invisible against the bar it rides.
        className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-[900ms] ease-linear motion-reduce:transition-none"
      />
      <div
        aria-hidden
        style={{ left: `calc(${pct} - 3px)` }}
        className="absolute top-[-3px] h-2 w-1.5 bg-fg transition-[left] duration-[900ms] ease-linear motion-reduce:transition-none"
      />
    </div>
  );
}

function LogBlock() {
  const { lines } = useLiveRun();
  const shown = lines.slice(-4);

  return (
    <section className="flex flex-col gap-[9px] border-t border-line pt-[18px]">
      <h2 className="mono text-[9.5px] font-medium tracking-[0.14em] text-ink-3">LOG</h2>
      {shown.length === 0 ? (
        <p className="mono text-[9px] leading-[1.6] tracking-[-0.04em] text-muted">no output yet</p>
      ) : (
        shown.map((line) => (
          <p
            key={line.id}
            className="anim-rise mono truncate text-[9px] leading-[1.6] tracking-[-0.04em] text-muted"
            title={line.text}
          >
            {line.text}
          </p>
        ))
      )}
      <span aria-hidden className="anim-caret h-[11px] w-[5px] bg-accent" />
    </section>
  );
}

function WeekBlock({ week }: { week: WeekSummary }) {
  const rows: { label: string; value: string; tone?: string }[] = [
    { label: "runs", value: String(week.runs) },
    { label: "last test", value: week.lastTest ?? "—" },
    {
      label: "last review",
      value: week.lastReview ?? "—",
      tone: week.lastReview === "CHANGES" ? "text-danger" : week.lastReview === "APPROVE" ? "text-ok" : undefined,
    },
    {
      label: "design loop",
      value: week.lastDesign ?? "—",
      tone: week.lastDesign === "AWAITING" ? "text-warn" : undefined,
    },
  ];

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-[18px]">
      <h2 className="mono text-[9.5px] font-medium tracking-[0.14em] text-ink-3">THIS WEEK</h2>
      <dl className="flex flex-col gap-[7px]">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="mono text-[9.5px] tracking-[-0.03em] text-ink-2">{row.label}</dt>
            <dd className={`mono text-[9.5px] tracking-[-0.03em] ${row.tone ?? "text-fg"}`}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
