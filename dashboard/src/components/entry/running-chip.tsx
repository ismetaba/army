"use client";

import { useEffect, useState } from "react";
import { StatusSquare } from "@/components/ledger/marks";

/**
 * `RUNNING 1m12s` — the bordered accent chip that sits next to a workspace with a live task
 * (handoff § 01).
 *
 * The chip is a client component for one reason: the elapsed time. The handoff (§ State) asks for
 * it to be computed from `startedAt` on the client, and it has to be — a server-rendered clock is
 * wrong the second after it is sent, and this page is `force-dynamic`, so it would be a different
 * wrong number on every reload.
 *
 * The time is therefore rendered only AFTER mount. `Date.now()` on the server and `Date.now()` in
 * the browser are never the same value, so seeding the state with a time would hydrate with a
 * mismatch; starting at `null` means the first paint says `RUNNING` and the first tick fills the
 * clock in. The word — the part that carries the meaning — is there from the first byte, and the
 * square keeps the shape+word+colour pairing that § Accessibility requires.
 */
export function RunningChip({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // The first reading is a task rather than part of the effect body: setting state synchronously
    // there is a cascading render (and what `react-hooks/set-state-in-effect` is about). A
    // zero-delay timeout is the same "start the clock now" with the render out of the way — the
    // pattern `run-poller.tsx` already uses for its own first poll.
    const immediate = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(immediate);
      clearInterval(timer);
    };
  }, []);

  const time = elapsed(since, now);

  return (
    <span className="flex flex-none items-center gap-2 border border-accent px-[9px] py-1 text-accent">
      <StatusSquare status="running" />
      {/* `font-mono` + an explicit tracking rather than `.mono`: the design gives this chip +0.06em,
          and `.mono` is unlayered CSS, so its -0.045em would win over a Tailwind tracking utility. */}
      <span className="font-mono text-[9.5px] font-medium tracking-[0.06em]">
        {time === "" ? "RUNNING" : `RUNNING ${time}`}
      </span>
    </span>
  );
}

/** `44s`, `1m12s` — the design's compact form (§ 01 shows `RUNNING 1m12s`). */
function elapsed(since: string, now: number | null): string {
  if (now === null) return "";
  const started = new Date(since).getTime();
  if (Number.isNaN(started)) return "";
  const secs = Math.max(0, Math.round((now - started) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m${String(secs - mins * 60).padStart(2, "0")}s`;
}
