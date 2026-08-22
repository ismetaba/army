"use client";

/**
 * Who owns "the slip is open, on this kind".
 *
 * Three places start a task — the `START →` on each of the three kinds, the 375 layout's sticky
 * bottom bar, and (once it 409s) the "watch it" link inside the slip itself — and they sit in
 * different subtrees of the page. Hoisting the state into a provider is what lets the slip be
 * rendered ONCE, as a sibling of the whole screen, instead of once per trigger: three mounted
 * sheets would be three focus traps fighting over `document.activeElement`.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { CreateTaskSlip, type BackendHealth, type SlipDefaults } from "./create-task-slip";
import type { RunKind } from "./model";

interface Launcher {
  open: (kind: RunKind) => void;
  openKind: RunKind | null;
}

const LauncherContext = createContext<Launcher>({ open: () => {}, openKind: null });

export function useTaskLauncher(): Launcher {
  return useContext(LauncherContext);
}

export function TaskLauncherProvider({
  ws,
  defaults,
  backend,
  children,
}: {
  ws: string;
  defaults: SlipDefaults;
  backend: BackendHealth;
  children: React.ReactNode;
}) {
  const [openKind, setOpenKind] = useState<RunKind | null>(null);
  const open = useCallback((kind: RunKind) => setOpenKind(kind), []);
  const value = useMemo<Launcher>(() => ({ open, openKind }), [open, openKind]);

  return (
    <LauncherContext.Provider value={value}>
      {children}
      {openKind !== null ? (
        <CreateTaskSlip
          // Remounting per kind resets the draft, which is the right behaviour: `test-feature`'s
          // half-typed `desc` carried into `design-loop` as a `feature` would be a surprise.
          key={openKind}
          ws={ws}
          kind={openKind}
          defaults={defaults}
          backend={backend}
          onClose={() => setOpenKind(null)}
        />
      ) : null}
    </LauncherContext.Provider>
  );
}
