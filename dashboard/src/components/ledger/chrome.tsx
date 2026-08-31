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
 * Entry-screen bar (Glass § 01): a gold haloed dot + the product name, the local address in mono
 * on the right, over `chrome-fill` with a `chrome-rule` underline.
 */
export function EntryTopBar() {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-chrome-rule bg-chrome-fill px-8 py-3.5">
      <span className="flex items-center gap-2.5">
        <span aria-hidden className="mark mark-running" />
        <span className="text-[13.5px] font-semibold tracking-[-0.01em]">agent-workflows</span>
      </span>
      <span className="mono text-[10px] tracking-[-0.03em] text-ink-faint">127.0.0.1:4400</span>
    </header>
  );
}

/** A section head over a soft hairline — Glass panes are ruled by light, not by ink bars. */
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
      <div className="mt-2.5 h-px bg-line" />
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
      <span aria-hidden className="mono flex-none text-[10.5px] leading-[1.7] text-accent">
        $
      </span>
      <code className="mono min-w-0 flex-1 overflow-x-auto whitespace-pre text-[10.5px] leading-[1.7] text-ink-2">
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

/**
 * Primary action: the gold CTA — dark text on an accent fill, a lift + glow on hover.
 * `accent` is accepted for compatibility; in Glass EVERY primary action is the gold one.
 */
export function PrimaryButton({
  children,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept out of `rest` so it never lands on the DOM element
  accent = false,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { accent?: boolean }) {
  return (
    <button
      {...rest}
      className={`btnlabel tap rounded-[13px] bg-accent px-4 py-2 text-accent-ink transition-all duration-[180ms] hover:-translate-y-px hover:bg-accent-hover hover:shadow-[0_14px_28px_-14px_#e8b04b] disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** Secondary action: 1px strong outline. `danger` sits on a coral tint (cancel / delete). */
export function OutlineButton({
  children,
  danger = false,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return (
    <button
      {...rest}
      className={`btnlabel tap rounded-[11px] border px-4 py-2 transition-colors duration-[180ms] disabled:opacity-40 ${
        danger
          ? "border-danger-line bg-danger-tint text-danger-ink hover:bg-danger hover:text-accent-ink"
          : "border-rule-dotted text-ink-2 hover:border-fg hover:bg-fg hover:text-canvas"
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
