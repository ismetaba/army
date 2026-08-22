import Link from "next/link";
import { notFound } from "next/navigation";
import { RUN_KINDS, listRuns, listWorkspaces, workspaceExists } from "@/lib/store";
import type { RunKind } from "@/lib/store";
import { RunTable } from "@/components/run-table";

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

export default async function WorkspacePage({ params, searchParams }: PageProps<"/ws/[ws]">) {
  const { ws } = await params;
  const query = await searchParams;
  const kind = parseKind(query.kind);
  const limitParam = Array.isArray(query.limit) ? query.limit[0] : query.limit;
  const showAll = limitParam === "all";

  // `workspaceExists` covers both halves of "real": in workspaces.json, or has a runs directory.
  // A name that is neither — including a name that is not a legal directory segment — is a 404,
  // not an empty table pretending the workspace is fine.
  if (!workspaceExists(ws)) notFound();

  const entry = listWorkspaces().find((w) => w.name === ws);
  const all = listRuns(ws);
  const matching = kind === null ? all : all.filter((r) => r.kind === kind);
  const runs = showAll ? matching : matching.slice(0, PAGE_LIMIT);
  const counts = new Map<RunKind, number>(KINDS.map((k) => [k, all.filter((r) => r.kind === k).length]));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">{ws}</h1>
        <p className="font-mono text-xs break-all text-muted">
          {entry?.repoRoot ?? "not registered in workspaces.json"}
        </p>
      </header>

      <nav className="flex min-w-0 flex-wrap items-center gap-2 text-sm" aria-label="Filter by kind">
        <FilterLink ws={ws} kind={null} active={kind === null} label="all" count={all.length} />
        {KINDS.map((k) => (
          <FilterLink
            key={k}
            ws={ws}
            kind={k}
            active={kind === k}
            label={k}
            count={counts.get(k) ?? 0}
          />
        ))}
      </nav>

      <RunTable
        runs={runs}
        empty={kind === null ? "No runs in this workspace yet." : `No ${kind} runs in this workspace.`}
      />

      {runs.length < matching.length ? (
        <p className="text-xs text-muted">
          showing the newest {runs.length} of {matching.length} —{" "}
          <Link
            href={`/ws/${encodeURIComponent(ws)}?${kind === null ? "" : `kind=${kind}&`}limit=all`}
            className="text-link hover:underline"
          >
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
  ws,
  kind,
  active,
  label,
  count,
}: {
  ws: string;
  kind: RunKind | null;
  active: boolean;
  label: string;
  count: number;
}) {
  const href = kind === null ? `/ws/${encodeURIComponent(ws)}` : `/ws/${encodeURIComponent(ws)}?kind=${kind}`;
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
