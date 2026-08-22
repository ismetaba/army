"use client";

import { useRouter } from "next/navigation";

/**
 * The top bar's workspace switcher (handoff § 02: "name + ▼ inside a 1px ink box"). Here it swaps
 * which workspace's `aw.config.json` the form is bound to, by navigating to `/settings?ws=` —
 * the page reads the config on the server, so the switch has to be a navigation and not a
 * client-side state change, or the form would show one workspace and Save would write another.
 *
 * The box takes the focus signal (`focus-within:border-accent`) because the native select's own
 * outline is suppressed along with its appearance.
 */
export function WorkspaceSwitcher({
  current,
  workspaces,
}: {
  current: string;
  workspaces: readonly string[];
}) {
  const router = useRouter();

  return (
    // The box carries the focus signal, written as an arbitrary property so it cannot lose a
    // same-layer cascade fight with the `border-fg` beside it (see FOCUS_RING in ./fields).
    <div className="relative inline-flex min-w-0 items-center border border-fg px-2.5 py-1.5 transition-colors duration-[180ms] focus-within:[border-color:var(--accent)]">
      <select
        aria-label="Workspace"
        value={current}
        onChange={(event) => router.push(`/settings?ws=${encodeURIComponent(event.target.value)}`)}
        className="mono min-w-0 appearance-none bg-transparent pr-4 text-[11px] font-medium text-fg outline-none"
      >
        {workspaces.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-2 text-[7px] text-ink-3">
        ▼
      </span>
    </div>
  );
}
