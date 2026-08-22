"use client";

import { useEffect, useState } from "react";
import { formatElapsed } from "./model";

/**
 * The DUR cell of the running row — the one value in a server-rendered table that has to move.
 *
 * Computed from `startedAt` on every tick rather than incremented, so a tab that was backgrounded
 * for ten minutes shows ten minutes when it comes back instead of the handful of ticks it was
 * awake for.
 */
export function RunningClock({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // A task, not the effect body: a synchronous `setState` in an effect is a cascading render.
    const immediate = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(timer);
    };
  }, []);

  const started = new Date(startedAt).getTime();
  if (now === null || Number.isNaN(started)) return <span className="tabular-nums">—</span>;
  return <span className="tabular-nums">{formatElapsed((now - started) / 1000)}</span>;
}
