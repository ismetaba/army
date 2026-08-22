"use client";

/**
 * The Report tab's case table and failure drawer (T19 step 1).
 *
 * This is the one client component in the tab, and it is a client component for exactly two
 * reasons: the status/kind filters and the row → drawer interaction. Everything static (summary,
 * feature history, raw report) is rendered on the server in `report-panel.tsx` and never enters
 * this bundle.
 *
 * It imports `@shared/schemas` for TYPES ONLY. `@/lib/store` — which imports `node:fs` — must
 * never be reachable from here; the types are the only thing the two sides share.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Severity, TestCase } from "@shared/schemas";
import type { CaseKind, CaseStatus } from "@/components/report-data";
import { KIND_ORDER, STATUS_ORDER, countByKind, countByStatus, sortCases } from "@/components/report-data";

type StatusFilter = CaseStatus | "all";
type KindFilter = CaseKind | "all";

/** PASS green / FAIL red / SKIP gray (T19 step 1), from the theme variables so dark mode works. */
const STATUS_STYLE: Record<CaseStatus, string> = {
  PASS: "bg-done-bg text-done-fg",
  FAIL: "bg-error-bg text-error-fg",
  SKIP: "bg-cancelled-bg text-cancelled-fg",
};

/**
 * Severity pills, shown only on failures.
 *
 * BLOCKER and MAJOR share the error colours because they are the same message — "this one is
 * real" — and are told apart by the ring; MINOR and NIT deliberately recede into the neutral
 * pair, because a red NIT next to a red BLOCKER is how a reader learns to ignore red.
 *
 * Keyed on `Severity`, not `string`, for the same reason `STATUS_STYLE` above is keyed on
 * `CaseStatus`: a fifth value added to the SPEC enum must break this build, not silently render
 * as a grey pill. The `?? fallback` at the call sites stays as belt and braces — `severity` comes
 * out of an agent-written manifest, and a manifest that slipped past validation should still draw
 * something.
 */
const SEVERITY_STYLE: Record<Severity, string> = {
  BLOCKER: "bg-error-bg text-error-fg ring-1 ring-error-fg/50 font-semibold",
  MAJOR: "bg-error-bg text-error-fg",
  MINOR: "bg-cancelled-bg text-cancelled-fg",
  NIT: "bg-cancelled-bg text-cancelled-fg",
};

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
        .filter(({ c }) => (status === "all" || c.status === status) && (kind === "all" || c.kind === kind)),
    [sorted, status, kind],
  );

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
     * and a keyboard user is back at the top of the page. Moving focus out first means the
     * element being removed is not the focused one, so nothing is lost — and it needs no
     * `requestAnimationFrame`, which would not fire at all in a background tab.
     */
    trigger?.focus();
    setSelected(null);
  }, []);

  return (
    <section className="flex min-w-0 flex-col gap-3" data-report-cases>
      <div className="flex flex-col gap-2">
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
          onChange={(v) => setStatus(v)}
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
          onChange={(v) => setKind(v)}
        />
      </div>

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          {/* "no cases at all" and "no cases left after filtering" are different problems, and
              telling a reader to loosen filters they never set is the more annoying of the two. */}
          {cases.length === 0 ? "This report has no cases." : "No cases match these filters."}
        </p>
      ) : (
        /* The table is wider than a phone and scrolls INSIDE this box — `min-w-0` is what stops a
           flex parent from letting it push the page sideways instead. */
        <div className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <caption className="sr-only">
              Test cases, failures first. Select a row to see its request, response and repro steps.
            </caption>
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Case</th>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Kind</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Severity</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(({ c, index }) => (
                <tr
                  key={index}
                  data-case-row={c.id}
                  data-status={c.status}
                  data-kind={c.kind}
                  /*
                   * T19 step 1 is "row click opens a detail drawer", so the whole row is the hit
                   * target — the id cell and the FAIL badge are what a reader aims at, and they
                   * were dead. The BUTTON is still the accessible control: it is what a screen
                   * reader announces and what Enter/Space activate, and its click bubbles to here,
                   * so one handler serves mouse, keyboard and AT alike. Focus is sent to that
                   * button either way, which is where `close()` returns it.
                   */
                  onClick={(e) => {
                    const button = e.currentTarget.querySelector<HTMLButtonElement>("[data-case-open]");
                    if (button !== null) {
                      triggerRef.current = button;
                      if (document.activeElement !== button) button.focus();
                    }
                    setSelected(index);
                  }}
                  className={`cursor-pointer border-b border-line last:border-0 ${
                    c.status === "FAIL" ? "bg-error-bg/40" : ""
                  } ${selected === index ? "outline outline-2 -outline-offset-2 outline-link" : ""}`}
                >
                  <td className="px-3 py-2 align-top font-mono text-xs break-all">{c.id}</td>
                  <td className="max-w-[28rem] px-3 py-2 align-top">
                    <button
                      type="button"
                      data-case-open
                      className="w-full cursor-pointer text-left text-link hover:underline break-words"
                    >
                      {c.name}
                    </button>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Pill className="bg-surface-2 text-muted ring-1 ring-line">{c.kind}</Pill>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Pill className={STATUS_STYLE[c.status]}>{c.status}</Pill>
                  </td>
                  <td className="px-3 py-2 align-top">
                    {c.status === "FAIL" && c.severity ? (
                      <Pill className={SEVERITY_STYLE[c.severity] ?? "bg-cancelled-bg text-cancelled-fg"}>
                        {c.severity}
                      </Pill>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openCase ? <CaseDrawer testCase={openCase} onClose={close} /> : null}
    </section>
  );
}

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
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
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="w-12 shrink-0 text-xs uppercase tracking-wide text-muted">{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-filter={`${label}:${o.value}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors ${
            value === o.value
              ? "border-link bg-surface-2 font-medium text-fg"
              : "border-line text-muted hover:text-fg"
          }`}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

/**
 * The case detail drawer: request, response, repro steps.
 *
 * Full-screen on a phone, a right-hand sheet from `sm` up. It deliberately does NOT lock body
 * scroll — `overflow: hidden` on <body> would also make the "does this page scroll sideways"
 * check pass by clipping rather than by fitting, and that check is the one that catches a
 * runaway `<pre>` (see the note at the bottom of globals.css).
 */
function CaseDrawer({ testCase, onClose }: { testCase: TestCase; onClose: () => void }) {
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
   * four Tab presses walked out into the feature-history links behind the overlay, so a keyboard
   * user was navigating content their reader had been told did not exist. A `<dialog>` +
   * `showModal()` would give this for free, but it also brings the top layer and its own backdrop,
   * which is a bigger change to a sheet that deliberately does not lock body scroll — so the cycle
   * is done here, in the ten lines it takes, with no dependency.
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
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
        className="absolute inset-y-0 right-0 flex w-full min-w-0 flex-col border-l border-line bg-surface shadow-2xl sm:max-w-xl"
      >
        <header className="flex min-w-0 items-start gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="min-w-0 text-sm font-semibold break-words">
              {testCase.name}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-muted break-all">{testCase.id}</span>
              <Pill className="bg-surface-2 text-muted ring-1 ring-line">{testCase.kind}</Pill>
              <Pill className={STATUS_STYLE[testCase.status]}>{testCase.status}</Pill>
              {testCase.severity ? (
                <Pill className={SEVERITY_STYLE[testCase.severity] ?? "bg-cancelled-bg text-cancelled-fg"}>
                  {testCase.severity}
                </Pill>
              ) : null}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-drawer-close
            onClick={onClose}
            className="ml-auto shrink-0 cursor-pointer rounded border border-line px-2 py-1 text-xs text-muted hover:text-fg"
          >
            Close
          </button>
        </header>

        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <Verbatim label="request" value={testCase.request} testId="request" />
          <Verbatim label="response" value={testCase.response} testId="response" />

          <section className="flex min-w-0 flex-col gap-2">
            <h3 className="text-xs uppercase tracking-wide text-muted">repro steps</h3>
            {testCase.reproSteps && testCase.reproSteps.length > 0 ? (
              <ol
                data-repro-steps
                className="ml-5 flex list-decimal flex-col gap-1 text-sm marker:text-muted"
              >
                {testCase.reproSteps.map((step, i) => (
                  <li key={i} className="min-w-0 break-words">
                    {step}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted">None recorded.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * One `<pre>` holding a manifest string EXACTLY as it was recorded, plus a copy button.
 *
 * Three details are load-bearing, and all three are about not lying about the evidence:
 *
 * 1. **`<code>` inside `<pre>`.** The HTML parser drops a newline that immediately follows a
 *    `<pre>` start tag. This page is server-rendered, so a request body beginning with `\n`
 *    would silently lose its first line between the server and the browser. Wrapping the text in
 *    `<code>` moves it off that boundary and it survives.
 * 2. **`whitespace-pre`, never `pre-wrap`.** Soft-wrapping does not change `textContent`, but it
 *    does change what a reader believes the bytes were — a wrapped 300-character URL looks like
 *    a multi-line request. It scrolls sideways inside this box instead.
 * 3. **The copy button copies the PROP, not the DOM.** Same string the manifest holds, with no
 *    round trip through selection or `innerText` normalisation.
 *
 * Escaping needs no special handling and gets none: this is JSX text, so React escapes it. A
 * response containing `<script>` renders as five visible characters and cannot execute.
 */
function Verbatim({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | undefined;
  testId: string;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs uppercase tracking-wide text-muted">{label}</h3>
        {value === undefined ? null : <CopyButton value={value} label={label} />}
      </div>
      {value === undefined ? (
        <p className="text-sm text-muted">Not recorded for this case.</p>
      ) : (
        <pre
          data-verbatim={testId}
          className="max-h-64 min-w-0 overflow-auto rounded border border-line bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre"
        >
          <code>{value}</code>
        </pre>
      )}
    </section>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  return (
    <button
      type="button"
      data-copy={label}
      className="cursor-pointer rounded border border-line px-2 py-0.5 text-xs text-muted hover:text-fg"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          // Clipboard access can be refused (an insecure origin, a denied permission). Saying so
          // is better than a button that looks like it worked.
          setState("failed");
        }
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 1500);
      }}
    >
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </span>
    </button>
  );
}
