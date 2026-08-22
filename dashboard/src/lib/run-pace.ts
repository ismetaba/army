import { listRuns } from "@/lib/store";
import type { RunKind } from "@/lib/store";

/**
 * How long a run of this kind usually takes, in milliseconds — or `null`.
 *
 * SERVER ONLY (it reaches the store, which imports `node:fs`).
 *
 * The running view wants a progress rule (handoff § 04d) and an agent run has no progress signal:
 * it finishes when the model stops. The design reference fakes it on a 44-second timer, which the
 * handoff explicitly says not to port. This is the honest substitute — the median duration of the
 * runs this workspace has already finished of the same kind — and it is `null` rather than a
 * guess when there is no history, so the rule can stay an empty track instead of animating a
 * number nobody computed.
 *
 * The MEDIAN, not the mean: one run that hung for twenty minutes before a provider timed out
 * would otherwise pull the estimate so far out that the nib never visibly moves again.
 */
const SAMPLE = 10;

export function expectedRunMs(workspace: string, kind: RunKind): number | null {
  const durations = listRuns(workspace)
    .filter((r) => r.kind === kind && r.status === "done" && typeof r.durationMs === "number")
    .slice(0, SAMPLE) // `listRuns` is newest first, so this is the last ten of this kind
    .map((r) => r.durationMs as number)
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);

  if (durations.length === 0) return null;
  const middle = Math.floor(durations.length / 2);
  return durations.length % 2 === 1
    ? durations[middle]!
    : Math.round((durations[middle - 1]! + durations[middle]!) / 2);
}
