import Link from "next/link";
import { notFound } from "next/navigation";
import { AwConfig } from "@shared/schemas";
import { awHome, listWorkspaceSummaries, readConfigFile } from "@/lib/store";
import { configRuleIssues, mergeIssues, toFieldIssues } from "@/lib/config-patch";
import { ConfigForm } from "./config-form";
import { WorkspaceRegistry } from "./workspace-registry";

/**
 * `/settings` — the workspace's `aw.config.json` and the registry that points at it (T21).
 *
 * `force-dynamic`, like every other route in the panel: the config is a file on disk that `aw
 * init` and a text editor also write, so a cached render would show a stale form and the natural
 * fix (reload) would not work.
 *
 * The page reads the config on the SERVER and hands the raw JSON to a client form. It does not
 * fetch `/api/config` to draw itself: the first paint should never depend on a round trip to the
 * same process that just rendered it, and the GET route exists for the form's "Reload from disk".
 *
 * A workspace whose config is missing or unreadable renders the reason and the path instead of
 * the form. That is the state right after someone deletes `aw.config.json`, and the panel saying
 * "run aw init here" is more useful than an empty form that would happily write a new file into a
 * repo that never asked for one.
 */
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const summaries = listWorkspaceSummaries();
  // Only a registered, usable workspace has an `aw.config.json` the panel can find: the config
  // lives at `<repoRoot>/aw.config.json` and `repoRoot` comes from the registry.
  const configurable = summaries.filter((w) => w.registered && w.usable);

  const requested = first((await searchParams).ws);
  // A `?ws=` naming a workspace that is not registered is an ERROR, not a hint. Falling back to
  // the first workspace rendered someone else's `aw.config.json` in an editable form, and Save
  // then wrote to that other repo — with only the active tab and the path in the footer to say
  // the URL had been ignored. Every other route in the panel refuses an unknown name outright:
  // `/ws/[ws]` calls `notFound()`, `/api/config` answers 404. This one now does too.
  if (requested !== undefined && !configurable.some((w) => w.name === requested)) {
    notFound();
  }
  const selected =
    configurable.find((w) => w.name === requested)?.name ?? configurable[0]?.name ?? null;

  const read = selected === null ? null : readConfigFile(selected);
  const parsed = read?.ok === true ? AwConfig.safeParse(read.data) : null;
  const issues =
    read?.ok === true
      ? mergeIssues(
          configRuleIssues(read.data),
          parsed?.success === false ? toFieldIssues(parsed.error.issues) : [],
        )
      : [];

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-muted">
          Per-workspace <span className="font-mono">aw.config.json</span>, and the registry in{" "}
          <span className="font-mono break-all">{awHome()}/workspaces.json</span>.
        </p>
      </header>

      {configurable.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          No registered workspace yet — register one below, or run{" "}
          <span className="font-mono">npx tsx src/cli.ts init</span> in a repo.
        </p>
      ) : (
        <>
          <nav
            className="flex min-w-0 flex-wrap items-center gap-2 text-sm"
            aria-label="Workspace settings"
          >
            {configurable.map((w) => {
              const active = w.name === selected;
              return (
                <Link
                  key={w.name}
                  href={`/settings?ws=${encodeURIComponent(w.name)}`}
                  aria-current={active ? "page" : undefined}
                  className={`rounded border px-3 py-1 transition-colors ${
                    active
                      ? "border-link bg-surface-2 font-medium text-fg"
                      : "border-line bg-surface text-muted hover:border-link hover:text-fg"
                  }`}
                >
                  {w.name}
                </Link>
              );
            })}
          </nav>

          {read === null || selected === null ? null : read.ok ? (
            <ConfigForm ws={selected} path={read.path} config={read.data} issues={issues} />
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
              <p className="text-sm text-error-fg">{read.message}</p>
              {read.path === null ? null : (
                <p className="font-mono text-xs break-all text-muted">{read.path}</p>
              )}
            </div>
          )}
        </>
      )}

      <WorkspaceRegistry
        workspaces={summaries.map((w) => ({
          name: w.name,
          repoRoot: w.repoRoot,
          runCount: w.runCount,
          archivedCount: w.archivedCount,
          registered: w.registered,
        }))}
      />
    </div>
  );
}
