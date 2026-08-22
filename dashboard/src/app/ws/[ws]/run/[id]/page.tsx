import Link from "next/link";
import { notFound } from "next/navigation";
import { artifactHref, manifestArtifacts, readLogTail, readRun } from "@/lib/store";
import type { RunKind, RunManifest } from "@/lib/store";
import { formatBytes, formatDuration, formatWhen } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { ReportPanel } from "@/components/report-panel";
import { ReviewTab } from "@/components/review-tab";
import { DesignPanel } from "@/components/design-panel";

export const dynamic = "force-dynamic";

const LOG_TAIL_LINES = 500;

/**
 * The four tabs T17 step 4 fixes. Three of them are type-specific and were built by their own
 * task: Review → T18, Report → T19, Design → T20. Each is shown only for the run kind it
 * describes (a `review` run has no report); for every other kind it is a disabled label rather
 * than a link, so the tab bar stays the same shape on every run page.
 */
const TABS = [
  { id: "review", label: "Review", kind: "review" },
  { id: "report", label: "Report", kind: "test-feature" },
  { id: "design", label: "Design", kind: "design-loop" },
  { id: "log", label: "Log", kind: null },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Default tab is `log`, deliberately.
 *
 * The type tab of the run's own kind is now the obvious default — T18–T20 have all landed, so it
 * renders real content — but flipping it changes what every review and test-feature page opens
 * on, which is not T20's to change. Left as `log`, which is real content for every run of every
 * kind, including the ones that failed before producing a result block. `?tab=design` (and the
 * tab bar) reaches the type view.
 */
function parseTab(value: string | string[] | undefined, kind: RunKind): TabId {
  const first = Array.isArray(value) ? value[0] : value;
  const tab = TABS.find((t) => t.id === first);
  if (tab && (tab.kind === null || tab.kind === kind)) return tab.id;
  return "log";
}

export default async function RunPage({ params, searchParams }: PageProps<"/ws/[ws]/run/[id]">) {
  const { ws, id } = await params;
  const run = readRun(ws, id);
  if (run === null) notFound();

  const tab = parseTab((await searchParams).tab, run.kind);
  const visibleTabs = TABS.filter((t) => t.kind === null || t.kind === run.kind);

  return (
    <div className="flex flex-col gap-6">
      <RunHeader run={run} />

      <div className="flex flex-col gap-4">
        <nav
          className="flex min-w-0 flex-wrap items-center gap-1 border-b border-line"
          aria-label="Run views"
        >
          {TABS.map((t) => {
            const enabled = visibleTabs.includes(t);
            const active = enabled && t.id === tab;
            if (!enabled) {
              return (
                <span
                  key={t.id}
                  title={`${t.label} applies to ${t.kind} runs`}
                  className="cursor-default border-b-2 border-transparent px-3 py-2 text-sm text-muted opacity-40"
                >
                  {t.label}
                </span>
              );
            }
            return (
              <Link
                key={t.id}
                href={`/ws/${encodeURIComponent(ws)}/run/${encodeURIComponent(id)}?tab=${t.id}`}
                aria-current={active ? "page" : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  active
                    ? "border-link font-medium text-fg"
                    : "border-transparent text-muted hover:text-fg"
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>

        {tab === "log" ? (
          <LogPanel ws={ws} id={id} />
        ) : tab === "review" ? (
          // T18. `parseTab` has already proven this run's kind is `review`.
          <ReviewTab run={run} />
        ) : tab === "report" ? (
          // T19. `parseTab` has already proven this run's kind is `test-feature`.
          <ReportPanel run={run} />
        ) : (
          // T20. `parseTab` has already proven this run's kind is `design-loop`.
          <DesignPanel run={run} />
        )}
      </div>
    </div>
  );
}

function RunHeader({ run }: { run: RunManifest }) {
  const artifacts = manifestArtifacts(run);

  return (
    <header className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="font-mono text-base font-semibold break-all">{run.runId}</h1>
        <StatusBadge status={run.status} />
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Field label="workspace">
          <Link href={`/ws/${encodeURIComponent(run.workspace)}`} className="text-link hover:underline">
            {run.workspace}
          </Link>
        </Field>
        <Field label="kind">{run.kind}</Field>
        <Field label="agent">{run.agent}</Field>
        <Field label="provider / model">
          <span className="font-mono text-xs break-all">
            {run.provider}/{run.model}
          </span>
        </Field>
        <Field label="created">{formatWhen(run.createdAt)}</Field>
        <Field label="duration">{formatDuration(run.durationMs)}</Field>
        {run.input.base ? <Field label="base">{run.input.base}</Field> : null}
        {run.input.feature ? (
          <Field label="feature" className="lg:col-span-2">
            {run.input.feature}
          </Field>
        ) : null}
        {run.input.targetUrl ? (
          <Field label="target url">
            <span className="font-mono text-xs break-all">{run.input.targetUrl}</span>
          </Field>
        ) : null}
      </dl>

      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-muted">command</span>
        {/* `break-all` rather than a scroll box: the args line is the one thing you want to read
            in full, and it wraps happily. */}
        <code className="rounded bg-surface-2 px-2 py-1 font-mono text-xs break-all">
          {run.input.args}
        </code>
      </div>

      {artifacts.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted">artifacts</span>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {artifacts.map((a) =>
              a.present ? (
                // `break-all` on the label, not just `min-w-0` on the `<li>`: an artifact label is
                // agent-written run content (a design run's is `${screen} · ${viewport}`), and one
                // unbroken 300-character token made the whole PAGE scroll sideways — measured at
                // scrollWidth 2970 against a 1440 viewport. `min-w-0` lets the item shrink; only a
                // break opportunity lets the text inside it wrap.
                <li key={a.path} className="min-w-0">
                  <a
                    href={artifactHref(run.workspace, run.runId, a.path)}
                    className="break-all text-link hover:underline"
                    title={a.path}
                  >
                    {a.label}
                  </a>
                </li>
              ) : (
                // The manifest names it, the store does not have it. A link here would 404;
                // saying so is the whole message.
                <li key={a.path} className="min-w-0 text-muted" title={a.path}>
                  <span className="break-all line-through">{a.label}</span>
                  <span className="ml-1 text-xs">(file missing)</span>
                </li>
              ),
            )}
          </ul>
        </div>
      ) : null}

      {run.error ? (
        <div className="rounded border border-line bg-error-bg p-3 text-sm text-error-fg">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide">error</p>
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap">{run.error}</pre>
        </div>
      ) : null}
    </header>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${className}`}>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** The Log tab: the tail of the run's `log.txt`, exactly as the store wrote it. */
function LogPanel({ ws, id }: { ws: string; id: string }) {
  const log = readLogTail(ws, id, LOG_TAIL_LINES);

  if (!log.exists) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        This run has no <span className="font-mono">log.txt</span>.
      </p>
    );
  }

  // A log that exists but cannot be read is NOT a run without a log: saying so would send the
  // reader looking for a missing file that is sitting right there.
  if (log.error !== null) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        <span className="font-mono">log.txt</span> ({formatBytes(log.bytes)}) could not be read (
        {log.error}).
      </p>
    );
  }

  if (log.totalLines === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
        This run&rsquo;s <span className="font-mono">log.txt</span> is empty.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs text-muted">
        {log.totalLines === null
          ? `log.txt — last ${log.shownLines} lines of ${formatBytes(log.bytes)}`
          : log.truncated
            ? `log.txt — last ${log.shownLines} of ${log.totalLines} lines`
            : `log.txt — ${log.totalLines} ${log.totalLines === 1 ? "line" : "lines"}`}
      </p>
      {/* Both axes scroll INSIDE this box: log lines are long and there are hundreds of them, and
          neither should move the page. `whitespace-pre` (not `pre-wrap`) keeps the `[HH:mm:ss]`
          columns aligned. */}
      <pre className="max-h-[70vh] min-w-0 overflow-auto rounded-lg border border-line bg-surface p-3 font-mono text-xs leading-relaxed whitespace-pre">
        {log.text}
      </pre>
    </div>
  );
}
