import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButtonClient } from "./copy-button";
import { commandText } from "@/lib/untrusted";

/*
 * The furniture every Ledger screen is built from: top bars, section heads, command strips and
 * buttons. Rules do the work boxes normally do (handoff § Geometry) — a 2px ink rule under a
 * section head, 1px hairlines between rows — so there is no Card component here on purpose.
 */

/*
 * Entry-screen bar: product name left, the local address right, 1px rule under.
 * 16px/40px, matching the artboard — the handoff prose says 64px for the entry screen, but the
 * reference puts the bar and the body on the same 40px gutter so the brand lines up with
 * CONTENTS, and the artboard is the pixel authority.
 */
export function EntryTopBar() {
  return (
    <header className="flex h-12 items-center justify-between border-b border-line px-10">
      <span className="mono text-[10.5px] font-medium tracking-[0.16em] uppercase">
        agent-workflows
      </span>
      <span className="mono text-[9.5px] text-muted tracking-[0.12em] uppercase">
        local · 127.0.0.1:4400
      </span>
    </header>
  );
}

/** A 2px ink rule under a heading — the design's main structural device. */
export function SectionHead({
  title,
  aside,
  className = "",
}: {
  title: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="title-section">{title}</h2>
        {aside}
      </div>
      <div className="mt-2.5 h-0.5 bg-fg" />
    </div>
  );
}

/** A field label in small caps, sitting above its value or input. */
export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="label">{children}</div>;
}

/**
 * A monospace command in a tinted strip with a 3px ink left bar. COPY puts the string on the
 * clipboard exactly as it is shown — always this prop, never the rendered DOM.
 *
 * "Exactly as shown" is the whole contract, which is why the scrub happens ONCE, here, to the
 * string both the `<code>` and the button use: a command strip is a thing a human pastes into a
 * terminal, and parts of these commands come out of run manifests an agent wrote. C0/C1 controls
 * in them are ANSI sequences the terminal acts on when the command echoes — `shellQuote` makes the
 * shell treat the bytes as data and does nothing about what the terminal renders. Bidi overrides
 * go with them, so what you read is what lands on the clipboard.
 *
 * Evidence blocks are deliberately NOT this component (see `Verbatim` in report-cases.tsx): being
 * able to see the exact bytes a server returned is the point of those, and nobody pastes them into
 * a shell.
 */
export function CommandStrip({
  command,
  onCopyLabel = "COPY",
  action,
  className = "",
}: {
  command: string;
  onCopyLabel?: string;
  action?: ReactNode;
  className?: string;
}) {
  const safe = commandText(command);
  return (
    <div className={`cmd-strip flex items-start justify-between gap-4 px-3.5 py-2.5 ${className}`}>
      <code className="mono min-w-0 flex-1 overflow-x-auto whitespace-pre text-[10.5px] leading-[1.7]">
        {safe}
      </code>
      {action ?? <CopyButton value={safe} label={onCopyLabel} what="the command" />}
    </div>
  );
}

/** Client-side copy button, kept here so every COPY in the panel behaves identically. */
export function CopyButton({
  value,
  label = "COPY",
  what,
}: {
  value: string;
  label?: string;
  /** What is being copied, for the accessible name. The VALUE never goes in there — see below. */
  what?: string;
}) {
  return <CopyButtonClient value={value} label={label} what={what} />;
}

/*
 * The three buttons and the back link all carry `.tap`: below 900px every one of them is at least
 * 44px tall (handoff § Accessibility), and above it they are exactly the height the artboards draw.
 * Doing it here rather than at each call site is the point — a 10px mono label is a 16px target,
 * and there are dozens of them.
 */

/** Primary action: ink fill, mono label. */
export function PrimaryButton({
  children,
  accent = false,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { accent?: boolean }) {
  return (
    <button
      {...rest}
      className={`btnlabel tap px-4 py-2 text-bg transition-colors duration-[180ms] disabled:opacity-40 ${
        accent ? "bg-accent hover:bg-accent-hover" : "bg-fg hover:bg-ink-2"
      } ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** Secondary action: 1px outline. `danger` fills red on hover (used by cancel / delete). */
export function OutlineButton({
  children,
  danger = false,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...rest}
      className={`btnlabel tap border px-4 py-2 transition-colors duration-[180ms] disabled:opacity-40 ${
        danger
          ? "border-danger text-danger hover:bg-danger hover:text-bg"
          : "border-rule-2 text-ink-2 hover:border-fg hover:text-fg"
      } ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** A quiet text action (CANCEL, ← BACK, ARCH / DEL). */
export function QuietButton({
  children,
  danger = false,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...rest}
      className={`btnlabel tap text-ink-3 transition-colors duration-[180ms] ${
        danger ? "hover:text-danger" : "hover:text-fg"
      } ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** A back link in the top bar: `← LEDGER`, `← WORKSPACES`. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="btnlabel tap text-ink-3 transition-colors duration-[180ms] hover:text-fg"
    >
      {children}
    </Link>
  );
}

/** The dotted leader that fills the gap in a contents row. */
export function Leader() {
  return <span className="leader" aria-hidden />;
}
