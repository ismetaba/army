import Link from "next/link";
import { listWorkspaceSummaries } from "@/lib/store";

/**
 * App name + workspace switcher (T17 step 5: "nothing fancy").
 *
 * It reads the workspace list itself rather than taking it as a prop, so every route gets the
 * switcher for free. No active-link highlight: knowing the current path in a layout needs a
 * client component, and one `"use client"` boundary in the header is not worth a subtle
 * underline — each page states which workspace it is showing in its own heading.
 */
export function SiteHeader() {
  // Only workspaces that HAVE a page: a registry name that is not a legal directory segment
  // cannot be one, and a switcher entry that 404s is worse than no entry. Home still shows it,
  // unlinked and with the reason.
  const workspaces = listWorkspaceSummaries().filter((w) => w.usable);

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-baseline gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="text-sm font-semibold tracking-tight text-fg hover:text-link">
          agent-workflows
          <span className="ml-2 font-normal text-muted">run panel</span>
        </Link>

        <nav className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          {workspaces.length === 0 ? (
            <span className="text-muted">no workspaces</span>
          ) : (
            workspaces.map((w) => (
              <Link
                key={w.name}
                href={`/ws/${encodeURIComponent(w.name)}`}
                className="text-link hover:underline"
              >
                {w.name}
                <span className="ml-1 text-xs text-muted">{w.runCount}</span>
              </Link>
            ))
          )}
        </nav>
      </div>
    </header>
  );
}
