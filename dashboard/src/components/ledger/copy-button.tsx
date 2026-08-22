"use client";

import { useEffect, useState } from "react";

/**
 * Copies the exact string it was handed — never a DOM selection, so what lands on the clipboard
 * is byte-for-byte the command/evidence shown next to it (handoff § Interactions).
 */
export function CopyButtonClient({
  value,
  label = "COPY",
  what,
}: {
  value: string;
  label?: string;
  /** What this button copies, for the accessible name — never the payload itself. */
  what?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
      className="btnlabel tap flex-none text-accent transition-colors duration-[180ms] hover:text-accent-hover"
      // The label names the button, it does not READ the payload. `value` is agent-written run
      // content and can be megabytes (a captured response body) — interpolating it here made the
      // button's accessible name the entire body, a second copy of it in the DOM and something a
      // screen reader would try to announce. The `<pre>`/`<code>` beside it is where the text is.
      aria-label={what === undefined ? "Copy" : `Copy ${what}`}
    >
      {copied ? "COPIED" : label}
    </button>
  );
}
