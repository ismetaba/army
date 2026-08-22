import type { Finding, Severity } from "@shared/schemas";
import { CopyButton } from "@/components/ledger/chrome";
import { SEVERITY_INK, SEVERITY_MARK } from "@/components/verdict";
import { commandText, machineText } from "@/lib/untrusted";

/*
 * One reviewer finding, as the card that sits INLINE UNDER the diff row it names (handoff § 04a).
 *
 * Presentational — the only interactive thing on it is COPY, which is the shared client button
 * from `ledger/chrome`, so this file itself is server-renderable and ships no JS of its own.
 *
 * Every string on the card (`title`, `risk`, `fix`, `file`) is agent-written and therefore
 * untrusted (SPEC § Dashboard security invariants #3). All four are JSX text children, so React
 * escapes them: a finding whose title is `<script>…` renders as visible characters and cannot
 * execute. Nothing here builds a link or a fetch out of them.
 */

/**
 * The card's own tint.
 *
 * The reference draws the (MAJOR) example on a rose card; painting a NIT the same colour would be
 * exactly the "learn to ignore red" failure the report tab's severity notes warn about, so the
 * tint follows the severity and the mark + word carry the meaning either way.
 */
const CARD_TINT: Record<Severity, string> = {
  BLOCKER: "bg-danger-tint",
  MAJOR: "bg-danger-tint",
  MINOR: "bg-warn-tint",
  NIT: "bg-surface-2",
};

/** The severity mark and its word — never a bare coloured square (handoff § Accessibility). */
export function SeverityLine({
  severity,
  className = "",
}: {
  severity: Severity;
  className?: string;
}) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-2 ${SEVERITY_INK[severity]} ${className}`}>
      <span className={`mark ${SEVERITY_MARK[severity]}`} aria-hidden />
      <span className="statusword">{severity}</span>
    </span>
  );
}

export function FindingCard({
  finding,
  domId,
  focused = false,
}: {
  finding: Finding;
  /** The anchor the jump-list scrolls to. Unique across the page. */
  domId: string;
  focused?: boolean;
}) {
  return (
    <article
      id={domId}
      data-finding-card={finding.severity}
      // `scroll-mt-16` keeps the card clear of the top of the diff panel when it is scrolled to.
      className={`flex min-w-0 scroll-mt-16 flex-col gap-3 border border-rule-2 px-[18px] py-4 ${
        CARD_TINT[finding.severity]
      } ${focused ? "outline outline-2 -outline-offset-2 outline-accent" : ""}`}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <SeverityLine severity={finding.severity} />
        {/* `machineText`: a path is the thing the reader is going to open, and a U+202E in it makes
            the card name one file while the manifest names another. React escapes markup; it does
            nothing about bidi overrides. */}
        <span className="mono min-w-0 text-[9px] break-all text-muted">
          {machineText(finding.file)}:{finding.line}
        </span>
      </header>

      <h4 className="min-w-0 text-[16px] font-semibold tracking-[-0.02em] break-words">
        {finding.title}
      </h4>

      {/* Label beside the prose where there is room, above it on a phone — a 34px label column
          plus a 58px card indent leaves a two-word-wide paragraph at 375. */}
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3">
        <span className="colhead shrink-0 sm:w-[34px] sm:pt-[3px]">risk</span>
        <p className="min-w-0 flex-1 text-[13px] leading-[1.6] break-words text-ink-2 [text-wrap:pretty]">
          {finding.risk}
        </p>
      </div>

      {/*
       * The fix is the thing you lift into an editor, so it is the copy block — and it is the
       * ONLY place the fix text appears, rather than prose plus a duplicate snippet. SPEC § Types
       * gives `Finding` a single `fix` string; there is no separate one-line snippet field to put
       * in the strip beside a paragraph, so the paragraph IS the strip.
       */}
      <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3">
        <span className="colhead shrink-0 sm:w-[34px] sm:pt-[3px]">fix</span>
        <div className="cmd-strip flex min-w-0 flex-1 items-start justify-between gap-3 px-3 py-2.5">
          {/* Styled as a command strip and copied like one, so it is scrubbed like one — the fix
              is the line a reader lifts into a terminal, and it is model-written. */}
          <p className="min-w-0 flex-1 text-[13px] leading-[1.6] break-words text-ink-2 [text-wrap:pretty]">
            {commandText(finding.fix)}
          </p>
          <CopyButton value={commandText(finding.fix)} what="the fix" />
        </div>
      </div>
    </article>
  );
}
