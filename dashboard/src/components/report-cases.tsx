"use client";

/**
 * The case table and the failure drawer (handoff § 04b / § 04b-2).
 *
 * This is the one client component in the Test-feature result, and it is a client component for
 * exactly two reasons: the status/kind filters and the row → drawer interaction. Everything
 * static (title, counts, feature history, raw report) is rendered on the server in
 * `report-panel.tsx` and never enters this bundle.
 *
 * It imports `@shared/schemas` for TYPES ONLY. `@/lib/store` — which imports `node:fs` — must
 * never be reachable from here; the types are the only thing the two sides share.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { TestCase } from "@shared/schemas";
import type { CaseKind, CaseStatus } from "@/components/report-data";
import {
  KIND_ORDER,
  STATUS_ORDER,
  countByKind,
  countByStatus,
  sortCases,
} from "@/components/report-data";
import { CopyButton } from "@/components/ledger/chrome";
import { EmptyNote } from "@/components/task-header";
import { SEVERITY_INK } from "@/components/verdict";

type StatusFilter = CaseStatus | "all";
type KindFilter = CaseKind | "all";

/**
 * PASS / FAIL / SKIP as mark + word, never a coloured dot (handoff § Accessibility). The shapes
 * are the same vocabulary the run statuses use: solid for a pass, 45° hatch for a failure, a
 * dashed outline for something that never ran.
 */
const CASE_MARK: Record<CaseStatus, string> = {
  PASS: "mark-done",
  FAIL: "mark-error",
  SKIP: "mark-cancelled",
};

const CASE_INK: Record<CaseStatus, string> = {
  PASS: "text-ok",
  FAIL: "text-danger",
  SKIP: "text-muted",
};

/** The table's five columns, as one grid template shared by the head and every row. */
const GRID = "grid grid-cols-[70px_minmax(0,2.4fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.9fr)] gap-4";

export function ReportCases({ cases }: { cases: TestCase[] }) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  /**
   * The selected row is held by INDEX into the sorted list, not by `case.id`.
   *
   * Ids come out of the model (`c1`, `c2`, …) and nothing in the schema makes them unique — a
   * tester that repeats an id would otherwise open two rows at once, or the wrong one.
   */
  const [selected, setSelected] = useState<number | null>(null);

  const sorted = useMemo(() => sortCases(cases), [cases]);
  const statusCounts = useMemo(() => countByStatus(cases), [cases]);
  const kindCounts = useMemo(() => countByKind(cases), [cases]);

  const visible = useMemo(
    () =>
      sorted
        .map((c, index) => ({ c, index }))
        .filter(
          ({ c }) =>
            (status === "all" || c.status === status) && (kind === "all" || c.kind === kind),
        ),
    [sorted, status, kind],
  );

  /** Where the open case sits in the VISIBLE list — what `← PREV` / `NEXT →` page through. */
  const position = visible.findIndex((v) => v.index === selected);
  const openCase = selected === null ? null : (sorted[selected] ?? null);

  // The row that opened the drawer, so focus can go back to it on close — closing a dialog and
  // dumping focus on <body> loses a keyboard user's place in a sixteen-row table.
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    const trigger = triggerRef.current;
    triggerRef.current = null;
    /*
     * Focus the row BEFORE the drawer unmounts, not after.
     *
     * Order matters: if the drawer's Close button is still the focused element when React removes
     * it, the browser has already dropped focus on <body> by the time any callback of ours runs,
     * and a keyboard user is back at the top of the page. Moving focus out first means the element
     * being removed is not the focused one, so nothing is lost — and it needs no
     * `requestAnimationFrame`, which would not fire at all in a background tab.
     */
    trigger?.focus();
    setSelected(null);
  }, []);

  const step = useCallback(
    (delta: number) => {
      if (position < 0) return;
      const next = visible[position + delta];
      if (next !== undefined) setSelected(next.index);
    },
    [position, visible],
  );

  const open = (index: number, row: HTMLElement) => {
    const button = row.querySelector<HTMLButtonElement>("[data-case-open]");
    if (button !== null) {
      triggerRef.current = button;
      if (document.activeElement !== button) button.focus();
    }
    setSelected(index);
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" data-report-cases>
      <div className="flex min-w-0 flex-col gap-2">
        <FilterRow
          label="status"
          options={[
            { value: "all" as const, text: `all ${statusCounts.total}` },
            ...STATUS_ORDER.filter((s) => statusCounts[s] > 0).map((s) => ({
              value: s,
              text: `${s} ${statusCounts[s]}`,
            })),
          ]}
          value={status}
          onChange={setStatus}
        />
        <FilterRow
          label="kind"
          options={[
            { value: "all" as const, text: `all ${cases.length}` },
            ...KIND_ORDER.filter((k) => kindCounts[k] > 0).map((k) => ({
              value: k,
              text: `${k} ${kindCounts[k]}`,
            })),
          ]}
          value={kind}
          onChange={setKind}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyNote>
          {/* "no cases at all" and "no cases left after filtering" are different problems, and
              telling a reader to loosen filters they never set is the more annoying of the two. */}
          {cases.length === 0 ? "This report has no cases." : "No case matches these filters."}
        </EmptyNote>
      ) : (
        // Five columns do not fit a phone, so the TABLE scrolls sideways inside this box rather
        // than the page doing it (handoff § Interactions, the hard overflow rule). `min-w-0` on
        // the wrapper is what stops a flex parent from letting it push the body wide instead.
        <div className="min-w-0 overflow-x-auto">
          <div
            className="flex min-w-[620px] flex-col"
            role="table"
            aria-label="Test cases, failures first"
          >
            <div className={`${GRID} border-t-2 border-b border-fg border-b-line py-2.5`} role="row">
              {["case", "name", "kind", "status", "severity"].map((h) => (
                <span key={h} className="colhead" role="columnheader">
                  {h}
                </span>
              ))}
            </div>

            {visible.map(({ c, index }) => {
              const failing = c.status === "FAIL";
              return (
                <div
                  key={index}
                  role="row"
                  data-case-row={c.id}
                  data-status={c.status}
                  data-kind={c.kind}
                  /*
                   * The whole row is the hit target — the id cell and the FAIL mark are what a
                   * reader aims at, and they were dead. The BUTTON is still the accessible control:
                   * it is what a screen reader announces and what Enter/Space activate, and its
                   * click bubbles to here, so one handler serves mouse, keyboard and AT alike.
                   */
                  onClick={(e) => open(index, e.currentTarget)}
                  className={`${GRID} cursor-pointer items-center border-b border-line py-3.5 transition-colors duration-[180ms] ${
                    failing ? "bg-danger-tint pl-3 hover:brightness-[0.985]" : "hover:bg-paper-hover"
                  } ${selected === index ? "outline outline-2 -outline-offset-2 outline-accent" : ""}`}
                  style={failing ? { boxShadow: "inset 3px 0 0 var(--danger)" } : undefined}
                >
                  <span className="mono min-w-0 text-[10px] break-all" role="cell">
                    {c.id}
                  </span>
                  <span className="min-w-0" role="cell">
                    <button
                      type="button"
                      data-case-open
                      className="min-w-0 cursor-pointer text-left text-[12.5px] break-words hover:underline"
                    >
                      {c.name}
                    </button>
                  </span>
                  <span className="min-w-0" role="cell">
                    <span className="mono inline-block border border-rule-2 px-2 py-[3px] text-[9px] text-ink-2">
                      {c.kind}
                    </span>
                  </span>
                  <span className="min-w-0" role="cell">
                    <CaseStatusMark status={c.status} />
                  </span>
                  <span className="min-w-0" role="cell">
                    {c.severity ? (
                      <span className={`statusword ${SEVERITY_INK[c.severity]}`}>{c.severity}</span>
                    ) : (
                      <span className="mono text-[9.5px] text-muted">—</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {openCase !== null ? (
        <CaseDrawer
          testCase={openCase}
          position={position}
          total={visible.length}
          onStep={step}
          onClose={close}
        />
      ) : null}
    </section>
  );
}

function CaseStatusMark({ status }: { status: CaseStatus }) {
  return (
    <span className={`inline-flex items-center gap-[7px] ${CASE_INK[status]}`}>
      <span className={`mark ${CASE_MARK[status]}`} aria-hidden />
      <span className="statusword">{status}</span>
    </span>
  );
}

function FilterRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; text: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-[18px] gap-y-1">
      <span className="colhead w-10 shrink-0">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-filter={`${label}:${o.value}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`statusword cursor-pointer pb-0.5 transition-colors duration-[180ms] ${
            value === o.value
              ? "border-b-2 border-fg text-fg"
              : "text-ink-2 hover:text-fg"
          }`}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the failure drawer
// ---------------------------------------------------------------------------

/**
 * The case detail drawer (handoff § 04b-2): a 560px panel docked to the right edge, over a dimmed
 * page, with the exact request and response and the steps to reproduce.
 *
 * It deliberately does NOT lock body scroll — `overflow: hidden` on <body> would also make the
 * "does this page scroll sideways" check pass by clipping rather than by fitting, and that check
 * is the one that catches a runaway `<pre>` (see the note at the bottom of globals.css).
 */
function CaseDrawer({
  testCase,
  position,
  total,
  onStep,
  onClose,
}: {
  testCase: TestCase;
  /** Index of this case in the visible list, for `case 2 of 6`. */
  position: number;
  total: number;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  /**
   * Keep Tab inside the panel.
   *
   * `aria-modal="true"` tells a screen reader the rest of the page is inert; without containment
   * four Tab presses walked out into the table behind the overlay, so a keyboard user was
   * navigating content their reader had been told did not exist. A `<dialog>` + `showModal()`
   * would give this for free, but it also brings the top layer and its own backdrop, which is a
   * bigger change to a sheet that deliberately does not lock body scroll — so the cycle is done
   * here, in the ten lines it takes, with no dependency.
   */
  const trapTab = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const root = panelRef.current;
    if (root === null) return;
    const focusable = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey ? active === first : active === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40" data-drawer="open">
      <div className="absolute inset-0 bg-bg/60" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className="shadow-slip-right absolute inset-y-0 right-0 flex w-full max-w-full min-w-0 flex-col border-l border-rule-2 bg-surface sm:w-[560px]"
      >
        <header className="flex min-w-0 items-center justify-between gap-3 border-b-2 border-fg px-[26px] py-[18px]">
          <div className="flex min-w-0 items-center gap-3">
            <span className="mono min-w-0 text-[11px] break-all">{testCase.id}</span>
            <span
              className={`inline-flex shrink-0 items-center gap-[7px] ${CASE_INK[testCase.status]}`}
            >
              <span className={`mark ${CASE_MARK[testCase.status]}`} aria-hidden />
              <span className="statusword">
                {testCase.status}
                {testCase.severity ? ` · ${testCase.severity}` : ""}
              </span>
            </span>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-drawer-close
            onClick={onClose}
            aria-label="Close (esc)"
            title="esc"
            className="shrink-0 cursor-pointer px-1 text-[13px] text-muted transition-colors duration-[180ms] outline-accent hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="flex min-w-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[26px] py-[22px]">
          <h2 id={titleId} className="min-w-0 text-[17px] leading-[1.4] font-semibold tracking-[-0.02em] break-words">
            {testCase.name}
          </h2>

          <Verbatim label="request" value={testCase.request} testId="request" />
          <Verbatim label="response" value={testCase.response} testId="response" tone="danger" />

          <section className="flex min-w-0 flex-col gap-3">
            <span className="colhead">repro</span>
            {testCase.reproSteps && testCase.reproSteps.length > 0 ? (
              <ol data-repro-steps className="flex min-w-0 flex-col gap-2.5">
                {testCase.reproSteps.map((step, i) => (
                  <li key={i} className="flex min-w-0 gap-3">
                    <span className="mono shrink-0 text-[9.5px] text-accent">{i + 1}</span>
                    <span className="min-w-0 text-[12.5px] leading-[1.55] break-words text-ink-2">
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12.5px] text-ink-2">None recorded for this case.</p>
            )}
          </section>
        </div>

        <div className="mt-auto flex min-w-0 items-center justify-between gap-4 border-t border-line px-[26px] py-4">
          <span className="mono shrink-0 text-[9.5px] text-muted">
            case {position + 1} of {total}
          </span>
          <div className="flex shrink-0 gap-4">
            <button
              type="button"
              data-drawer-prev
              disabled={position <= 0}
              onClick={() => onStep(-1)}
              className="btnlabel text-ink-3 transition-colors duration-[180ms] hover:text-fg disabled:opacity-40"
            >
              ← prev
            </button>
            <button
              type="button"
              data-drawer-next
              disabled={position < 0 || position >= total - 1}
              onClick={() => onStep(1)}
              className="btnlabel transition-colors duration-[180ms] hover:text-accent disabled:opacity-40"
            >
              next →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One `<pre>` holding a manifest string EXACTLY as it was recorded, plus COPY.
 *
 * Three details are load-bearing, and all three are about not lying about the evidence:
 *
 * 1. **`<code>` inside `<pre>`.** The HTML parser drops a newline that immediately follows a
 *    `<pre>` start tag. This page is server-rendered, so a request body beginning with `\n` would
 *    silently lose its first line between the server and the browser. Wrapping the text in
 *    `<code>` moves it off that boundary and it survives.
 * 2. **`whitespace-pre`, never `pre-wrap`.** Soft-wrapping does not change `textContent`, but it
 *    does change what a reader believes the bytes were — a wrapped 300-character URL looks like a
 *    multi-line request. It scrolls sideways INSIDE this box instead, which is also what keeps the
 *    page itself from moving (handoff § Interactions, the hard overflow rule).
 * 3. **COPY copies the PROP, not the DOM.** The same string the manifest holds, with no round trip
 *    through selection or `innerText` normalisation.
 *
 * Escaping needs no special handling and gets none: this is JSX text, so React escapes it. A
 * response containing `<script>` renders as visible characters and cannot execute.
 */
function Verbatim({
  label,
  value,
  testId,
  tone = "ink",
}: {
  label: string;
  value: string | undefined;
  testId: string;
  /** The response block carries the danger bar; the request keeps the ink one. */
  tone?: "ink" | "danger";
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="colhead">{label}</span>
        {value === undefined ? null : <CopyButton value={value} />}
      </div>
      {value === undefined ? (
        <p className="text-[12.5px] text-ink-2">Not recorded for this case.</p>
      ) : (
        <pre
          data-verbatim={testId}
          className={`mono max-h-64 min-w-0 overflow-auto border-l-[3px] px-[15px] py-[13px] text-[10px] leading-[1.75] whitespace-pre ${
            tone === "danger" ? "border-danger bg-danger-tint" : "border-fg bg-surface-2"
          }`}
        >
          <code>{value}</code>
        </pre>
      )}
    </section>
  );
}
