"use client";

/**
 * The RUNNING PANE (Glass § 02) — the topmost pane of the workspace stack while a task is live.
 *
 * `pane-live`: the raised fill, the gold border, the big shadow — the ONE elevated pane per
 * screen. Header: haloed dot + `RUNNING NOW`, the task id in mono, the meta line, and `cancel
 * run` top-right. Then the metrics row (`ELAPSED` big, `TOOL CALLS` re-animating, and the
 * progress block over the striped bar), and a `plate` console holding the last five log lines
 * with a gold `▸` and a blinking caret at the tail.
 *
 * Every value here comes from the backend. The elapsed clock is computed from the run's
 * `startedAt`, the step and the progress rule are folded out of the run's own log (see
 * `progressOf` in `./model`), and the meta comes from the manifest — none of it is the design
 * reference's simulation timer.
 */

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveRun } from "./live-run";
import {
  filedStamp,
  filedSummary,
  formatElapsed,
  kindMeta,
  type LedgerRow,
  type WeekSummary,
} from "./model";

export function LiveAnnounce({ lastFiled }: { lastFiled: LedgerRow | null }) {
  const { run, elapsed } = useLiveRun();

  /*
   * The workspace's ONE polite live region (handoff § Accessibility). Throttled by its CONTENT,
   * not by a timer: the text is the elapsed time rounded to whole minutes, so the region's text
   * changes once a minute however often the clock behind it ticks.
   */
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

/** `cancel run` — coral tint that fills coral on hover. POSTs the pid this panel spawned. */
function CancelRun({ pid }: { pid: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pid }),
      });
      router.refresh();
    } catch {
      /* the pane keeps showing RUNNING; the next poll tells the truth */
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void cancel()}
      disabled={busy}
      data-live-cancel-run
      className="btnlabel tap rounded-[11px] border border-danger-line bg-danger-tint px-3.5 py-2 text-danger-ink transition-colors duration-[180ms] hover:bg-danger hover:text-accent-ink disabled:opacity-40"
    >
      {busy ? "cancelling…" : "cancel run"}
    </button>
  );
}

export function RunningPane({
  ws,
  runningRow,
}: {
  ws: string;
  /** The running row's manifest snapshot (meta: provider/model), when the server saw it. */
  runningRow: LedgerRow | null;
}) {
  const { run, elapsed, progress, lines } = useLiveRun();
  if (run === null) return null;

  const meta = [
    run.kind,
    runningRow !== null ? `${runningRow.provider} / ${runningRow.model}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const href =
    run.pid !== null
      ? `/ws/${encodeURIComponent(ws)}/live?pid=${run.pid}`
      : `/ws/${encodeURIComponent(ws)}/live?run=${encodeURIComponent(run.runId ?? "")}`;

  const shown = lines.slice(-5);
  const pct = Math.round(progress.fraction * 100);

  return (
    <section data-live-entry="running" className="pane-live flex min-w-0 flex-col gap-5 p-6 sm:px-7">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="flex items-center gap-2.5">
            <span aria-hidden className="mark mark-running" />
            <span className="mono text-[9.5px] font-medium tracking-[0.14em] text-accent uppercase">
              Running now
            </span>
          </span>
          <Link
            href={href}
            data-live-open
            className="mono min-w-0 truncate text-[13px] tracking-[-0.05em] text-fg transition-colors duration-[180ms] hover:text-accent"
          >
            {run.runId ?? `${kindMeta(run.kind).title.toLowerCase()} · pid ${run.pid}`}
          </Link>
          <span className="mono truncate text-[9.5px] tracking-[-0.03em] text-muted">{meta}</span>
        </div>
        {run.pid !== null ? (
          run.cancelRequested ? (
            <span className="mono text-[9.5px] tracking-[0.04em] text-danger-ink uppercase">
              cancelling…
            </span>
          ) : (
            <CancelRun pid={run.pid} />
          )
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-end gap-x-10 gap-y-4">
        <div className="flex flex-col gap-1">
          <span className="colhead">elapsed</span>
          <span className="text-[44px] leading-none font-bold tracking-[-0.05em] tabular-nums sm:text-[52px]">
            {elapsed === null ? "—" : formatElapsed(elapsed)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="colhead">tool calls</span>
          {/* `key` on the value replays the rise when the number changes (handoff § Motion). */}
          <span
            key={progress.tools}
            className="anim-flip text-[44px] leading-none font-bold tracking-[-0.05em] tabular-nums sm:text-[52px]"
          >
            {progress.tools}
          </span>
        </div>
        <div className="flex min-w-[220px] flex-1 flex-col gap-2">
          <span
            className="mono truncate text-[9.5px] tracking-[-0.03em] text-ink-3"
            title={progress.step}
          >
            {progress.step === "" ? "waiting for the first line…" : progress.step}
          </span>
          <div
            role="progressbar"
            aria-label="Task progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
          >
            <div
              style={{ width: `${pct}%` }}
              className="seep-bar h-full rounded-full transition-[width] duration-[900ms] ease-linear motion-reduce:transition-none"
            />
          </div>
          <span className="mono text-[9px] tracking-[-0.02em] text-ink-faint">{pct}% through the phases</span>
        </div>
      </div>

      <div className="plate flex min-h-[118px] min-w-0 flex-col justify-end gap-1 rounded-[14px] px-4 py-3.5">
        {shown.length === 0 ? (
          <p className="mono text-[10px] leading-[1.8] tracking-[-0.045em] text-ink-faint">
            no output yet
          </p>
        ) : (
          shown.map((line) => (
            <p
              key={line.id}
              className="anim-rise mono truncate text-[10px] leading-[1.8] tracking-[-0.045em] text-ink-3"
              title={line.text}
            >
              {line.text}
            </p>
          ))
        )}
        <p className="flex items-center gap-1.5">
          <span aria-hidden className="mono text-[10px] text-accent">
            ▸
          </span>
          <span aria-hidden className="anim-caret h-[11px] w-[5px] bg-accent" />
        </p>
      </div>
    </section>
  );
}

/**
 * The fraction-fed progress rule, kept for the stacked (≤900px) layout's in-progress card.
 * Glass shape: a soft dark track with the gold fill; no nib.
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
      className={`h-1 overflow-hidden rounded-full bg-surface-2 ${className}`}
    >
      <div
        style={{ width: pct }}
        className="seep-bar h-full rounded-full transition-[width] duration-[900ms] ease-linear motion-reduce:transition-none"
      />
    </div>
  );
}

/**
 * Kept export for the week summary type flow; the Glass workspace no longer renders a margin
 * column, so this only satisfies older imports during the transition.
 */
export type { WeekSummary };
