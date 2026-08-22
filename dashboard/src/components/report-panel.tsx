/**
 * The Test-feature result (handoff § 04b) — the tester's verdict for one feature.
 *
 * SERVER COMPONENT. It reads the store (`node:fs` behind `@/lib/store`) for the raw report file
 * and for the feature history, then hands the case list to `ReportCases`, the only client
 * component here. Keeping the split means the filters and the failure drawer ship as JS while the
 * summary, the history list and a 6 kB report.md do not.
 *
 * Top to bottom, in decreasing order of urgency:
 *   1. the verification sentence, `PASS n/m`, the segment bar and the kind mix — the verdict,
 *      readable without scrolling (§ 04b);
 *   2. the case table, failures first, each row opening the exact request/response (§ 04b-2);
 *   3. feature history — the same feature's other runs, so a regression is visible run-over-run;
 *   4. the raw `report.md`, for when the structured view is not enough.
 *
 * 3 and 4 are not on the artboard. They are capabilities this tab already had and they are worth
 * more than a pixel-exact page, so they are kept — restyled as ruled sections under the table
 * rather than as the cards they used to be.
 */
import fs from "node:fs";
import Link from "next/link";
import { artifactHref, listRuns, resolveArtifact } from "@/lib/store";
import type { RunManifest } from "@/lib/store";
import { formatBytes } from "@/lib/format";
import { ReportCases } from "@/components/report-cases";
import { EmptyNote, RuledHead, clock, shortWhen } from "@/components/task-header";
import {
  countByKind,
  countByStatus,
  featureLabel,
  featureSlug,
  KIND_ORDER,
  type CaseCounts,
} from "@/components/report-data";

/**
 * How much of `artifacts/report.md` is rendered inline.
 *
 * A generated report is a few kilobytes; 512 kB is far past anything the qa-tester writes and
 * still small enough to hold in memory on every request of a `force-dynamic` page. Past it the
 * inline view truncates and points at `/api/artifact`, which streams the file instead.
 */
const RAW_REPORT_MAX_BYTES = 512 * 1024;

export function ReportPanel({ run }: { run: RunManifest }) {
  const test = run.test;
  const logHref = `/ws/${encodeURIComponent(run.workspace)}/run/${encodeURIComponent(run.runId)}?tab=log`;

  if (!test) {
    // Reachable only for a test-feature run that died before writing its result block — the tab
    // is shown for the kind, not for the presence of the data.
    return (
      <EmptyNote>
        This run has no test results in its <span className="mono">manifest.json</span>
        {run.status === "error" ? " — it ended in an error before the tester reported." : "."}
      </EmptyNote>
    );
  }

  const counts = countByStatus(test.cases);
  const kinds = countByKind(test.cases);
  const feature = featureLabel(run.input);

  return (
    <section className="flex min-w-0 flex-col gap-6" data-report-panel>
      <div className="flex min-w-0 flex-col gap-3.5">
        {/* The title IS the verification sentence — agent-written, rendered as text. */}
        <h2
          className="min-w-0 text-[22px] font-semibold tracking-[-0.025em] break-words"
          data-report-feature
        >
          {feature || <span className="text-muted">(the feature was not recorded)</span>}
        </h2>

        <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
          <span className="flex shrink-0 items-baseline gap-2.5" data-report-verdict>
            <span className="text-[26px] font-semibold tracking-[-0.03em]">
              {counts.total === 0 ? "NO CASES" : `PASS ${counts.PASS}/${counts.total}`}
            </span>
            {counts.FAIL > 0 ? (
              <span className="mono text-[12px] font-medium text-danger">— {counts.FAIL} FAIL</span>
            ) : null}
            {counts.SKIP > 0 ? (
              <span className="mono text-[12px] font-medium text-muted">— {counts.SKIP} SKIP</span>
            ) : null}
          </span>

          <SegmentBar counts={counts} />

          {counts.total > 0 ? (
            <span className="mono min-w-0 text-[9.5px] break-words text-ink-2">
              {KIND_ORDER.filter((k) => kinds[k] > 0)
                .map((k) => `${k} ${kinds[k]}`)
                .join(" · ")}
            </span>
          ) : null}
        </div>

        {test.summary.trim() !== "" ? (
          // `whitespace-pre-wrap`: the tester writes the summary as several sentences on their own
          // lines and the line breaks carry the structure.
          <p
            className="min-w-0 text-[13px] leading-[1.65] break-words whitespace-pre-wrap text-ink-2 [text-wrap:pretty]"
            data-report-summary
          >
            {test.summary}
          </p>
        ) : null}
      </div>

      {counts.total === 0 ? (
        <EmptyNote>
          The agent produced no cases —{" "}
          <Link href={logHref} className="text-accent underline hover:text-accent-hover">
            read the raw log
          </Link>
          .
        </EmptyNote>
      ) : (
        <ReportCases cases={test.cases} />
      )}

      <FeatureHistory run={run} />

      <RawReport run={run} relPath={test.reportArtifact} />
    </section>
  );
}

/**
 * One segment per case: solid green for a pass, dashed grey for a skip, red 45° hatch for a
 * failure (handoff § 04b — "a six-segment bar").
 *
 * Passes first so the failures land at the end where the eye stops, which is also the order the
 * artboard draws. It repeats what the counts above already say, so it is `aria-hidden` rather
 * than a second thing for a screen reader to read out.
 */
function SegmentBar({ counts }: { counts: CaseCounts }) {
  if (counts.total === 0) return null;
  const segments = [
    ...Array.from({ length: counts.PASS }, (_, i) => ({ key: `p${i}`, status: "PASS" as const })),
    ...Array.from({ length: counts.SKIP }, (_, i) => ({ key: `s${i}`, status: "SKIP" as const })),
    ...Array.from({ length: counts.FAIL }, (_, i) => ({ key: `f${i}`, status: "FAIL" as const })),
  ];

  return (
    <span className="flex min-w-0 shrink flex-wrap gap-[3px]" aria-hidden data-pass-rate-bar>
      {segments.map((s) => (
        <span
          key={s.key}
          data-segment={s.status}
          className={`h-2 w-11 max-w-full min-w-[10px] flex-none ${
            s.status === "PASS" ? "bg-ok" : s.status === "SKIP" ? "bg-muted" : ""
          }`}
          style={
            s.status === "FAIL"
              ? {
                  background:
                    "repeating-linear-gradient(45deg, var(--danger) 0 3px, var(--bg) 3px 6px)",
                }
              : undefined
          }
        />
      ))}
    </span>
  );
}

/**
 * Other `test-feature` runs of the same feature, in the same workspace.
 *
 * The whole point is run-over-run comparison, so the CURRENT run is listed too — marked, and not
 * a link to itself. A list that shows only the others makes you hold this run's numbers in your
 * head while you read theirs, which is exactly the moment a 15/16 gets misread as a 16/16.
 *
 * Matching is by slug (see `featureSlug`). A run whose slug comes out empty — no `input.feature`
 * and nothing quoted in `input.args` — matches nothing: grouping every unlabelled run together
 * would invent a "feature" out of missing data.
 */
function FeatureHistory({ run }: { run: RunManifest }) {
  const slug = featureSlug(run.input);
  const siblings =
    slug === ""
      ? []
      : listRuns(run.workspace).filter(
          (m) => m.kind === "test-feature" && featureSlug(m.input) === slug,
        );
  const others = siblings.filter((m) => m.runId !== run.runId);

  return (
    <section className="flex min-w-0 flex-col gap-3.5" data-feature-history>
      <RuledHead
        title="Feature history"
        aside={
          <span className="mono text-[9px] text-muted">
            {others.length === 0 ? "this run only" : `${siblings.length} runs of this feature`}
          </span>
        }
      />

      {others.length === 0 ? (
        <EmptyNote>
          No other <span className="mono">test-feature</span> run in workspace{" "}
          <span className="mono">{run.workspace}</span> covers this feature.
        </EmptyNote>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {siblings.map((m) => {
            const c = countByStatus(m.test?.cases ?? []);
            const current = m.runId === run.runId;
            return (
              <li
                key={m.runId}
                data-history-run={m.runId}
                className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line py-3 ${
                  current ? "bg-surface-2 px-3" : ""
                }`}
              >
                {current ? (
                  <span className="mono min-w-0 text-[10px] break-all">{m.runId}</span>
                ) : (
                  <Link
                    href={`/ws/${encodeURIComponent(m.workspace)}/run/${encodeURIComponent(m.runId)}`}
                    className="mono min-w-0 text-[10px] break-all text-accent hover:text-accent-hover"
                  >
                    {m.runId}
                  </Link>
                )}
                {current ? <span className="colhead shrink-0">this run</span> : null}
                <span className="mono shrink-0 text-[9px] text-muted">
                  {shortWhen(m.createdAt)} · {clock(m.durationMs)}
                </span>
                <span
                  data-history-counts
                  className={`mono ml-auto shrink-0 text-[9.5px] font-medium ${
                    !m.test ? "text-muted" : c.FAIL > 0 ? "text-danger" : "text-ok"
                  }`}
                >
                  {m.test ? `PASS ${c.PASS}/${c.total}${c.FAIL > 0 ? ` · ${c.FAIL} FAIL` : ""}` : "no result"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface RawReportFile {
  text: string;
  bytes: number;
  truncated: boolean;
  error: string | null;
}

/**
 * Read `artifacts/report.md` through the store's path confinement, bounded by bytes.
 *
 * `resolveArtifact` is the same gate `/api/artifact` uses: the manifest is agent-written, so the
 * path in it is untrusted input like any other, and a `report.md` symlinked at `/etc/passwd` must
 * not be rendered just because a manifest names it. Never throws — a missing or unreadable report
 * is a note in the panel, not a 500 on the run page.
 */
function readRawReport(run: RunManifest, relPath: string): RawReportFile | null {
  const artifact = resolveArtifact(run.workspace, run.runId, relPath);
  if (artifact === null) return null;
  try {
    const take = Math.min(artifact.size, RAW_REPORT_MAX_BYTES);
    const buf = Buffer.alloc(take);
    const fd = fs.openSync(artifact.absPath, "r");
    try {
      const read = fs.readSync(fd, buf, 0, take, 0);
      let text = buf.subarray(0, read).toString("utf8");
      const truncated = artifact.size > take;
      // A byte cut lands mid-line (and possibly mid-UTF-8-character); drop the partial tail — but
      // ONLY when there is a line boundary to cut back to. A report that is one very long line has
      // no `\n` in the first 512 kB, `lastIndexOf` returns -1, and `slice(0, 0)` would throw the
      // whole read away: an empty box under a notice claiming 512 kB is on screen.
      const cut = truncated ? text.lastIndexOf("\n") : -1;
      if (cut >= 0) text = text.slice(0, cut + 1);
      return { text, bytes: artifact.size, truncated, error: null };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // The errno, never `err.message`: Node puts the ABSOLUTE path in the message for EACCES,
    // EISDIR, ELOOP, ENAMETOOLONG and EIO, and SPEC § Dashboard security invariants #2 forbids an
    // error that names a real path.
    return {
      text: "",
      bytes: artifact.size,
      truncated: false,
      error: err instanceof Error && "code" in err ? String(err.code) : "read error",
    };
  }
}

/**
 * The raw report file, in a bordered scroll box.
 *
 * Rendering the markdown would mean `marked` + `DOMPurify`, and no new dependency is worth it
 * here — the file is already written to be read as text (headings, bullet lists, fenced
 * request/response blocks). It is shown monospace and soft-wrapped, with the fenced blocks
 * intact, which is what the reader came for.
 *
 * Wrapped in `<code>` for the same reason as the drawer's blocks: a leading newline directly after
 * `<pre>` is eaten by the HTML parser.
 */
function RawReport({ run, relPath }: { run: RunManifest; relPath: string }) {
  const file = readRawReport(run, relPath);

  return (
    <section className="flex min-w-0 flex-col gap-3.5" data-raw-report>
      <RuledHead
        title="Raw report"
        aside={
          <span className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3">
            <span className="mono min-w-0 text-[9px] break-all text-muted">{relPath}</span>
            {file !== null && file.error === null ? (
              <>
                <span className="mono shrink-0 text-[9px] text-muted">
                  {formatBytes(file.bytes)}
                </span>
                <a
                  href={artifactHref(run.workspace, run.runId, relPath)}
                  className="mono shrink-0 border-b border-accent text-[9.5px] text-accent hover:text-accent-hover"
                >
                  open raw
                </a>
              </>
            ) : null}
          </span>
        }
      />

      {file === null ? (
        <EmptyNote>The manifest names this file but the store does not have it.</EmptyNote>
      ) : file.error !== null ? (
        <EmptyNote>
          {relPath} could not be read ({file.error}).
        </EmptyNote>
      ) : (
        <>
          {file.truncated ? (
            <p className="mono text-[9.5px] text-muted">
              showing the first {formatBytes(RAW_REPORT_MAX_BYTES)} of {formatBytes(file.bytes)} —
              use “open raw” for the rest
            </p>
          ) : null}
          <pre className="mono max-h-[520px] min-w-0 overflow-auto border border-line bg-surface p-3.5 text-[10px] leading-[1.7] break-words whitespace-pre-wrap">
            <code>{file.text}</code>
          </pre>
        </>
      )}
    </section>
  );
}
