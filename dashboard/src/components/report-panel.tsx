/**
 * The Report tab of a run page (T19) — the tester's findings for a `test-feature` run.
 *
 * SERVER COMPONENT. It reads the store (`node:fs` behind `@/lib/store`) for the raw report file
 * and for the feature history, then hands the case list to `ReportCases`, the only client
 * component in the tab. Keeping the split here means the filters and the drawer ship as JS while
 * the summary, the history list and a 6 kB report.md do not.
 *
 * Layout, top to bottom, is T19's own order and it is an order of decreasing urgency:
 *   1. summary + counts + pass-rate bar — the verdict, readable without scrolling;
 *   2. the case table, failures first, each row opening the exact request/response;
 *   3. feature history — the same feature's other runs, so a regression is visible run-over-run;
 *   4. the raw `report.md`, for when the structured view is not enough.
 */
import fs from "node:fs";
import Link from "next/link";
import { artifactHref, listRuns, resolveArtifact } from "@/lib/store";
import type { RunManifest } from "@/lib/store";
import { formatBytes, formatWhen } from "@/lib/format";
import { ReportCases } from "@/components/report-cases";
import {
  countByStatus,
  featureLabel,
  featureSlug,
  percent,
  verdictLine,
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
  if (!test) {
    // Reachable only for a test-feature run that died before writing its result block — the tab
    // itself is shown for the kind, not for the presence of the data.
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        This run has no test results in its <span className="font-mono">manifest.json</span>
        {run.status === "error" ? " — it ended in an error before the tester reported." : "."}
      </p>
    );
  }

  const counts = countByStatus(test.cases);

  return (
    <section className="flex min-w-0 flex-col gap-6" data-report-panel>
      <header className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Test report</h2>
          <p className="min-w-0 text-sm break-words" data-report-feature>
            {featureLabel(run.input) || <span className="text-muted">(feature not recorded)</span>}
          </p>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {/* Green means "something passed". A report with no cases at all is an UNKNOWN result,
              not a green one — `PASS 0/0` in the done colour reads as a clean run when in fact the
              tester produced nothing — so zero cases gets the neutral pair instead. */}
          <span
            className={`rounded-full px-2.5 py-1 text-sm font-semibold ${
              counts.total === 0
                ? "bg-cancelled-bg text-cancelled-fg"
                : counts.FAIL > 0
                  ? "bg-error-bg text-error-fg"
                  : "bg-done-bg text-done-fg"
            }`}
            data-report-verdict
          >
            {counts.total === 0 ? "no cases" : verdictLine(counts)}
          </span>
          <Count label="PASS" value={counts.PASS} className="bg-done-bg text-done-fg" />
          <Count label="FAIL" value={counts.FAIL} className="bg-error-bg text-error-fg" />
          <Count label="SKIP" value={counts.SKIP} className="bg-cancelled-bg text-cancelled-fg" />
        </div>

        <PassRateBar pass={counts.PASS} fail={counts.FAIL} skip={counts.SKIP} total={counts.total} />

        {/* `whitespace-pre-wrap`: the tester writes the summary as several sentences on their own
            lines and the line breaks carry the structure. */}
        <p
          className="min-w-0 text-sm leading-relaxed whitespace-pre-wrap break-words"
          data-report-summary
        >
          {test.summary}
        </p>
      </header>

      <ReportCases cases={test.cases} />

      <FeatureHistory run={run} />

      <RawReport run={run} relPath={test.reportArtifact} />
    </section>
  );
}

function Count({ label, value, className }: { label: string; value: number; className: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
      data-count={label}
    >
      <span className="tabular-nums">{value}</span>
      {label}
    </span>
  );
}

/**
 * PASS / FAIL / SKIP as one proportional bar.
 *
 * Three segments rather than a single "83%" fill: the question a reader has in front of a test
 * run is "how much of this is red", and a lone percentage answers it only if you also know the
 * total. The bar is `role="img"` with the counts as its label — it repeats what the pills above
 * say, so a screen reader that skips it loses nothing.
 */
function PassRateBar({
  pass,
  fail,
  skip,
  total,
}: {
  pass: number;
  fail: number;
  skip: number;
  total: number;
}) {
  if (total === 0) return null;
  const segments = [
    { key: "FAIL", value: fail, className: "bg-error-fg" },
    { key: "SKIP", value: skip, className: "bg-cancelled-fg" },
    { key: "PASS", value: pass, className: "bg-done-fg" },
  ].filter((s) => s.value > 0);

  return (
    <div
      role="img"
      aria-label={`${pass} passed, ${fail} failed, ${skip} skipped, of ${total} cases`}
      data-pass-rate-bar
      className="flex h-2 w-full min-w-0 overflow-hidden rounded-full bg-surface-2"
    >
      {segments.map((s) => (
        <div
          key={s.key}
          data-segment={s.key}
          title={`${s.value} ${s.key}`}
          className={s.className}
          style={{ width: `${percent(s.value, total)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Other `test-feature` runs of the same feature, in the same workspace (T19 step 2).
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
      : listRuns(run.workspace).filter((m) => m.kind === "test-feature" && featureSlug(m.input) === slug);
  const others = siblings.filter((m) => m.runId !== run.runId);

  return (
    <section className="flex min-w-0 flex-col gap-2" data-feature-history>
      <h3 className="text-xs uppercase tracking-wide text-muted">Feature history</h3>

      {others.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          No other <span className="font-mono">test-feature</span> run in workspace{" "}
          <span className="font-mono">{run.workspace}</span> covers this feature.
        </p>
      ) : (
        <ul className="min-w-0 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {siblings.map((m) => {
            const c = countByStatus(m.test?.cases ?? []);
            const current = m.runId === run.runId;
            return (
              <li
                key={m.runId}
                data-history-run={m.runId}
                className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm ${
                  current ? "bg-surface-2" : ""
                }`}
              >
                {current ? (
                  <span className="font-mono text-xs break-all text-fg">{m.runId}</span>
                ) : (
                  <Link
                    href={`/ws/${encodeURIComponent(m.workspace)}/run/${encodeURIComponent(m.runId)}?tab=report`}
                    className="font-mono text-xs break-all text-link hover:underline"
                  >
                    {m.runId}
                  </Link>
                )}
                {current ? (
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted ring-1 ring-line">
                    this run
                  </span>
                ) : null}
                <span className="text-xs text-muted">{formatWhen(m.createdAt)}</span>
                <span
                  data-history-counts
                  className={`ml-auto rounded-full px-2 py-0.5 text-xs font-medium ${
                    c.FAIL > 0 ? "bg-error-bg text-error-fg" : "bg-done-bg text-done-fg"
                  }`}
                >
                  {m.test ? verdictLine(c) : "no result"}
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
 * path in it is untrusted input like any other, and a `report.md` symlinked at `/etc/passwd`
 * must not be rendered just because a manifest names it. Never throws — a missing or unreadable
 * report is a note in the panel, not a 500 on the run page.
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
      // A byte cut lands mid-line (and possibly mid-UTF-8-character); drop the partial tail —
      // but ONLY when there is a line boundary to cut back to. A report that is one very long
      // line has no `\n` in the first 512 kB, `lastIndexOf` returns -1, and `slice(0, 0)` would
      // throw the whole read away: an empty box under a notice claiming 512 kB is on screen.
      const cut = truncated ? text.lastIndexOf("\n") : -1;
      if (cut >= 0) text = text.slice(0, cut + 1);
      return { text, bytes: artifact.size, truncated, error: null };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // The errno, never `err.message`: Node puts the ABSOLUTE path in the message for EACCES,
    // EISDIR, ELOOP, ENAMETOOLONG and EIO, and SPEC § Dashboard security invariants #2 forbids an
    // error that names a real path. The two branches above already name only the manifest-
    // relative path; this one now matches them.
    return {
      text: "",
      bytes: artifact.size,
      truncated: false,
      error: err instanceof Error && "code" in err ? String(err.code) : "read error",
    };
  }
}

/**
 * The raw report file, in a bordered `<pre>`.
 *
 * T19 step 1 asks the question and answers it: rendering the markdown would mean `marked` +
 * `DOMPurify`, and no new dependency is worth it here — the file is already written to be read
 * as text (headings, bullet lists, fenced request/response blocks). It is shown monospace and
 * soft-wrapped, with the fenced blocks intact, which is what the reader came for.
 *
 * Wrapped in `<code>` for the same reason as the drawer's blocks: a leading newline directly
 * after `<pre>` is eaten by the HTML parser.
 */
function RawReport({ run, relPath }: { run: RunManifest; relPath: string }) {
  const file = readRawReport(run, relPath);

  return (
    <section className="flex min-w-0 flex-col gap-2" data-raw-report>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-xs uppercase tracking-wide text-muted">Raw report</h3>
        <span className="font-mono text-xs break-all text-muted">{relPath}</span>
        {file !== null && file.error === null ? (
          <>
            <span className="text-xs text-muted">{formatBytes(file.bytes)}</span>
            <a
              href={artifactHref(run.workspace, run.runId, relPath)}
              className="text-xs text-link hover:underline"
            >
              open raw file
            </a>
          </>
        ) : null}
      </div>

      {file === null ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          The manifest names this file but the store does not have it.
        </p>
      ) : file.error !== null ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
          {relPath} could not be read ({file.error}).
        </p>
      ) : (
        <>
          {file.truncated ? (
            <p className="text-xs text-muted">
              Showing the first {formatBytes(RAW_REPORT_MAX_BYTES)} of {formatBytes(file.bytes)} —
              use “open raw file” for the rest.
            </p>
          ) : null}
          <pre className="max-h-[70vh] min-w-0 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
            <code>{file.text}</code>
          </pre>
        </>
      )}
    </section>
  );
}
