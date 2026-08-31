/**
 * The workspace ledger's data shapes and the pure functions that derive display values from them.
 *
 * PURE — no `node:` imports, no fs, no React. It is imported by the server page (which reads the
 * store) AND by the client components under this directory (which never can), so everything the
 * two must agree on — what a row is, how a status is decided, how a duration is spelled — is
 * defined once here rather than twice in shapes that drift.
 *
 * The manifest is not passed around whole: `LedgerRow` is the slice the screen actually renders,
 * flattened on the server by `toLedgerRow` so a client component never receives a diff, a findings
 * array with its prose, or a test report. Less to serialise into the RSC payload, and the client
 * cannot start depending on fields the design does not show.
 */
import type { RunManifest, Severity, Verdict } from "@shared/schemas";
import { machineText } from "@/lib/untrusted";

export type RunKind = RunManifest["kind"];
export type RunStatus = RunManifest["status"];

/**
 * The panel's status vocabulary: the manifest's four plus `awaiting`.
 *
 * `awaiting` is not a manifest status and deliberately is not one — the CLI has no such state.
 * It is what a FINISHED design-loop means (handoff § 04c: the loop "stops for feedback on
 * purpose"), so it is derived here, in the one place both the table and the margin read.
 */
export type LedgerStatus = RunStatus | "awaiting";

export interface LedgerRow {
  runId: string;
  kind: RunKind;
  status: RunStatus;
  createdAt: string;
  /**
   * The TIME column's text, fixed on the SERVER at flatten time. Client components must render
   * this rather than call `formatClock` themselves: the same-day test depends on "now", and a
   * client render at hydration can disagree with the server's HTML (a page rendered at 23:59
   * hydrating at 00:00) — a React hydration error over a timestamp.
   */
  createdLabel: string;
  durationMs: number | null;
  provider: string;
  model: string;
  /** review */
  verdict: Verdict | null;
  findings: Severity[];
  /** How many distinct files the findings touch — the design's "across 3 files". */
  findingFiles: number;
  /** test-feature */
  passed: number | null;
  total: number | null;
  /** design-loop */
  screens: number | null;
  error: string | null;
  /**
   * The pid of the process this panel started for this run, when it is still going. `null` for a
   * finished run and for one started from a terminal — which is why WATCH falls back to `?run=`.
   */
  pid: number | null;
  /**
   * True for a `failedLaunchRow`: there is no run directory behind it, so its `runId` must not be
   * linked to the task page (404), and Archive/Delete can never succeed — the transcript at
   * `/live?pid=` is the only thing that exists for it.
   */
  launchFailed: boolean;
}

/**
 * A run the panel started that died BEFORE the CLI announced a run id — a refused provider, a
 * missing frontend URL, an unreadable config, a crash in the prelude.
 *
 * There is no manifest for these (the CLI exits before `startRun` creates one), so without this
 * they were invisible: the trigger answered 200, the ledger stayed exactly as it was, and the
 * only record was a file under `pending/`. "Nothing happened" is the one thing the panel must
 * never say when something did. The row carries the pid so WATCH can open the transcript, which
 * is where the reason is.
 */
export function failedLaunchRow(run: {
  pid: number;
  kind: RunKind;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
}): LedgerRow {
  const started = new Date(run.startedAt).getTime();
  const ended = run.endedAt === null ? null : new Date(run.endedAt).getTime();
  return {
    // Not a real run id — there is no run. It is the pid, so the row is stable and addressable.
    runId: `pid ${run.pid}`,
    kind: run.kind,
    status: run.exitSignal === null ? "error" : "cancelled",
    createdAt: run.startedAt,
    createdLabel: formatClock(run.startedAt),
    durationMs: ended === null ? null : Math.max(0, ended - started),
    provider: "—",
    model: "—",
    verdict: null,
    findings: [],
    findingFiles: 0,
    passed: null,
    total: null,
    screens: null,
    error:
      run.exitSignal !== null
        ? `stopped by ${run.exitSignal} before the run started`
        : `exited ${run.exitCode ?? "?"} before the run started — open the log for the reason`,
    pid: run.pid,
    launchFailed: true,
  };
}

/** Flatten one manifest into the row the screen renders. Server-side; `pid` comes from the runner. */
export function toLedgerRow(m: RunManifest, pid: number | null = null): LedgerRow {
  const findings = m.review?.findings ?? [];
  const cases = m.test?.cases ?? [];
  return {
    runId: m.runId,
    kind: m.kind,
    status: m.status,
    createdAt: m.createdAt,
    createdLabel: formatClock(m.createdAt),
    durationMs: m.durationMs ?? null,
    provider: m.provider,
    model: m.model,
    verdict: m.review?.verdict ?? null,
    findings: findings.map((f) => f.severity),
    findingFiles: new Set(findings.map((f) => f.file)).size,
    passed: m.test ? cases.filter((c) => c.status === "PASS").length : null,
    total: m.test ? cases.length : null,
    screens: m.design ? m.design.screens.length : null,
    error: m.error ?? null,
    pid,
    launchFailed: false,
  };
}

/**
 * The status a row is shown with.
 *
 * The only place `awaiting` is decided: a design-loop that finished and produced a result has
 * stopped for feedback rather than "completed", and showing it as a green DONE would tell the
 * reader nothing is waiting on them. Every other kind keeps the manifest's own word.
 */
export function ledgerStatus(row: Pick<LedgerRow, "kind" | "status" | "screens">): LedgerStatus {
  if (row.kind === "design-loop" && row.status === "done" && row.screens !== null) return "awaiting";
  return row.status;
}

/**
 * `/ws/<ws>` carrying only the filters that are actually set — no `?kind=&archived=` noise.
 *
 * The ledger's filters live in the URL rather than in component state, so a filtered archived view
 * survives a reload and is a link someone can paste. `ACTIVE`/`ARCHIVED` and the kind counts are
 * independent (handoff § Interactions), which is why both are carried through every href.
 */
export function wsHref(
  ws: string,
  params: { kind?: RunKind | null; archived?: boolean; all?: boolean } = {},
): string {
  const q = new URLSearchParams();
  if (params.kind) q.set("kind", params.kind);
  if (params.archived) q.set("archived", "1");
  if (params.all) q.set("limit", "all");
  const query = q.toString();
  return `/ws/${encodeURIComponent(ws)}${query ? `?${query}` : ""}`;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The TIME column: `09:44` for something filed today, `21 Aug` for anything older.
 *
 * Formatted by hand rather than through `toLocaleString`: the table is rendered on the SERVER and
 * shipped as HTML, so a locale-dependent string would change with the machine's environment and
 * disagree with the `YYYYMMDD-HHmmss` stamp already inside every run id.
 */
export function formatClock(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** `2m04s`, `0m09s` — the DUR column's shape in the design, minutes always present. */
export function formatDur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  return formatElapsed(Math.round(ms / 1000));
}

/** `1m12s` — the live clock, from whole seconds so it can tick without re-deriving a date. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
}

/** `2d ago` / `5m ago` — used under the switcher and in the margin. */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((now.getTime() - then) / 1000);
  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// the three kinds
// ---------------------------------------------------------------------------

export interface KindMeta {
  kind: RunKind;
  /** `01` / `02` / `03` — the ledger numbers the three kinds rather than carding them. */
  index: string;
  title: string;
  /** The one-liner on the "Start a task" row. */
  blurb: string;
  /** The longer sentence at the top of the slip. */
  description: string;
}

export const KINDS: readonly KindMeta[] = [
  {
    kind: "review",
    index: "01",
    title: "Review",
    blurb: "An AI reviews the branch diff like a strict senior engineer.",
    description:
      "An AI reviews the branch diff like a strict senior engineer, then pins each finding to the exact line.",
  },
  {
    kind: "test-feature",
    index: "02",
    title: "Test feature",
    blurb: "An AI black-box-tests the running backend.",
    description:
      "An AI black-box-tests the running backend and files a PASS/FAIL case report with the request and response behind every case.",
  },
  {
    kind: "design-loop",
    index: "03",
    title: "Design loop",
    blurb: "An AI implements UI, screenshots it, then stops for feedback.",
    description:
      "An AI implements the UI, screenshots it at mobile and desktop, optionally records a video, then stops and waits for your feedback.",
  },
];

export function kindMeta(kind: RunKind): KindMeta {
  return KINDS.find((k) => k.kind === kind) ?? KINDS[0]!;
}

/**
 * The severity line under a finished review: `3 MAJOR · 1 MINOR · 2 NIT`.
 * Empty severities are omitted, so an approved review shows nothing rather than four zeroes.
 */
export function severityLine(findings: readonly Severity[]): string {
  const order: Severity[] = ["BLOCKER", "MAJOR", "MINOR", "NIT"];
  return order
    .map((s) => ({ s, n: findings.filter((f) => f === s).length }))
    .filter((e) => e.n > 0)
    .map((e) => `${e.n} ${e.s}`)
    .join(" · ");
}

/**
 * The margin's headline number and its noun, per kind. One shape for three very different results:
 * findings for a review, cases for a test, screenshots for a design loop.
 */
export function resultCount(row: LedgerRow): { value: number; noun: string } {
  if (row.kind === "review") return { value: row.findings.length, noun: "findings" };
  if (row.kind === "test-feature") return { value: row.passed ?? 0, noun: `of ${row.total ?? 0} passing` };
  return { value: row.screens ?? 0, noun: "screenshots" };
}

/** The one-line summary in the JUST FILED block — the design's "6 findings across 3 files". */
/**
 * The one-line reason a run failed, for the ledger row beside its `ERROR` mark (handoff § Empty &
 * error states: "row status `ERROR` + one-line reason").
 *
 * `null` for anything that did not fail. The manifest's `error` is agent-written, so it is scrubbed
 * and folded onto ONE line here: a multi-line trace belongs on the detail page's LOG tab, and a row
 * that grows to eight lines stops being a row.
 */
export function failureReason(row: Pick<LedgerRow, "status" | "error">): string | null {
  if (row.status !== "error") return null;
  const text = machineText(row.error ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? "the run ended with an error" : text;
}

export function filedSummary(row: LedgerRow): string {
  if (row.status === "error") return row.error ?? "the run ended with an error";
  if (row.status === "cancelled") return "cancelled before it finished";
  if (row.kind === "review") {
    const n = row.findings.length;
    if (n === 0) return "no findings";
    return `${n} finding${n === 1 ? "" : "s"} across ${row.findingFiles} file${row.findingFiles === 1 ? "" : "s"}`;
  }
  if (row.kind === "test-feature") {
    if (row.total === null) return "no cases were produced";
    return `${row.passed}/${row.total} cases passing`;
  }
  const n = row.screens ?? 0;
  return n === 0 ? "no screenshots captured" : `${n} screenshot${n === 1 ? "" : "s"} captured`;
}

/**
 * The stamp over a finished run — the design's rotated `REQUEST CHANGES`.
 * `null` for a run with nothing to stamp (a cancelled one, a design loop with no verdict concept).
 */
export function filedStamp(row: LedgerRow): { text: string; tone: "danger" | "ok" | "warn" } | null {
  if (row.status === "error") return { text: "ERROR", tone: "danger" };
  if (row.status === "cancelled") return null;
  if (row.kind === "review" && row.verdict !== null) {
    if (row.verdict === "REQUEST CHANGES") return { text: "REQUEST CHANGES", tone: "danger" };
    if (row.verdict === "APPROVE WITH NITS") return { text: "APPROVE WITH NITS", tone: "warn" };
    return { text: "APPROVE", tone: "ok" };
  }
  if (row.kind === "test-feature" && row.total !== null) {
    const failed = row.total - (row.passed ?? 0);
    return failed > 0
      ? { text: `FAIL ${failed}`, tone: "danger" }
      : { text: `PASS ${row.total}/${row.total}`, tone: "ok" };
  }
  if (row.kind === "design-loop" && row.screens !== null) {
    return { text: "AWAITING FEEDBACK", tone: "warn" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// the week summary
// ---------------------------------------------------------------------------

export interface WeekSummary {
  runs: number;
  lastTest: string | null;
  lastReview: string | null;
  lastDesign: string | null;
}

/**
 * `THIS WEEK` in the left margin, computed from the runs the page already read.
 *
 * "This week" is the last seven days, not the calendar week: on a Monday morning a calendar week
 * would read `runs 0` for a workspace that ran all weekend.
 */
export function weekSummary(rows: readonly LedgerRow[], now: Date = new Date()): WeekSummary {
  const since = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const recent = rows.filter((r) => new Date(r.createdAt).getTime() >= since);
  const newest = (kind: RunKind) => rows.find((r) => r.kind === kind && r.status !== "running") ?? null;

  const test = newest("test-feature");
  const review = newest("review");
  const design = newest("design-loop");

  return {
    runs: recent.length,
    lastTest: test === null ? null : test.total === null ? "—" : `${test.passed}/${test.total}`,
    lastReview:
      review === null
        ? null
        : review.verdict === "REQUEST CHANGES"
          ? "CHANGES"
          : review.verdict === "APPROVE WITH NITS"
            ? "NITS"
            : review.verdict === "APPROVE"
              ? "APPROVE"
              : review.status.toUpperCase(),
    lastDesign: design === null ? null : ledgerStatus(design) === "awaiting" ? "AWAITING" : design.status.toUpperCase(),
  };
}

// ---------------------------------------------------------------------------
// the live run's progress
// ---------------------------------------------------------------------------

/**
 * How far along a running workflow is, read out of its own output.
 *
 * There is no progress percentage anywhere in the backend — a workflow is an agent session, not a
 * job with a step count — so this does NOT invent one from a clock the way the design reference's
 * simulation does. It recognises the PHASE MARKERS the workflows actually print
 * (`src/workflows/*.ts`, all of them through `log()`), and the bar sits at the phase the run has
 * reached:
 *
 *   [runner] …            the process was spawned                       6%
 *   reviewing / testing / session:   the model has been handed the work  28%
 *   [tool] …              the agent is working — creeps with the count   50→84%
 *   model finished in …   its answer is being parsed                     86%
 *   run saved: …          filed                                        100%
 *
 * Monotonic by construction (the bar never moves backwards) and honest when it is wrong: an
 * unrecognised run simply sits at the last phase it did recognise instead of pretending to advance.
 */
export interface Progress {
  fraction: number;
  /** `[tool]` lines seen — the only quantity in a run that actually counts up. */
  tools: number;
  /** The last non-empty line: what the run is doing right now, in its own words. */
  step: string;
}

export const NO_PROGRESS: Progress = { fraction: 0, tools: 0, step: "" };

const PHASE_START = 0.06;
const PHASE_HANDED_OVER = 0.28;
const PHASE_WORKING = 0.5;
const PHASE_WORKING_CEILING = 0.84;
const PHASE_PARSING = 0.86;

/**
 * Fold one log line into the progress state. A REDUCER rather than a scan over a buffer, because
 * the live view keeps only the last few lines in memory while the phase markers it depends on
 * arrived thousands of lines ago — folding as the bytes stream past is the only way both can be
 * true. `Math.max` everywhere is what makes the bar monotonic.
 */
export function advanceProgress(state: Progress, raw: string): Progress {
  const line = raw.trim();
  if (line === "") return state;

  let { fraction, tools } = state;
  if (line.startsWith("[runner] ")) fraction = Math.max(fraction, PHASE_START);
  else if (/^(reviewing|testing|session:)\b/.test(line)) fraction = Math.max(fraction, PHASE_HANDED_OVER);
  else if (line.startsWith("[tool] ")) {
    tools += 1;
    const creep = PHASE_WORKING + (PHASE_WORKING_CEILING - PHASE_WORKING) * (1 - 1 / (1 + tools / 12));
    fraction = Math.max(fraction, Math.min(PHASE_WORKING_CEILING, creep));
  } else if (line.startsWith("model finished in ")) fraction = Math.max(fraction, PHASE_PARSING);
  else if (line.startsWith("run saved: ")) fraction = 1;

  return { fraction, tools, step: line };
}

export function progressOf(lines: readonly string[]): Progress {
  return lines.reduce(advanceProgress, NO_PROGRESS);
}
