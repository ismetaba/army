import type { RunManifest, Severity } from "@shared/schemas";

/*
 * Status and severity are never colour-only (handoff § Accessibility): each is a 7px square
 * whose SHAPE carries the meaning — solid, hatched, hollow, dashed — always rendered next to its
 * word. These two components are the only place that pairing is defined, so it cannot drift.
 */

/** The panel's status vocabulary: the manifest's four, plus the design-loop-only "awaiting". */
export type LedgerStatus = RunManifest["status"] | "awaiting";

const STATUS_MARK: Record<LedgerStatus, string> = {
  running: "mark-running",
  done: "mark-done",
  error: "mark-error",
  cancelled: "mark-cancelled",
  awaiting: "mark-awaiting",
};

const STATUS_WORD: Record<LedgerStatus, string> = {
  running: "RUNNING",
  done: "DONE",
  error: "ERROR",
  cancelled: "CANCELLED",
  awaiting: "AWAITING FEEDBACK",
};

const STATUS_INK: Record<LedgerStatus, string> = {
  running: "text-accent",
  done: "text-ok",
  error: "text-danger",
  cancelled: "text-muted",
  awaiting: "text-warn",
};

export function StatusMark({ status, className = "" }: { status: LedgerStatus; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${STATUS_INK[status]} ${className}`}>
      <span className={`mark ${STATUS_MARK[status]}`} aria-hidden />
      <span className="statusword">{STATUS_WORD[status]}</span>
    </span>
  );
}

/** The mark alone — only for places that print the word themselves. */
export function StatusSquare({ status }: { status: LedgerStatus }) {
  return <span className={`mark ${STATUS_MARK[status]}`} aria-hidden />;
}

const SEVERITY_MARK: Record<Severity, string> = {
  BLOCKER: "mark-blocker",
  MAJOR: "mark-major",
  MINOR: "mark-minor",
  NIT: "mark-nit",
};

const SEVERITY_INK: Record<Severity, string> = {
  BLOCKER: "text-danger-deep",
  MAJOR: "text-danger",
  MINOR: "text-warn",
  NIT: "text-muted",
};

export function SeverityMark({
  severity,
  count,
  className = "",
}: {
  severity: Severity;
  count?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${SEVERITY_INK[severity]} ${className}`}>
      <span className={`mark ${SEVERITY_MARK[severity]}`} aria-hidden />
      <span className="statusword">{severity}</span>
      {count !== undefined && <span className="mono text-[9.5px]">{count}</span>}
    </span>
  );
}

export const severityInk = (s: Severity) => SEVERITY_INK[s];
export const statusInk = (s: LedgerStatus) => STATUS_INK[s];
export const statusWord = (s: LedgerStatus) => STATUS_WORD[s];
