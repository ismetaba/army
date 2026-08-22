"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Finding, Severity, Verdict } from "@shared/schemas";
import {
  anchorFindings,
  rowKey,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from "@/lib/diff";
import { FindingCard, SeverityLine } from "@/components/review-finding-card";
import {
  SEVERITIES,
  SEVERITY_MARK,
  VerdictBanner,
  countSeverities,
  findingSummary,
  severityRank,
} from "@/components/verdict";
import { EmptyNote, RuledHead } from "@/components/task-header";
import { QuietButton } from "@/components/ledger/chrome";

/**
 * The Review result (handoff § 04a — the flagship): the diff the verdict was reached on, with
 * every finding pinned to the line it names.
 *
 * A client component because the four things it does are all interactions on data that is already
 * here — filter by severity, collapse a file, jump from the list to a card, copy a fix. Nothing
 * needs the server again, so nothing round-trips.
 *
 * TWO LAYOUT RULES drive most of the markup below, and both are about the hard overflow rule
 * (handoff § Interactions: the page never scrolls sideways at any width):
 *
 * 1. **The finding card sits UNDER its diff row and must stay readable.** A wide diff scrolls
 *    sideways; a card that scrolled with it would be half off-screen the moment you looked at a
 *    long line. So a file's rows are cut into segments at every anchored row: each run of rows is
 *    its own horizontal scroller, the cards sit BETWEEN the scrollers in normal flow, and the
 *    scrollers are kept in sync (`useScrollSync`) so it still behaves as one table inside the
 *    panel's single 520px vertical scroll box.
 * 2. **Every wide thing is inside `overflow-x-auto`, and every flex/grid child that holds one
 *    carries `min-w-0`** — without it a flex item refuses to shrink below its content and pushes
 *    the whole body wide.
 */

export interface ReviewPanelProps {
  verdict: Verdict;
  findings: Finding[];
  files: DiffFile[];
  /** Link to the raw `diff.patch`, or `null` when the store could not resolve it. */
  diffHref: string | null;
  /** Set when the patch could not be shown in full — rendered above the split. */
  notice: string | null;
}

/** A finding plus the DOM id the jump list scrolls to. */
type Item = Finding & { domId: string };

/** `null` is the "all severities" state — the filter row's ALL entry. */
type Filter = Severity | null;

export function ReviewPanel({ verdict, findings, files, diffHref, notice }: ReviewPanelProps) {
  const items = useMemo<Item[]>(
    () => findings.map((f, i) => ({ ...f, domId: `finding-${i}` })),
    [findings],
  );

  const [filter, setFilter] = useState<Filter>(null);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [focused, setFocused] = useState<string | null>(null);

  const anchored = useMemo(() => anchorFindings(files, items), [files, items]);

  /** domId → index of the file section that holds the card, for expanding before scrolling. */
  const fileOfItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const [key, list] of anchored.byRow) {
      const fileIndex = Number(key.split(":")[0]);
      for (const item of list) map.set(item.domId, fileIndex);
    }
    return map;
  }, [anchored]);

  const counts = useMemo(() => countSeverities(findings), [findings]);
  const visible = useCallback((f: Finding) => filter === null || f.severity === filter, [filter]);

  const sorted = useMemo(
    () =>
      items
        .filter(visible)
        .sort(
          (a, b) =>
            severityRank(a.severity) - severityRank(b.severity) ||
            a.file.localeCompare(b.file) ||
            a.line - b.line,
        ),
    [items, visible],
  );

  /**
   * Jump to a card. The file section it lives in may be collapsed, so it is expanded first and
   * the scroll waits two frames — one for React to commit the expansion, one for the browser to
   * lay it out. Scrolling before that lands on the element's old (zero-height) position.
   */
  const jumpTo = useCallback(
    (item: Item) => {
      const fileIndex = fileOfItem.get(item.domId);
      if (fileIndex !== undefined) setCollapsed((c) => ({ ...c, [fileIndex]: false }));
      setFocused(item.domId);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .getElementById(item.domId)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      });
    },
    [fileOfItem],
  );

  const unanchoredShown = anchored.unanchored.filter(visible);
  const allCollapsed = files.length > 0 && files.every((_, i) => collapsed[i]);

  return (
    <div className="flex min-w-0 flex-col gap-[26px]" data-review-panel>
      <VerdictBanner
        verdict={verdict}
        summary={findingSummary(counts, files.length === 0 ? null : files.length)}
        others
      />

      <SeverityFilter counts={counts} total={findings.length} value={filter} onChange={setFilter} />

      {notice !== null ? (
        <p className="cmd-strip min-w-0 px-3.5 py-2.5 text-[12.5px] leading-[1.6] text-ink-2">
          {notice}
          {diffHref !== null ? (
            <>
              {" "}
              <a href={diffHref} className="text-accent underline hover:text-accent-hover">
                open the raw patch
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="grid min-w-0 grid-cols-1 items-start gap-9 lg:grid-cols-[320px_minmax(0,1fr)]">
        <FindingsJumpList
          items={sorted}
          total={findings.length}
          fileCount={files.length}
          focused={focused}
          onPick={jumpTo}
        />

        <div className="flex min-w-0 flex-col gap-6">
          {files.length > 1 ? (
            <div className="flex justify-end">
              <QuietButton
                onClick={() =>
                  setCollapsed(
                    allCollapsed ? {} : Object.fromEntries(files.map((_, i) => [i, true])),
                  )
                }
              >
                {allCollapsed ? "expand all files" : "collapse all files"}
              </QuietButton>
            </div>
          ) : null}

          {files.map((file, fileIndex) => (
            <FileSection
              key={`${fileIndex}-${file.file}`}
              file={file}
              fileIndex={fileIndex}
              fileCount={files.length}
              byRow={anchored.byRow}
              visible={visible}
              focused={focused}
              collapsed={collapsed[fileIndex] ?? false}
              onToggle={() =>
                setCollapsed((c) => ({ ...c, [fileIndex]: !(c[fileIndex] ?? false) }))
              }
            />
          ))}

          {files.length === 0 ? (
            <EmptyNote>No diff to show — every finding is listed below.</EmptyNote>
          ) : null}

          <UnanchoredFindings
            items={unanchoredShown}
            total={anchored.unanchored.length}
            focused={focused}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// severity filter
// ---------------------------------------------------------------------------

/**
 * `SEVERITY · ALL 6 · BLOCKER 0 · MAJOR 3 · MINOR 1 · NIT 2`, the active one underlined
 * (handoff § 04a).
 *
 * The artboard shows exactly one entry underlined, i.e. a single-choice filter, so that is what
 * this is — with an explicit ALL entry the reference does not draw, because a single-choice row
 * with no ALL has no way back to the whole list. A severity nobody raised is disabled rather than
 * hidden: `BLOCKER 0` is information.
 */
function SeverityFilter({
  counts,
  total,
  value,
  onChange,
}: {
  counts: Record<Severity, number>;
  total: number;
  value: Filter;
  onChange: (next: Filter) => void;
}) {
  const entry = (active: boolean, disabled: boolean) =>
    `flex items-center gap-[7px] pb-0.5 transition-colors duration-[180ms] ${
      active ? "border-b-2 border-fg text-fg" : disabled ? "text-muted" : "text-ink-2 hover:text-fg"
    }`;

  return (
    <div
      className="flex min-w-0 flex-wrap items-baseline gap-x-[18px] gap-y-2 border-b border-line pb-2.5"
      data-severity-filter
    >
      <span className="colhead shrink-0">severity</span>

      <button
        type="button"
        aria-pressed={value === null}
        data-filter="all"
        onClick={() => onChange(null)}
        className={entry(value === null, false)}
      >
        <span className="statusword">all {total}</span>
      </button>

      {SEVERITIES.map((severity) => {
        const empty = counts[severity] === 0;
        return (
          <button
            key={severity}
            type="button"
            disabled={empty}
            aria-pressed={value === severity}
            data-filter={severity}
            // Clicking the active one goes back to ALL, so the row is reversible with one click.
            onClick={() => onChange(value === severity ? null : severity)}
            className={entry(value === severity, empty)}
          >
            <span className={`mark ${SEVERITY_MARK[severity]}`} aria-hidden />
            <span className="statusword">
              {severity} {counts[severity]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// jump list
// ---------------------------------------------------------------------------

function FindingsJumpList({
  items,
  total,
  fileCount,
  focused,
  onPick,
}: {
  items: Item[];
  total: number;
  fileCount: number;
  focused: string | null;
  onPick: (item: Item) => void;
}) {
  return (
    <nav className="flex min-w-0 flex-col" aria-label="Findings">
      <div className="colhead pb-2.5">
        findings · jump to
        {items.length === total ? "" : ` · ${items.length} of ${total}`}
      </div>

      {items.length === 0 ? (
        <EmptyNote>
          {total === 0
            ? `No findings — ${fileCount} file${fileCount === 1 ? "" : "s"} reviewed.`
            : "Every finding is filtered out."}
        </EmptyNote>
      ) : (
        <ol className="flex min-w-0 flex-col">
          {items.map((item, index) => {
            const active = focused === item.domId;
            return (
              <li key={item.domId} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onPick(item)}
                  data-jump-to={item.domId}
                  className={`flex w-full min-w-0 flex-col gap-2.5 border-t border-line py-3 pr-3 text-left transition-colors duration-[180ms] ${
                    index === items.length - 1 ? "border-b" : ""
                  } ${active ? "bg-surface-2" : "hover:bg-paper-hover"}`}
                >
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="mono shrink-0 text-[9px] text-muted">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <SeverityLine severity={item.severity} className="translate-y-px" />
                  </span>
                  <span className="min-w-0 pl-[26px] text-[12.5px] leading-[1.5] break-words">
                    {item.title}
                  </span>
                  <span className="mono min-w-0 pl-[26px] text-[9px] break-all text-muted">
                    {item.file}:{item.line}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// one file
// ---------------------------------------------------------------------------

type RowItem =
  | { kind: "hunk"; key: string; hunk: DiffHunk }
  | { kind: "line"; key: string; line: DiffLine };

type Segment =
  | { kind: "rows"; key: string; rows: RowItem[] }
  | { kind: "cards"; key: string; findings: Item[] };

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  modified: "modified",
};

function FileSection({
  file,
  fileIndex,
  fileCount,
  byRow,
  visible,
  focused,
  collapsed,
  onToggle,
}: {
  file: DiffFile;
  fileIndex: number;
  fileCount: number;
  byRow: Map<string, Item[]>;
  visible: (f: Finding) => boolean;
  focused: string | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const segments = useMemo<Segment[]>(() => {
    const out: Segment[] = [];
    let rows: RowItem[] = [];
    const flush = () => {
      if (rows.length > 0) {
        out.push({ kind: "rows", key: `rows-${out.length}`, rows });
        rows = [];
      }
    };
    file.hunks.forEach((hunk, hunkIndex) => {
      rows.push({ kind: "hunk", key: `h${hunkIndex}`, hunk });
      hunk.lines.forEach((line, lineIndex) => {
        rows.push({ kind: "line", key: `l${hunkIndex}-${lineIndex}`, line });
        const key = rowKey(fileIndex, hunkIndex, lineIndex);
        const here = (byRow.get(key) ?? []).filter(visible);
        if (here.length > 0) {
          flush();
          out.push({ kind: "cards", key: `cards-${key}`, findings: here });
        }
      });
    });
    flush();
    return out;
  }, [file, fileIndex, byRow, visible]);

  const { register, onScroll } = useScrollSync();
  const panelId = `diff-file-${fileIndex}`;

  return (
    <section className="min-w-0 border border-line bg-surface" data-diff-file={file.file}>
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-3.5 py-2.5 text-left transition-colors duration-[180ms] hover:bg-paper-hover"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span aria-hidden className="mono w-3 shrink-0 text-[9px] text-muted">
              {collapsed ? "▸" : "▾"}
            </span>
            <span className="mono min-w-0 text-[10px] break-all">{file.file}</span>
            {file.status !== "modified" ? <Tag>{STATUS_LABEL[file.status]}</Tag> : null}
            {file.binary ? <Tag>binary</Tag> : null}
            {file.truncated ? <Tag>truncated</Tag> : null}
          </span>
          <span className="mono shrink-0 text-[9px] text-muted">
            +{file.additions} −{file.deletions} · {fileIndex + 1} of {fileCount} file
            {fileCount === 1 ? "" : "s"}
          </span>
        </button>
      </h3>

      {collapsed ? null : (
        <div id={panelId} className="max-h-[520px] min-w-0 overflow-auto py-2.5">
          {file.hunks.length === 0 ? (
            <p className="px-3.5 py-4 text-[12.5px] text-ink-2">
              {file.binary
                ? "Binary file — git recorded no text diff for it."
                : "No text changes recorded for this file."}
            </p>
          ) : null}

          {segments.map((segment, i) =>
            segment.kind === "rows" ? (
              <div
                key={segment.key}
                ref={register(i)}
                onScroll={onScroll(i)}
                className="min-w-0 overflow-x-auto"
              >
                <DiffRows rows={segment.rows} />
              </div>
            ) : (
              <div
                key={segment.key}
                // Indented to the code column so the card reads as belonging to the row above it —
                // but not at 375, where 58px of indent is a fifth of the panel.
                className="flex min-w-0 flex-col gap-2.5 py-3 pr-2.5 pl-2.5 sm:pl-[58px]"
              >
                {segment.findings.map((item) => (
                  <FindingCard
                    key={item.domId}
                    finding={item}
                    domId={item.domId}
                    focused={focused === item.domId}
                  />
                ))}
              </div>
            ),
          )}

          {file.truncated ? (
            <p className="mt-2 border-t border-line px-3.5 py-2 text-[11.5px] text-ink-2">
              This file&rsquo;s diff was cut short by the review&rsquo;s size budget — the reviewer
              saw exactly what is shown here, and no more.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="mono shrink-0 border border-rule-2 px-1.5 py-px text-[8.5px] text-ink-2">
      {children}
    </span>
  );
}

/**
 * Keep every rows-segment of one file scrolled to the same column.
 *
 * The segments are separate elements (a finding card must not scroll away sideways), so without
 * this the diff visibly tears at each card. The guard flag stops the programmatic writes from
 * echoing back as `scroll` events.
 */
function useScrollSync() {
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const syncing = useRef(false);

  const register = useCallback(
    (index: number) => (node: HTMLDivElement | null) => {
      if (node === null) nodes.current.delete(index);
      else nodes.current.set(index, node);
    },
    [],
  );

  const onScroll = useCallback(
    (index: number) => (event: React.UIEvent<HTMLDivElement>) => {
      if (syncing.current) return;
      syncing.current = true;
      const left = event.currentTarget.scrollLeft;
      for (const [i, node] of nodes.current) {
        if (i !== index && node.scrollLeft !== left) node.scrollLeft = left;
      }
      requestAnimationFrame(() => {
        syncing.current = false;
      });
    },
    [],
  );

  return { register, onScroll };
}

/** Row tint and the OPAQUE gutter behind it — the gutter is sticky, so it may not be see-through. */
const ROW_TINT: Record<DiffLine["type"], string> = {
  add: "bg-diff-add",
  del: "bg-diff-del text-diff-del-ink",
  ctx: "bg-surface",
};

const SIGN: Record<DiffLine["type"], string> = { add: "+", del: "-", ctx: " " };

/**
 * The diff itself: one `44px 1fr` grid for the whole segment, so every row's gutter lines up and
 * the tint reaches the right-hand edge of the widest line.
 *
 * `w-max min-w-full`: as wide as the widest line (so it scrolls inside the wrapper rather than
 * wrapping the code), but never narrower than the panel.
 *
 * The line number shown is the NEW one, falling back to the old for a removed line — one gutter,
 * as the artboard draws it, and the new numbers are the ones a finding's `file:line` names.
 */
function DiffRows({ rows }: { rows: RowItem[] }) {
  return (
    <div className="grid w-max min-w-full grid-cols-[44px_1fr]">
      {rows.map((row) =>
        row.kind === "hunk" ? (
          <div
            key={row.key}
            className="mono col-span-2 bg-surface-2 px-2.5 py-1 text-[9.5px] whitespace-pre text-ink-3 select-none"
          >
            {row.hunk.header}
          </div>
        ) : (
          <Row key={row.key} line={row.line} />
        ),
      )}
    </div>
  );
}

function Row({ line }: { line: DiffLine }) {
  const tint = ROW_TINT[line.type];
  return (
    <>
      {/* Sticky so the number stays put while a long line is scrolled — a number that scrolls off
          screen is a number you cannot use — and `select-none` so copying the diff yields code. */}
      <div
        style={{ position: "sticky", left: 0, zIndex: 1 }}
        className={`mono px-2.5 py-[3px] text-right text-[9.5px] text-gutter select-none ${tint}`}
      >
        {line.newNo ?? line.oldNo ?? ""}
      </div>
      <div
        data-line-type={line.type}
        data-new-line={line.newNo ?? ""}
        className={`mono py-[3px] pr-2.5 text-[10px] whitespace-pre ${tint}`}
      >
        {SIGN[line.type]} {line.text}
        {line.partial ? (
          <span className="ml-2 bg-surface-2 px-1 text-ink-3"> … cut off by the diff budget</span>
        ) : null}
        {line.noNewline ? (
          <span className="ml-2 text-gutter"> ⏎ no newline at end of file</span>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// findings with nowhere to go
// ---------------------------------------------------------------------------

/**
 * Findings whose `file:line` is not a row in the diff.
 *
 * They are shown, never dropped. A reviewer that points at a line outside the diff is either
 * wrong or looking at a file it read with `read_file` rather than one it was given — both are
 * worth seeing, and silently discarding a BLOCKER because its line number was off is the one
 * failure mode this view must not have.
 */
function UnanchoredFindings({
  items,
  total,
  focused,
}: {
  items: Item[];
  total: number;
  focused: string | null;
}) {
  if (total === 0) return null;
  return (
    <section id="unanchored-findings" className="flex min-w-0 flex-col gap-3.5">
      <RuledHead
        title="Unanchored"
        aside={
          <span className="mono text-[9px] text-muted">
            {items.length}
            {items.length === total ? "" : ` of ${total}`} · not a row in this diff
          </span>
        }
      />
      <p className="text-[12.5px] leading-[1.55] text-ink-2">
        These name a file or a line that is not in <span className="mono">diff.patch</span>, so
        there is no row to pin them under.
      </p>
      {items.length === 0 ? (
        <EmptyNote>All of them are filtered out.</EmptyNote>
      ) : (
        <div className="flex min-w-0 flex-col gap-2.5">
          {items.map((item) => (
            <FindingCard
              key={item.domId}
              finding={item}
              domId={item.domId}
              focused={focused === item.domId}
            />
          ))}
        </div>
      )}
    </section>
  );
}
