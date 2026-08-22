import type { RunStatus } from "@/lib/store";

/**
 * Run status pill. Colours are fixed by T17 step 4: running=blue, done=green, error=red,
 * cancelled=gray — and they come from the theme variables, so the pill stays legible in dark
 * mode instead of being a bright chip on a dark card.
 *
 * The class strings are written out in full because Tailwind only ships classes it can see in
 * the source; a template literal like `bg-${status}-bg` would compile to nothing.
 */
const STYLES: Record<RunStatus, string> = {
  running: "bg-running-bg text-running-fg",
  done: "bg-done-bg text-done-fg",
  error: "bg-error-bg text-error-fg",
  cancelled: "bg-cancelled-bg text-cancelled-fg",
};

export function StatusBadge({ status, className = "" }: { status: RunStatus; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[status]} ${className}`}
    >
      {status === "running" ? (
        // T22 step 3 asks for a spinner in every run table, and it earns its place: it is what
        // tells you at a glance that a run is still being written to while you are looking at it.
        // A rotating ring rather than the pulsing dot this was: a pulse reads as "highlighted",
        // a spinner reads as "working", and the difference matters on a page where three of the
        // four statuses are also coloured pills.
        <span
          data-running-spinner
          className="size-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent"
          aria-hidden
        />
      ) : null}
      {status}
    </span>
  );
}
