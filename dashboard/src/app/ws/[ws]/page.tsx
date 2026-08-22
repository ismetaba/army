import Link from "next/link";
import { notFound } from "next/navigation";
import { RUN_KINDS, listArchivedRuns, listRuns, listWorkspaces, workspaceExists } from "@/lib/store";
import type { RunKind } from "@/lib/store";
import { RunTable } from "@/components/run-table";
import { RunPoller } from "@/components/run-poller";
import { NewRunButton } from "@/components/new-run-modal";

export const dynamic = "force-dynamic";

/** Taken from the zod enum, so a new run kind gets its filter pill without an edit here. */
const KINDS = RUN_KINDS;

/**
 * How many runs the table shows before it stops. A workspace accumulates runs forever and the
 * page is uncached, so an unbounded table would grow into a multi-megabyte render on every
 * reload. `?limit=all` is the escape hatch when you really do want the whole list.
 */
const PAGE_LIMIT = 100;

/** `?kind=` — anything not in the enum is treated as "no filter" rather than an error page. */
function parseKind(value: string | string[] | undefined): RunKind | null {
  const first = Array.isArray(value) ? value[0] : value;
  return KINDS.find((k) => k === first) ?? null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `/ws/<ws>` with only the parameters that are actually set — no `?kind=&archived=` noise. */
function wsHref(ws: string, params: { kind?: RunKind | null; archived?: boolean; all?: boolean }): string {
  const q = new URLSearchParams();
  if (params.kind) q.set("kind", params.kind);
  if (params.archived) q.set("archived", "1");
  if (params.all) q.set("limit", "all");
  const query = q.toString();
  return `/ws/${encodeURIComponent(ws)}${query ? `?${query}` : ""}`;
}

export default async function WorkspacePage({ params, searchParams }: PageProps<"/ws/[ws]">) {
  const { ws } = await params;
  const query = await searchParams;
  const kind = parseKind(query.kind);
  const showAll = first(query.limit) === "all";
  // `?archived=1` (T21 step 3). Any other value is the normal view — a toggle should never be
  // able to produce a 404 or an error page, whatever ends up in the URL.
  const archived = first(query.archived) === "1";

  // `workspaceExists` covers both halves of "real": in workspaces.json, or has a runs directory.
  // A name that is neither — including a name that is not a legal directory segment — is a 404,
  // not an empty table pretending the workspace is fine.
  if (!workspaceExists(ws)) notFound();

  const entry = listWorkspaces().find((w) => w.name === ws);
  const activeRuns = listRuns(ws);
  const archivedRuns = listArchivedRuns(ws);
  const all = archived ? archivedRuns : activeRuns;
  const matching = kind === null ? all : all.filter((r) => r.kind === kind);
  const runs = showAll ? matching : matching.slice(0, PAGE_LIMIT);
  const counts = new Map<RunKind, number>(KINDS.map((k) => [k, all.filter((r) => r.kind === k).length]));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h1 className="text-lg font-semibold tracking-tight">{ws}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              href={`/settings?ws=${encodeURIComponent(ws)}`}
              className="text-sm text-link hover:underline"
            >
              settings
            </Link>
            {/* T22 step 3. Only for a REGISTERED workspace: the runner takes the child's cwd from
                `workspaces.json`, so a directory the registry has forgotten has no repo to run in
                and the button would only ever produce a 404. */}
            {entry === undefined ? null : <NewRunButton ws={ws} />}
          </div>
        </div>
        <p className="font-mono text-xs break-all text-muted">
          {entry?.repoRoot ?? "not registered in workspaces.json"}
        </p>
      </header>

      <RunPoller ws={ws} />

      {/* Two independent controls on one row: WHICH directory (runs/ or archive/) and WHICH kind.
          Both live in the URL, so a filtered archived view is a link someone can paste. */}
      <div className="flex min-w-0 flex-col gap-3">
        <nav className="flex min-w-0 flex-wrap items-center gap-2 text-sm" aria-label="Archived runs">
          <ToggleLink
            href={wsHref(ws, { kind })}
            active={!archived}
            label="active"
            count={activeRuns.length}
          />
          <ToggleLink
            href={wsHref(ws, { kind, archived: true })}
            active={archived}
            label="archived"
            count={archivedRuns.length}
          />
        </nav>

        <nav className="flex min-w-0 flex-wrap items-center gap-2 text-sm" aria-label="Filter by kind">
          <FilterLink
            href={wsHref(ws, { archived })}
            active={kind === null}
            label="all"
            count={all.length}
          />
          {KINDS.map((k) => (
            <FilterLink
              key={k}
              href={wsHref(ws, { kind: k, archived })}
              active={kind === k}
              label={k}
              count={counts.get(k) ?? 0}
            />
          ))}
        </nav>
      </div>

      {archived ? (
        <p className="text-xs text-muted">
          Archived runs live in <span className="font-mono">archive/</span> next to{" "}
          <span className="font-mono">runs/</span> in the store. The CLI and the run pages ignore
          them; Restore moves one back.
        </p>
      ) : null}

      <RunTable
        runs={runs}
        actions={archived ? "archive" : "runs"}
        linkRuns={!archived}
        empty={
          archived
            ? kind === null
              ? "Nothing archived in this workspace."
              : `No archived ${kind} runs in this workspace.`
            : kind === null
              ? "No runs in this workspace yet."
              : `No ${kind} runs in this workspace.`
        }
      />

      {runs.length < matching.length ? (
        <p className="text-xs text-muted">
          showing the newest {runs.length} of {matching.length} —{" "}
          <Link href={wsHref(ws, { kind, archived, all: true })} className="text-link hover:underline">
            show all
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The kind filter is plain links, not a client-side control: the filter belongs in the URL so it
 * survives a reload and can be pasted to someone else, and it keeps the whole route a server
 * component with no JavaScript of its own.
 */
function FilterLink({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full border px-3 py-1 transition-colors ${
        active
          ? "border-link bg-surface-2 font-medium text-fg"
          : "border-line bg-surface text-muted hover:border-link hover:text-fg"
      }`}
    >
      {label}
      <span className="ml-1.5 text-xs tabular-nums opacity-70">{count}</span>
    </Link>
  );
}

/** Same idea, squarer, so the two controls do not read as one row of eight pills. */
function ToggleLink({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded border px-3 py-1 transition-colors ${
        active
          ? "border-link bg-surface-2 font-medium text-fg"
          : "border-line bg-surface text-muted hover:border-link hover:text-fg"
      }`}
    >
      {label}
      <span className="ml-1.5 text-xs tabular-nums opacity-70">{count}</span>
    </Link>
  );
}
