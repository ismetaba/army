"use client";

/**
 * The Design tab's screen grid, lightbox and run-over-run compare (T20 steps 1–2).
 *
 * A client component for three interactions and nothing else: opening a screenshot full size,
 * choosing a run to compare against, and closing either. Every URL it renders was built on the
 * server by `artifactHref`, so this file never sees a filesystem path — images load through
 * `/api/artifact`, which is the only path-confined reader in the panel.
 *
 * It imports types from `@shared/schemas` (via `design-data`) and nothing else from the server
 * half: `@/lib/store` pulls in `node:fs` and must stay unreachable from here.
 *
 * `<img>` rather than `next/image` on purpose. The optimiser would re-fetch every artifact
 * through its own loader, buffer it, and cache a copy of a screenshot that the store already owns
 * and that `/api/artifact` streams with `cache-control: no-store` — for a local panel showing
 * PNGs off local disk that is cost with no benefit, and it would need `images.remotePatterns`
 * config for a URL that is already same-origin.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatWhen } from "@/lib/format";
import {
  comparedViewports,
  pick,
  unionScreens,
  VIEWPORTS,
  type ScreenGroup,
  type ScreenShotView,
  type Viewport,
} from "@/components/design-data";

/** Another design-loop run of the same feature, offered in the compare dropdown. */
export interface CompareRun {
  runId: string;
  createdAt: string;
  /** `/ws/<ws>/run/<id>?tab=design` — built on the server so the client never encodes ids. */
  href: string;
  /** True when this run happened BEFORE the one being viewed. Decides which column is "then". */
  older: boolean;
  /** The feedback that produced it, when it was an `--iterate` run. */
  iterate: string | null;
  groups: ScreenGroup[];
}

export interface DesignGalleryProps {
  runId: string;
  /** Named in the "no other run covers this feature" line, as the Report tab's equivalent does. */
  workspace: string;
  createdAt: string;
  groups: ScreenGroup[];
  compare: CompareRun[];
  /** `/api/artifact?…` for `manifest.design.video`, or `null` when the run recorded none. */
  videoHref: string | null;
  /** Set when the manifest names a video the run directory does not contain. */
  videoMissing: string | null;
}

/** What the lightbox is currently showing. */
interface Lit {
  href: string;
  caption: string;
}

export function DesignGallery({
  runId,
  workspace,
  createdAt,
  groups,
  compare,
  videoHref,
  videoMissing,
}: DesignGalleryProps) {
  const [againstId, setAgainstId] = useState<string>("");
  const [lit, setLit] = useState<Lit | null>(null);

  /**
   * The element that opened the lightbox, so focus can go back to it on close.
   *
   * Without this, closing with ESC drops focus onto `<body>` and a keyboard user restarts at the
   * top of the page — after opening the fourth screenshot of six, that is the whole grid again.
   */
  const opener = useRef<HTMLElement | null>(null);

  const open = useCallback((shot: Lit, from: HTMLElement | null) => {
    opener.current = from;
    setLit(shot);
  }, []);

  const close = useCallback(() => {
    setLit(null);
    opener.current?.focus();
    opener.current = null;
  }, []);

  const against = compare.find((c) => c.runId === againstId) ?? null;

  return (
    <section className="flex min-w-0 flex-col gap-4" data-design-gallery>
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Screens{" "}
          <span className="font-normal normal-case" data-screen-count>
            ({groups.length} {groups.length === 1 ? "screen" : "screens"})
          </span>
        </h2>

        {compare.length > 0 ? (
          <label className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-muted">Compare with</span>
            <select
              value={againstId}
              onChange={(e) => setAgainstId(e.target.value)}
              data-compare-select
              className="min-w-0 max-w-full rounded border border-line bg-surface px-2 py-1 text-sm text-fg"
            >
              <option value="">— off —</option>
              {compare.map((c) => (
                <option key={c.runId} value={c.runId}>
                  {c.older ? "earlier" : "later"} · {formatWhen(c.createdAt)} · {c.runId}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-muted" data-compare-empty>
            {/* Same sentence the Report tab's "Feature history" uses for the same situation
                (report-panel.tsx), down to the workspace name and the monospaced kind: a reader
                comparing the two tabs should not have to work out whether they mean the same. */}
            No other <span className="font-mono">design-loop</span> run in workspace{" "}
            <span className="font-mono">{workspace}</span> covers this feature.
          </p>
        )}
      </header>

      {/* `against` is tested BEFORE the empty case. A run that captured nothing is exactly when a
          comparison is most worth showing — every row is then a screen that exists in only one of
          the two runs, which is what `unionScreens` was written for. Testing `groups.length` first
          short-circuited it and made the compare dropdown a dead control on such a run. */}
      {against !== null ? (
        <CompareGrid
          groups={groups}
          against={against}
          runId={runId}
          createdAt={createdAt}
          onOpen={open}
        />
      ) : groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted">
          This run recorded no screenshots.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          {groups.map((group) => (
            <ScreenCard key={group.screen} group={group} onOpen={open} />
          ))}
        </div>
      )}

      {videoHref !== null ? (
        <figure className="flex min-w-0 flex-col gap-2 rounded-lg border border-line bg-surface p-3">
          <figcaption className="text-xs uppercase tracking-wide text-muted">session video</figcaption>
          {/* `preload="metadata"`: a webm of a browser session is megabytes, and the tab is often
              opened for the screenshots. /api/artifact answers byte ranges, so seeking works. */}
          <video
            controls
            preload="metadata"
            src={videoHref}
            data-design-video
            className="max-h-[70vh] w-full max-w-full rounded bg-black"
          />
          <a href={videoHref} className="self-start text-xs text-link hover:underline">
            open video in a new tab
          </a>
        </figure>
      ) : videoMissing !== null ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-sm text-muted">
          The manifest names a video (<span className="font-mono">{videoMissing}</span>) that is not
          in this run&rsquo;s directory.
        </p>
      ) : null}

      {lit !== null ? <Lightbox lit={lit} onClose={close} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------

type OpenFn = (shot: Lit, from: HTMLElement | null) => void;

/** One screen: its mobile and desktop captures side by side (T20 step 1). */
function ScreenCard({ group, onOpen }: { group: ScreenGroup; onOpen: OpenFn }) {
  return (
    <article
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3"
      data-screen-card
      data-screen={group.screen}
    >
      <h3 className="min-w-0 text-sm font-semibold break-words" data-screen-name>
        {group.screen}
      </h3>
      {/* Desktop gets twice the column: a 1440-wide capture next to a 375-wide one in equal
          columns wastes half the row on the phone and shrinks the wide shot to unreadable. One
          column below `sm`, where side-by-side would shrink both. */}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {VIEWPORTS.map((viewport) => (
          <Cell
            key={viewport}
            shot={group[viewport]}
            screen={group.screen}
            viewport={viewport}
            label={viewport}
            onOpen={onOpen}
          />
        ))}
      </div>
    </article>
  );
}

/** Then/now pairs for every screen either run captured (T20 step 2). */
function CompareGrid({
  groups,
  against,
  runId,
  createdAt,
  onOpen,
}: {
  groups: ScreenGroup[];
  against: CompareRun;
  runId: string;
  createdAt: string;
  onOpen: OpenFn;
}) {
  // "then" is whichever run is OLDER, which is not always the one picked from the dropdown: the
  // list offers every run of the feature, including ones recorded after this one.
  const thenRun = against.older
    ? { id: against.runId, at: against.createdAt, groups: against.groups, href: against.href }
    : { id: runId, at: createdAt, groups, href: null };
  const nowRun = against.older
    ? { id: runId, at: createdAt, groups, href: null }
    : { id: against.runId, at: against.createdAt, groups: against.groups, href: against.href };

  const screens = unionScreens(groups, against.groups);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-compare-grid>
      <p className="rounded border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
        <span className="font-semibold text-fg">then</span> {formatWhen(thenRun.at)} ·{" "}
        <span className="font-mono">{thenRun.id}</span> →{" "}
        <span className="font-semibold text-fg">now</span> {formatWhen(nowRun.at)} ·{" "}
        <span className="font-mono">{nowRun.id}</span>
        {/* Named with the run it belongs to. `against.iterate` is the feedback that produced the
            SELECTED run, which is the "then" column only when that run is the older one — an
            unlabelled "feedback applied" read as then→now either way. */}
        {against.iterate !== null ? (
          <>
            {" "}
            · feedback that produced <span className="font-mono">{against.runId}</span>:{" "}
            <span className="text-fg">{against.iterate}</span>
          </>
        ) : null}
      </p>

      {screens.map((screen) => (
        <article
          key={screen}
          className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3"
          data-compare-card
          data-screen={screen}
        >
          <h3 className="min-w-0 text-sm font-semibold break-words">{screen}</h3>
          {comparedViewports(groups, against.groups, screen).map((viewport) => (
            <div key={viewport} className="flex min-w-0 flex-col gap-2">
              <p className="text-xs uppercase tracking-wide text-muted">{viewport}</p>
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" data-compare-pair>
                <Cell
                  shot={pick(thenRun.groups, screen, viewport)}
                  screen={screen}
                  viewport={viewport}
                  label={`then · ${thenRun.id}`}
                  onOpen={onOpen}
                />
                <Cell
                  shot={pick(nowRun.groups, screen, viewport)}
                  screen={screen}
                  viewport={viewport}
                  label={`now · ${nowRun.id}`}
                  onOpen={onOpen}
                />
              </div>
            </div>
          ))}
        </article>
      ))}
    </div>
  );
}

/**
 * One image cell — or the labelled gap that replaces it.
 *
 * Three states, and the difference between the last two is the point: a viewport the run never
 * captured is normal, while a capture whose FILE is gone is a broken run worth naming. Neither
 * renders an `<img>` that would 404.
 */
function Cell({
  shot,
  screen,
  viewport,
  label,
  onOpen,
}: {
  shot: ScreenShotView | null;
  screen: string;
  viewport: Viewport;
  label: string;
  onOpen: OpenFn;
}) {
  const caption = `${screen} · ${viewport}`;

  if (shot === null) {
    return (
      <div
        className="flex min-h-24 min-w-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-line px-3 py-6 text-center text-xs text-muted"
        data-shot-missing="not-captured"
      >
        <span className="uppercase tracking-wide">{label}</span>
        <span>not captured</span>
      </div>
    );
  }

  if (shot.href === null) {
    return (
      <div
        className="flex min-h-24 min-w-0 flex-col items-center justify-center gap-1 rounded border border-dashed border-line px-3 py-6 text-center text-xs text-muted"
        data-shot-missing="file-missing"
      >
        <span className="uppercase tracking-wide">{label}</span>
        <span className="min-w-0 font-mono break-all">{shot.path}</span>
        <span>file missing</span>
      </div>
    );
  }

  // Captured as a const so the `!== null` narrowing above survives into the click handler.
  const href = shot.href;

  return (
    <figure className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        onClick={(e) => onOpen({ href, caption }, e.currentTarget)}
        title={`${caption} — open full size`}
        data-shot
        data-viewport={viewport}
        className="group min-w-0 cursor-zoom-in overflow-hidden rounded border border-line bg-surface-2 p-1 transition-colors hover:border-link focus-visible:border-link"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- see the file header: next/image
            would re-fetch and cache a local artifact for no gain. */}
        <img
          src={href}
          alt={caption}
          loading="lazy"
          decoding="async"
          data-shot-image
          className="mx-auto max-h-80 w-auto max-w-full object-contain"
        />
      </button>
      <figcaption className="min-w-0 text-xs text-muted break-words">{label}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// lightbox
// ---------------------------------------------------------------------------

/**
 * Full-size view: a plain fixed-position overlay (T20 step 1), no portal and no dependency.
 *
 * `position: fixed` is relative to the viewport only while no ancestor has a `transform`,
 * `filter` or `backdrop-filter` — none of the panel's layout does, which is why this can render in
 * place instead of through `createPortal`.
 *
 * Closing: ESC, or a click anywhere except the toolbar. The whole overlay is the close target
 * because the image itself does nothing when clicked, so "click somewhere to get out" is what a
 * reader will try first.
 */
function Lightbox({ lit, onClose }: { lit: Lit; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);

    // The page behind must not scroll while the overlay is up — and the previous value is
    // restored rather than cleared, so this cannot leave the body permanently locked.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${lit.caption} — full size`}
      onClick={onClose}
      data-lightbox
      className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/80 p-4"
    >
      <div
        className="flex max-w-full items-center gap-3 text-xs text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 break-words">{lit.caption}</span>
        <a
          href={lit.href}
          className="rounded border border-white/40 px-2 py-0.5 hover:bg-white/10"
          data-lightbox-raw
        >
          open raw
        </a>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          data-lightbox-close
          className="rounded border border-white/40 px-2 py-0.5 hover:bg-white/10"
        >
          Close (ESC)
        </button>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- see the file header. */}
      <img
        src={lit.href}
        alt={lit.caption}
        data-lightbox-image
        className="max-h-[85vh] max-w-full object-contain"
      />
    </div>
  );
}
