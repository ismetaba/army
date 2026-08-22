"use client";

/**
 * The entry screen's poll (handoff § State: "the panel polls or streams run status").
 *
 * The contents list is server-rendered from the store, and the store is a directory the CLI writes
 * to behind the panel's back — so without this the screen is a snapshot: a `RUNNING 1m12s` chip
 * counts up forever after the run has landed, and the `7 tasks · 5m ago` meta stays at whatever it
 * was when the page was opened. The ledger already had the equivalent (`ledger-view/live-run.tsx`)
 * and the pre-Ledger home page mounted `RunPoller` for exactly this; the entry screen was the one
 * place that ended up without one.
 *
 * Same shape as the ledger's, deliberately: poll `GET /api/runs` (no `ws` — the entry screen spans
 * every workspace, so a run started in one shows up while you are looking at another), compare a
 * digest of what the SERVER would render against the last poll, and call `router.refresh()` when it
 * changes. The list stays a server component with one idea of what a run is; this only decides
 * WHEN to re-read it. A duration ticking up is not in the digest, so an idle store never refreshes.
 *
 * Polling stops while the tab is hidden and takes an immediate reading when it comes back.
 */

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { RunManifest } from "@shared/schemas";

const POLL_MS = 5_000;

type RunRow = Pick<RunManifest, "runId" | "workspace" | "status">;

export function EntryPoller() {
  const router = useRouter();
  const digest = useRef<string>("");
  const polling = useRef(false);

  const tick = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const response = await fetch("/api/runs", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { runs?: RunRow[] };
      const runs = Array.isArray(body.runs) ? body.runs : [];
      const stamp = JSON.stringify(runs.map((r) => `${r.workspace}/${r.runId}:${r.status}`));
      if (digest.current !== "" && digest.current !== stamp) router.refresh();
      digest.current = stamp;
    } catch {
      // The next poll is five seconds away; a failed one is not worth a banner on the entry screen.
    } finally {
      polling.current = false;
    }
  }, [router]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    // The first reading is a task rather than part of the effect body, so the render is out of the
    // way before any state moves — the same pattern the ledger's poll uses.
    const immediate = setTimeout(() => void tick(), 0);
    const start = () => {
      if (timer === null) timer = setInterval(() => void tick(), POLL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void tick();
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(immediate);
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [tick]);

  return null;
}
