import path from "node:path";
import { notFound } from "next/navigation";
import { AwConfig } from "@shared/schemas";
import { awHome, listWorkspaceSummaries, readConfigFile } from "@/lib/store";
import { configRuleIssues, mergeIssues, toFieldIssues } from "@/lib/config-patch";
import { BackLink } from "@/components/ledger/chrome";
import { DangerCallout } from "@/components/settings/fields";
import { SectionIndex } from "@/components/settings/section-index";
import type { SectionEntry } from "@/components/settings/section-index";
import { WorkspaceSwitcher } from "@/components/settings/workspace-switcher";
import { ConfigForm } from "./config-form";
import { WorkspaceRegistry } from "./workspace-registry";

/**
 * `/settings` — handoff § 05: a 180px section index on the left and a max-860px content column,
 * with four ruled sections (defaults · agent overrides · app · workspace).
 *
 * `force-dynamic`, like every other route in the panel: the config is a file on disk that `aw
 * init` and a text editor also write, so a cached render would show a stale form and the natural
 * fix (reload) would not work.
 *
 * The page reads the config on the SERVER and hands the raw JSON to a client form. It does not
 * fetch `/api/config` to draw itself: the first paint should never depend on a round trip to the
 * same process that just rendered it, and the GET route exists for the form's "reload from disk".
 *
 * A workspace whose config is missing or unreadable renders the reason and the path instead of
 * the form. That is the state right after someone deletes `aw.config.json`, and the panel saying
 * "run aw init here" is more useful than an empty form that would happily write a new file into a
 * repo that never asked for one. The Workspace section is drawn either way — it is the section
 * that can register the repo that would fix it.
 *
 * The layout has no global chrome (see `layout.tsx`), so this screen carries its own top bar: the
 * back link to the ledger, the workspace switcher, the repo path, and `SETTINGS` underlined in
 * accent to say where you are.
 */
export const dynamic = "force-dynamic";

const SECTIONS: readonly SectionEntry[] = [
  { id: "defaults", label: "defaults" },
  { id: "agents", label: "agent overrides" },
  { id: "app", label: "app" },
  { id: "workspace", label: "workspace" },
];

/** The sections that only exist when a config could be read. */
const CONFIGLESS_SECTIONS: readonly SectionEntry[] = SECTIONS.filter((s) => s.id === "workspace");

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
  const currentSummary = configurable.find((w) => w.name === selected) ?? null;

  const read = selected === null ? null : readConfigFile(selected);
  const parsed = read?.ok === true ? AwConfig.safeParse(read.data) : null;
  const issues =
    read?.ok === true
      ? mergeIssues(
          configRuleIssues(read.data),
          parsed?.success === false ? toFieldIssues(parsed.error.issues) : [],
        )
      : [];

  const rows = summaries.map((w) => ({
    name: w.name,
    repoRoot: w.repoRoot,
    runCount: w.runCount,
    archivedCount: w.archivedCount,
    registered: w.registered,
  }));
  const currentRow = rows.find((w) => w.name === selected) ?? null;
  const hasForm = read?.ok === true && selected !== null;

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <header className="flex min-w-0 items-center justify-between gap-4 border-b border-line px-5 py-3.5 lg:px-10">
        <div className="flex min-w-0 items-center gap-4">
          <BackLink href={selected === null ? "/" : `/ws/${encodeURIComponent(selected)}`}>
            {selected === null ? "← workspaces" : "← ledger"}
          </BackLink>
          {selected === null ? null : (
            <WorkspaceSwitcher current={selected} workspaces={configurable.map((w) => w.name)} />
          )}
          <span className="mono hidden min-w-0 truncate text-[10px] text-muted md:block">
            {currentSummary?.repoRoot ?? awHome()}
          </span>
        </div>
        {/* Where you are: the accent underline, the same mark the ledger tabs use. */}
        <span className="btnlabel flex-none border-b-2 border-accent pb-[3px] text-fg">
          settings
        </span>
      </header>

      <div className="flex min-w-0 flex-col gap-8 px-5 py-8 lg:flex-row lg:gap-11 lg:px-10 lg:py-10">
        <SectionIndex entries={hasForm ? SECTIONS : CONFIGLESS_SECTIONS} />

        <div className="flex min-w-0 max-w-[860px] flex-1 flex-col gap-10">
          {read !== null && !read.ok ? (
            <DangerCallout role="alert">
              <p>{read.message}</p>
              {read.path === null ? null : (
                <p className="mono mt-1.5 text-[10.5px] break-all">{read.path}</p>
              )}
            </DangerCallout>
          ) : null}

          {hasForm && read?.ok === true && selected !== null ? (
            <ConfigForm ws={selected} path={read.path} config={read.data} issues={issues} />
          ) : null}

          <WorkspaceRegistry
            current={currentRow}
            workspaces={rows}
            registryPath={path.join(awHome(), "workspaces.json")}
          />
        </div>
      </div>
    </div>
  );
}
