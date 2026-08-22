import Link from "next/link";
import { notFound } from "next/navigation";
import { listRuns, listWorkspaces, workspaceExists } from "@/lib/store";
import type { RunKind } from "@/lib/store";
import { RunTable } from "@/components/run-table";

export const dynamic = "force-dynamic";

const KINDS = ["review", "test-feature", "design-loop"] as const satisfies readonly RunKind[];

/** `?kind=` — anything not in the enum is treated as "no filter" rather than an error page. */
function parseKind(value: string | string[] | undefined): RunKind | null {
  const first = Array.isArray(value) ? value[0] : value;
  return KINDS.find((k) => k === first) ?? null;
}

export default async function WorkspacePage({ params, searchParams }: PageProps<"/ws/[ws]">) {
  const { ws } = await params;
  const kind = parseKind((await searchParams).kind);

  // `workspaceExists` covers both halves of "real": in workspaces.json, or has a runs directory.
  // A name that is neither — including a name that is not a legal directory segment — is a 404,
  // not an empty table pretending the workspace is fine.
  if (!workspaceExists(ws)) notFound();

  const entry = listWorkspaces().find((w) => w.name === ws);
  const all = listRuns(ws);
  const runs = kind === null ? all : all.filter((r) => r.kind === kind);
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
