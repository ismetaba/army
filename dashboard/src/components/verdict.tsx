import type { Severity, Verdict } from "@shared/schemas";

/*
 * The review verdict, in the two places it appears: at the top of the Result tab (handoff § 04a)
 * and on the finished running view the moment it lands (§ 04d-2).
 *
 * A plain presentational module — no hooks, no `node:` imports — so the server page and the two
 * client components that need it all import the same banner rather than each drawing its own.
 */

/** SPEC § Types, in descending order. This declaration order IS the sort and the filter order. */
export const SEVERITIES: readonly Severity[] = ["BLOCKER", "MAJOR", "MINOR", "NIT"];

export function severityRank(severity: Severity): number {
  const i = SEVERITIES.indexOf(severity);
  return i === -1 ? SEVERITIES.length : i;
}

/** The mark shape per severity — the same vocabulary `ledger/marks.tsx` defines for statuses. */
export const SEVERITY_MARK: Record<Severity, string> = {
  BLOCKER: "mark-blocker",
  MAJOR: "mark-major",
  MINOR: "mark-minor",
  NIT: "mark-nit",
};

export const SEVERITY_INK: Record<Severity, string> = {
  BLOCKER: "text-danger-deep",
  MAJOR: "text-danger",
  MINOR: "text-warn",
  NIT: "text-ink-2",
};

/**
 * The three verdicts and their marks. Written out rather than composed: Tailwind ships only the
 * class names it can literally see, and `text-${…}` would compile to nothing.
 */
const VERDICT_INK: Record<Verdict, string> = {
  APPROVE: "text-ok",
  "APPROVE WITH NITS": "text-warn",
  "REQUEST CHANGES": "text-danger",
};

const VERDICT_MARK: Record<Verdict, string> = {
  APPROVE: "mark-done",
  "APPROVE WITH NITS": "mark-awaiting",
  "REQUEST CHANGES": "mark-error",
};

const VERDICT_BAR: Record<Verdict, string> = {
  APPROVE: "border-ok bg-done-bg",
  "APPROVE WITH NITS": "border-warn bg-warn-tint",
  "REQUEST CHANGES": "border-danger bg-danger-tint",
};

export const VERDICTS: readonly Verdict[] = ["APPROVE", "APPROVE WITH NITS", "REQUEST CHANGES"];

export function countSeverities(
  findings: readonly { severity: Severity }[],
): Record<Severity, number> {
  const out: Record<Severity, number> = { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}

/** `6 findings (3 MAJOR, 1 MINOR, 2 NIT) across 3 changed files.` — the banner's second line. */
export function findingSummary(
  counts: Record<Severity, number>,
  fileCount: number | null,
): string {
  const total = SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
  const breakdown = SEVERITIES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");
  const head =
    total === 0 ? "No findings" : `${total} finding${total === 1 ? "" : "s"} (${breakdown})`;
  if (fileCount === null) return `${head}.`;
  return `${head} across ${fileCount} changed file${fileCount === 1 ? "" : "s"}.`;
}

/**
 * The verdict banner: a 4px left bar in the verdict's colour on its tint, the verdict itself at
 * `.title-verdict`, and the finding summary under it.
 *
 * `others` prints the two verdicts this run did NOT reach as small reference marks on the right
 * (handoff § 04a) — it is the legend for a vocabulary of three, shown where the vocabulary is
 * used. The compact variant (§ 04d-2) drops it and sets the verdict on one line with the summary.
 */
export function VerdictBanner({
  verdict,
  summary,
  compact = false,
  others = false,
}: {
  verdict: Verdict;
  summary: string;
  compact?: boolean;
  others?: boolean;
}) {
  return (
    <div
      data-verdict={verdict}
      className={`flex min-w-0 flex-wrap items-stretch gap-y-3 border-l-4 ${VERDICT_BAR[verdict]} ${
        compact ? "items-center gap-x-[18px] px-5 py-4" : "px-6 py-5"
      }`}
    >
      <div
        className={`flex min-w-0 flex-1 basis-[280px] gap-2 ${
          compact ? "flex-wrap items-baseline gap-x-[18px]" : "flex-col"
        }`}
      >
        <p
          className={`min-w-0 font-semibold tracking-[-0.03em] break-words ${VERDICT_INK[verdict]} ${
            compact ? "text-[22px]" : "title-verdict"
          }`}
        >
          {verdict}
        </p>
        <p className="min-w-0 text-[13.5px] leading-[1.6] text-ink-2 [text-wrap:pretty]">
          {summary}
        </p>
      </div>

      {others ? (
        <div className="flex shrink-0 flex-col justify-center gap-[7px] border-rule-2 pl-7 sm:border-l">
          <span className="colhead">other verdicts</span>
          {VERDICTS.filter((v) => v !== verdict).map((v) => (
            <span key={v} className={`inline-flex items-center gap-2 ${VERDICT_INK[v]}`}>
              <span className={`mark ${VERDICT_MARK[v]}`} aria-hidden />
              <span className="statusword text-[10px]">{v}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
