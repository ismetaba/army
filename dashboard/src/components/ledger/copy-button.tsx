"use client";

import { useEffect, useState } from "react";

/**
 * Copies the exact string it was handed — never a DOM selection, so what lands on the clipboard
 * is byte-for-byte the command/evidence shown next to it (handoff § Interactions).
 */
export function CopyButtonClient({ value, label = "COPY" }: { value: string; label?: string }) {
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
      className="btnlabel flex-none text-accent transition-colors duration-[180ms] hover:text-accent-hover"
      aria-label={`Copy: ${value}`}
    >
      {copied ? "COPIED" : label}
    </button>
  );
}
