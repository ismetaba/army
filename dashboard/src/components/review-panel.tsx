"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Finding, Severity, Verdict } from "@shared/schemas";
import {
  anchorFindings,
  rowKey,
  widestLineNumber,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
} from "@/lib/diff";
import {
  FindingCard,
  SEVERITIES,
  SeverityBadge,
  severityRank,
} from "@/components/review-finding-card";
import "@/components/review-theme.css";

/**
 * The Review tab (T18 step 2): the diff the verdict was reached on, with every finding pinned to
 * the line it names.
 *
 * A client component because the four things it does are all interactions on data that is
 * already here — filter by severity, collapse a file, jump from the sidebar to a card, copy a
 * fix. Nothing needs the server again, so nothing round-trips.
 *
 * TWO LAYOUT RULES drive most of the markup below:
 *
 * 1. **The finding card must sit UNDER its diff row, and must stay readable.** A wide diff scrolls
 *    sideways; a card that scrolled with it would be half off-screen the moment you looked at a
 *    long line. So a file's rows are cut into segments at every anchored row: each run of rows is
 *    its own horizontal scroller, and the cards sit BETWEEN the scrollers in normal flow. The
 *    gutters are given one fixed `ch` width per file so the segments still line up as one table,
 *    and the scrollers are kept in sync (see `useScrollSync`) so it behaves like one.
 * 2. **The page must not scroll sideways.** Every wide thing is inside `overflow-x-auto`, and
 *    every flex child that holds one carries `min-w-0` — without it a flex item refuses to shrink
 *    below its content and pushes the body wide.
 */

export interface ReviewPanelProps {
  verdict: Verdict;
  findings: Finding[];
  files: DiffFile[];
  /** Link to the raw `diff.patch`, or `null` when the store could not resolve it. */
  diffHref: string | null;
  /** Set when the patch could not be shown in full — rendered above the diff. */
  notice: string | null;
}

/** A finding plus the DOM id the sidebar scrolls to. */
type Item = Finding & { domId: string };

const VERDICT_CLASS: Record<Verdict, string> = {
  APPROVE: "bg-done-bg text-done-fg",
  "APPROVE WITH NITS": "bg-[var(--warn-bg)] text-[var(--warn-fg)]",
  "REQUEST CHANGES": "bg-error-bg text-error-fg",
};

export function ReviewPanel({ verdict, findings, files, diffHref, notice }: ReviewPanelProps) {
  const items = useMemo<Item[]>(
    () => findings.map((f, i) => ({ ...f, domId: `finding-${i}` })),
    [findings],
  );

  const [enabled, setEnabled] = useState<Record<Severity, boolean>>({
    BLOCKER: true,
    MAJOR: true,
    MINOR: true,
    NIT: true,
  });
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

  const counts = useMemo(() => {
    const out: Record<Severity, number> = { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 };
    for (const f of findings) out[f.severity] += 1;
    return out;
  }, [findings]);

  const visible = useCallback((f: Finding) => enabled[f.severity], [enabled]);
  const shown = useMemo(() => items.filter(visible), [items, visible]);

  const sorted = useMemo(
    () =>
      [...shown].sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          a.file.localeCompare(b.file) ||
          a.line - b.line,
      ),
    [shown],
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
          document.getElementById(item.domId)?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
      });
    },
    [fileOfItem],
  );

  const unanchoredShown = anchored.unanchored.filter(visible);
  const hiddenCount = findings.length - shown.length;
  const allCollapsed = files.length > 0 && files.every((_, i) => collapsed[i]);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <VerdictBanner verdict={verdict} counts={counts} fileCount={files.length} />

      <SeverityChips counts={counts} enabled={enabled} onChange={setEnabled} hidden={hiddenCount} />

      {notice !== null ? (
        <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-muted">
          {notice}
          {diffHref !== null ? (
            <>
              {" "}
              <a href={diffHref} className="text-link hover:underline">
                open diff.patch
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
        <FindingsSidebar items={sorted} total={findings.length} focused={focused} onPick={jumpTo} />

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {files.length > 1 ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() =>
                  setCollapsed(
                    allCollapsed ? {} : Object.fromEntries(files.map((_, i) => [i, true])),
                  )
                }
                className="rounded border border-line px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
              >
                {allCollapsed ? "Expand all files" : "Collapse all files"}
              </button>
            </div>
          ) : null}

          {files.map((file, fileIndex) => (
            <FileSection
              key={`${fileIndex}-${file.file}`}
              file={file}
              fileIndex={fileIndex}
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
            <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
              No diff to show — every finding is listed below.
            </p>
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
// verdict + filter
// ---------------------------------------------------------------------------

function VerdictBanner({
  verdict,
  counts,
  fileCount,
}: {
  verdict: Verdict;
  counts: Record<Severity, number>;
  fileCount: number;
}) {
  const total = SEVERITIES.reduce((sum, s) => sum + counts[s], 0);
  const breakdown = SEVERITIES.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`)
    .join(", ");

  return (
    <div
      data-verdict={verdict}
      className={`rounded-lg border border-line px-4 py-3 ${VERDICT_CLASS[verdict]}`}
    >
      <p className="text-xs font-medium tracking-wide uppercase opacity-80">verdict</p>
      <p className="text-lg font-semibold break-words">{verdict}</p>
      <p className="mt-0.5 text-sm opacity-90">
        {total === 0 ? "No findings" : `${total} finding${total === 1 ? "" : "s"} (${breakdown})`}
        {" across "}
        {fileCount} changed file{fileCount === 1 ? "" : "s"}
      </p>
    </div>
  );
}

function SeverityChips({
  counts,
  enabled,
  onChange,
  hidden,
}: {
  counts: Record<Severity, number>;
  enabled: Record<Severity, boolean>;
  onChange: (next: Record<Severity, boolean>) => void;
  hidden: number;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-xs tracking-wide text-muted uppercase">severity</span>
      {SEVERITIES.map((severity) => {
        const on = enabled[severity];
        return (
          <button
            key={severity}
            type="button"
            aria-pressed={on}
            data-severity={severity}
            onClick={() => onChange({ ...enabled, [severity]: !on })}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
              on
                ? "border-transparent"
                : "border-line bg-transparent text-muted opacity-60 hover:opacity-100"
            }`}
          >
            {on ? (
              <SeverityBadge severity={severity} className="!px-1 !py-0" />
            ) : (
              <span className="font-mono text-[11px] font-semibold tracking-wide">{severity}</span>
            )}
            <span className="tabular-nums">{counts[severity]}</span>
          </button>
        );
      })}
      {hidden > 0 ? (
        <span className="text-xs text-muted">{hidden} hidden by filter</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// sidebar
// ---------------------------------------------------------------------------

function FindingsSidebar({
  items,
  total,
  focused,
  onPick,
}: {
  items: Item[];
  total: number;
  focused: string | null;
  onPick: (item: Item) => void;
}) {
  return (
    <aside className="min-w-0 lg:sticky lg:top-4 lg:w-72 lg:shrink-0">
      <h3 className="mb-2 text-xs tracking-wide text-muted uppercase">
        findings ({items.length}
        {items.length === total ? "" : ` of ${total}`})
      </h3>
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-sm text-muted">
          {total === 0 ? "The reviewer raised nothing." : "Every finding is filtered out."}
        </p>
      ) : (
        <ol className="flex max-h-[60vh] min-w-0 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-surface p-1.5">
          {items.map((item) => (
            <li key={item.domId} className="min-w-0">
              <button
                type="button"
                onClick={() => onPick(item)}
                className={`flex w-full min-w-0 flex-col gap-1 rounded px-2 py-1.5 text-left transition-colors hover:bg-surface-2 ${
                  focused === item.domId ? "bg-surface-2" : ""
                }`}
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <SeverityBadge severity={item.severity} />
                  <span className="min-w-0 line-clamp-2 text-xs">{item.title}</span>
                </span>
                <span className="font-mono text-[11px] break-all text-muted">
                  {item.file}:{item.line}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
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
  byRow,
  visible,
  focused,
  collapsed,
  onToggle,
}: {
  file: DiffFile;
  fileIndex: number;
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

  const findingCount = useMemo(
    () => segments.reduce((n, s) => (s.kind === "cards" ? n + s.findings.length : n), 0),
    [segments],
  );

  // One width for both gutters, for every segment of this file — separate scrollers would
  // otherwise size their columns independently and the diff would step sideways at each card.
  const gutter = `${Math.max(3, String(widestLineNumber(file)).length) + 1}ch`;
  const { register, onScroll } = useScrollSync();

  const panelId = `diff-file-${fileIndex}`;

  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
      <h3>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left hover:bg-surface-2"
        >
          <span aria-hidden className="w-3 shrink-0 text-muted">
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="min-w-0 font-mono text-sm break-all">{file.file}</span>
          {file.status !== "modified" ? <Tag>{STATUS_LABEL[file.status]}</Tag> : null}
          {file.status === "renamed" && file.oldPath !== null ? (
            <span className="font-mono text-xs break-all text-muted">from {file.oldPath}</span>
          ) : null}
          {file.binary ? <Tag>binary</Tag> : null}
          {file.truncated ? <Tag>truncated</Tag> : null}
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-xs">
            {findingCount > 0 ? (
              <span className="text-muted">
                {findingCount} finding{findingCount === 1 ? "" : "s"}
              </span>
            ) : null}
            <span className="text-[var(--sev-minor-fg)]">+{file.additions}</span>
            <span className="text-[var(--sev-blocker-fg)]">&minus;{file.deletions}</span>
          </span>
        </button>
      </h3>

      {collapsed ? null : (
        <div id={panelId} className="min-w-0 border-t border-line">
          {file.hunks.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted">
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
                <DiffTable rows={segment.rows} gutter={gutter} />
              </div>
            ) : (
              <div
                key={segment.key}
                className="flex min-w-0 flex-col gap-2 border-y border-line bg-surface-2 px-2 py-2 sm:px-3"
              >
                {segment.findings.map((item) => (
                  <FindingCard
                    key={item.domId}
                    finding={item}
                    domId={item.domId}
                    focused={focused === item.domId}
                    showLocation={false}
                  />
                ))}
              </div>
            ),
          )}

          {file.truncated ? (
            <p className="border-t border-line px-3 py-2 text-xs text-muted">
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
    <span className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">
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

const ROW_CLASS: Record<DiffLine["type"], string> = {
  add: "bg-[var(--diff-add-bg)]",
  del: "bg-[var(--diff-del-bg)]",
  ctx: "",
};

/**
 * The gutters are `sticky` (see `DiffTable`), so their background must be OPAQUE — a context
 * row's gutter would otherwise be transparent and the code would scroll visibly underneath it.
 */
const NUM_CLASS: Record<DiffLine["type"], string> = {
  add: "bg-[var(--diff-add-num)]",
  del: "bg-[var(--diff-del-num)]",
  ctx: "bg-surface",
};

const SIGN: Record<DiffLine["type"], string> = { add: "+", del: "-", ctx: " " };

/**
 * `w-max min-w-full`: the table is as wide as its widest line (so it scrolls inside the wrapper
 * rather than wrapping the code), but never narrower than the panel — otherwise the row tint
 * would stop short of the right edge.
 */
function DiffTable({ rows, gutter }: { rows: RowItem[]; gutter: string }) {
  return (
    <table className="w-max min-w-full border-collapse font-mono text-xs leading-5">
      <tbody>
        {rows.map((row) =>
          row.kind === "hunk" ? (
            <tr key={row.key} className="bg-[var(--diff-hunk-bg)] text-[var(--diff-hunk-fg)]">
              <td colSpan={3} className="px-2 py-1 whitespace-pre select-none">
                {row.hunk.header}
              </td>
            </tr>
          ) : (
            <tr key={row.key} className={ROW_CLASS[row.line.type]} data-line-type={row.line.type}>
              {/* Both gutters are `sticky` so the line numbers stay put while a long line is
                  scrolled — a number that scrolls off screen is a number you cannot use. They are
                  also `select-none`, so copying the diff yields code, not line numbers. */}
              <td
                style={{ width: gutter, position: "sticky", left: 0, zIndex: 1 }}
                className={`px-1 text-right align-top tabular-nums text-[var(--diff-gutter-fg)] select-none ${NUM_CLASS[row.line.type]}`}
              >
                {row.line.oldNo ?? ""}
              </td>
              <td
                style={{ width: gutter, position: "sticky", left: gutter, zIndex: 1 }}
                data-new-line={row.line.newNo ?? ""}
                className={`border-r border-line px-1 text-right align-top tabular-nums text-[var(--diff-gutter-fg)] select-none ${NUM_CLASS[row.line.type]}`}
              >
                {row.line.newNo ?? ""}
              </td>
              <td className="px-2 align-top whitespace-pre">
                <span className="select-none text-[var(--diff-gutter-fg)]">
                  {SIGN[row.line.type]}
                </span>
                {row.line.text}
                {row.line.partial ? (
                  <span className="ml-2 rounded bg-[var(--diff-hunk-bg)] px-1 text-[var(--diff-hunk-fg)]">
                    … cut off by the diff budget
                  </span>
                ) : null}
                {row.line.noNewline ? (
                  <span className="ml-2 text-[var(--diff-gutter-fg)]">
                    ⏎ no newline at end of file
                  </span>
                ) : null}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// findings with nowhere to go
// ---------------------------------------------------------------------------

/**
 * Findings whose `file:line` is not a row in the diff.
 *
 * They are shown, never dropped (T18 step 2). A reviewer that points at a line outside the diff
 * is either wrong or looking at a file it read with `read_file` rather than one it was given —
 * both are worth seeing, and silently discarding a BLOCKER because its line number was off is
 * the one failure mode this view must not have.
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
    <section id="unanchored-findings" className="min-w-0 rounded-lg border border-line bg-surface p-3">
      <h3 className="text-sm font-semibold">
        Unanchored findings ({items.length}
        {items.length === total ? "" : ` of ${total}`})
      </h3>
      <p className="mt-1 mb-3 text-sm text-muted">
        These name a file or a line that is not in <span className="font-mono">diff.patch</span>,
        so there is no row to pin them under.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted">All of them are filtered out.</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
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
