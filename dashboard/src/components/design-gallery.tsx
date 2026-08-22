"use client";

/**
 * The Design-loop galleries, the recording and the run-over-run compare (handoff § 04c, left
 * column).
 *
 * A client component for four interactions and nothing else: choosing a run to compare against,
 * opening a screenshot full size, closing either, and driving the video. Every URL it renders was
 * built on the server by `artifactHref`, so this file never sees a filesystem path — images and
 * video load through `/api/artifact`, which is the only path-confined reader in the panel.
 *
 * It imports types from `@shared/schemas` (via `design-data`) and nothing else from the server
 * half: `@/lib/store` pulls in `node:fs` and must stay unreachable from here.
 *
 * `<img>` rather than `next/image` on purpose. The optimiser would re-fetch every artifact through
 * its own loader, buffer it, and cache a copy of a screenshot that the store already owns and that
 * `/api/artifact` streams with `cache-control: no-store` — for a local panel showing PNGs off
 * local disk that is cost with no benefit, and it would need `images.remotePatterns` config for a
 * URL that is already same-origin.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RuledHead, shortWhen } from "@/components/task-header";
import { useModalKeys } from "@/components/ledger/modal-focus";
import { machineText } from "@/lib/untrusted";
import {
  comparedViewports,
  pick,
  unionScreens,
  type ScreenGroup,
  type ScreenShotView,
  type Viewport,
} from "@/components/design-data";

/** The artboard's cell sizes: `520×300` desktop, `150×300` mobile, under their own labels. */
const CELL: Record<Viewport, { box: string; label: string }> = {
  desktop: { box: "h-[300px] w-[520px]", label: "desktop · 1440" },
  mobile: { box: "h-[300px] w-[150px]", label: "mobile · 375" },
};

/** Desktop first, as the artboard reads left to right. */
const SHOWN: readonly Viewport[] = ["desktop", "mobile"];

/** Another design-loop run of the same feature, offered in the compare dropdown. */
export interface CompareRun {
  runId: string;
  createdAt: string;
  /** `/ws/<ws>/run/<id>` — built on the server so the client never encodes ids. */
  href: string;
  /** True when this run happened BEFORE the one being viewed. Decides which column is "then". */
  older: boolean;
  /** The feedback that produced it, when it was an `--iterate` run. */
  iterate: string | null;
  groups: ScreenGroup[];
}

export interface DesignGalleryProps {
  runId: string;
  /** Named in the "no other run covers this feature" line. */
  workspace: string;
  createdAt: string;
  groups: ScreenGroup[];
  compare: CompareRun[];
  /** `/api/artifact?…` for `manifest.design.video`, or `null` when the run recorded none. */
  videoHref: string | null;
  /** Set when the manifest names a video the run directory does not contain. */
  videoMissing: string | null;
  /** The run's own Log tab — where an empty gallery sends the reader. */
  logHref: string;
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
  logHref,
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
    <section className="flex min-w-0 flex-col gap-7" data-design-gallery id="screens">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <span className="colhead" data-screen-count>
          screens · {groups.length}
        </span>

        {/*
         * COMPARE WITH. The artboard parks this in the shared header's right column; it lives at
         * the top of the body instead, because the header is server-rendered furniture shared by
         * all four task types and this control owns client state.
         */}
        {compare.length > 0 ? (
          <label className="flex min-w-0 items-center gap-2.5 border border-rule-2 px-2.5 py-1.5">
            <span className="colhead shrink-0">compare with</span>
            <select
              value={againstId}
              onChange={(e) => setAgainstId(e.target.value)}
              data-compare-select
              className="mono tap min-w-0 max-w-[200px] bg-transparent text-[9.5px] text-fg outline-none focus-visible:underline"
            >
              <option value="">— off —</option>
              {compare.map((c) => (
                <option key={c.runId} value={c.runId}>
                  {c.older ? "earlier" : "later"} · {shortWhen(c.createdAt)} · {c.runId}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="mono text-[9px] text-muted" data-compare-empty>
            no other design-loop run in {workspace} covers this feature
          </span>
        )}
      </div>

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
        <p className="border-y border-line px-4 py-6 text-center text-[13px] text-ink-2">
          No screenshots captured —{" "}
          <a href={logHref} className="text-accent underline hover:text-accent-hover">
            read the log
          </a>
          . The feedback box still works.
        </p>
      ) : (
        groups.map((group) => (
          <ScreenSection key={group.screen} group={group} onOpen={open} />
        ))
      )}

      {videoHref !== null ? (
        <Recording href={videoHref} />
      ) : videoMissing !== null ? (
        <section className="flex min-w-0 flex-col gap-3.5">
          <RuledHead title="recording" />
          <p className="text-[12.5px] text-ink-2">
            The manifest names a video (<span className="mono break-all">{videoMissing}</span>) that
            is not in this run&rsquo;s directory.
          </p>
        </section>
      ) : null}

      {lit !== null ? <Lightbox lit={lit} onClose={close} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// galleries
// ---------------------------------------------------------------------------

type OpenFn = (shot: Lit, from: HTMLElement | null) => void;

/** One screen: its desktop and mobile captures side by side under a 2px-ruled head. */
function ScreenSection({ group, onOpen }: { group: ScreenGroup; onOpen: OpenFn }) {
  const shots = SHOWN.filter((v) => group[v] !== null).length;
  return (
    <section
      className="flex min-w-0 flex-col gap-3.5"
      data-screen-card
      data-screen={group.screen}
    >
      <RuledHead
        title={<span data-screen-name>{machineText(group.screen)}</span>}
        aside={
          <span className="mono shrink-0 text-[9px] text-muted">
            {shots} shot{shots === 1 ? "" : "s"}
          </span>
        }
      />
      <div className="flex min-w-0 flex-wrap gap-5">
        {SHOWN.map((viewport) => (
          <Cell
            key={viewport}
            shot={group[viewport]}
            screen={group.screen}
            viewport={viewport}
            label={CELL[viewport].label}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

/** Then/now pairs for every screen either run captured. */
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
    ? { id: against.runId, at: against.createdAt, groups: against.groups }
    : { id: runId, at: createdAt, groups };
  const nowRun = against.older
    ? { id: runId, at: createdAt, groups }
    : { id: against.runId, at: against.createdAt, groups: against.groups };

  const screens = unionScreens(groups, against.groups);

  return (
    <div className="flex min-w-0 flex-col gap-7" data-compare-grid>
      <p className="cmd-strip min-w-0 px-3.5 py-2.5 text-[12px] leading-[1.6] break-words text-ink-2">
        <span className="colhead">then</span> <span className="mono">{thenRun.id}</span>{" "}
        {shortWhen(thenRun.at)} → <span className="colhead">now</span>{" "}
        <span className="mono">{nowRun.id}</span> {shortWhen(nowRun.at)}
        {/* Named with the run it belongs to. `against.iterate` is the feedback that produced the
            SELECTED run, which is the "then" column only when that run is the older one — an
            unlabelled "feedback applied" read as then→now either way. */}
        {against.iterate !== null ? (
          <>
            {" · feedback that produced "}
            <span className="mono">{against.runId}</span>: <span className="text-fg">{against.iterate}</span>
          </>
        ) : null}
      </p>

      {screens.map((screen) => (
        <section
          key={screen}
          className="flex min-w-0 flex-col gap-3.5"
          data-compare-card
          data-screen={screen}
        >
          <RuledHead title={machineText(screen)} />
          {comparedViewports(groups, against.groups, screen).map((viewport) => (
            <div key={viewport} className="flex min-w-0 flex-col gap-2">
              <span className="colhead">{CELL[viewport].label}</span>
              <div className="flex min-w-0 flex-wrap gap-5" data-compare-pair>
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
        </section>
      ))}
    </div>
  );
}

/**
 * One capture — or the labelled gap that replaces it.
 *
 * Three states, and the difference between the last two is the point: a viewport the run never
 * captured is normal, while a capture whose FILE is gone is a broken run worth naming. Neither
 * renders an `<img>` that would 404.
 *
 * `max-w-full` on the fixed-size box is what keeps a 520px desktop cell from widening the page at
 * 375 (handoff § Interactions, the hard overflow rule); `object-contain` letterboxes rather than
 * distorting when it does shrink.
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
  const box = `${CELL[viewport].box} max-w-full`;

  if (shot === null || shot.href === null) {
    return (
      <figure className="flex min-w-0 flex-col gap-2">
        <figcaption className="colhead">{label}</figcaption>
        <div
          data-shot-missing={shot === null ? "not-captured" : "file-missing"}
          className={`${box} flex flex-col items-center justify-center gap-1 border border-dashed border-rule-2 px-3 text-center`}
        >
          <span className="mono text-[9px] text-muted">
            {shot === null ? "not captured" : "file missing"}
          </span>
          {shot !== null ? (
            <span className="mono max-w-full text-[9px] break-all text-muted">{shot.path}</span>
          ) : null}
        </div>
      </figure>
    );
  }

  // Captured as a const so the `!== null` narrowing above survives into the click handler.
  const href = shot.href;

  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="colhead">{label}</figcaption>
      <button
        type="button"
        onClick={(e) => onOpen({ href, caption }, e.currentTarget)}
        title={`${caption} — open full size`}
        data-shot
        data-viewport={viewport}
        className={`${box} cursor-zoom-in border border-line bg-surface-2 transition-colors duration-[180ms] hover:border-accent focus-visible:border-accent`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- see the file header: next/image
            would re-fetch and cache a local artifact for no gain. */}
        <img
          src={href}
          alt={caption}
          loading="lazy"
          decoding="async"
          data-shot-image
          className="h-full w-full object-contain"
        />
      </button>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

/**
 * The session recording, with the artboard's square play button and scrub bar (handoff § 04c).
 *
 * Custom chrome rather than `controls`, because the design asks for it — but built on a real
 * `<video>` element, so seeking is the browser's (`/api/artifact` answers byte ranges) and the
 * scrubber is a `role="slider"` with arrow keys rather than a decorative bar. `preload="metadata"`
 * because a webm of a browser session is megabytes and the tab is usually opened for the shots.
 */
function Recording({ href }: { href: string }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [duration, setDuration] = useState(0);

  /**
   * Read the element's own state when React attaches to it, not only from its events.
   *
   * The `<video>` is server-rendered with its `src`, so the browser starts loading it immediately
   * and `loadedmetadata` has usually already fired by the time hydration attaches a listener —
   * which left the scrub bar reading `00:00 / 00:00` for a video that was fully loaded. Reading
   * the node on attach closes that window; `onDurationChange` catches the other case, a webm whose
   * duration only resolves after the first frames.
   */
  const attach = useCallback((node: HTMLVideoElement | null) => {
    video.current = node;
    if (node === null) return;
    if (Number.isFinite(node.duration)) setDuration(node.duration);
    setAt(node.currentTime);
    setPlaying(!node.paused);
  }, []);

  const seek = (seconds: number) => {
    const node = video.current;
    if (node === null || !Number.isFinite(duration) || duration <= 0) return;
    const next = Math.min(duration, Math.max(0, seconds));
    node.currentTime = next;
    setAt(next);
  };

  const toggle = () => {
    const node = video.current;
    if (node === null) return;
    if (node.paused) void node.play().catch(() => setPlaying(false));
    else node.pause();
  };

  const fraction = duration > 0 ? at / duration : 0;

  return (
    <section className="flex min-w-0 flex-col gap-3.5">
      <RuledHead
        title="recording"
        aside={
          <a
            href={href}
            className="mono tap shrink-0 border-b border-accent text-[9.5px] text-accent hover:text-accent-hover"
          >
            open raw
          </a>
        }
      />

      <div className="relative h-[300px] w-[690px] max-w-full min-w-0 border border-line bg-surface-2">
        <video
          ref={attach}
          src={href}
          preload="metadata"
          playsInline
          data-design-video
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
          }}
          onDurationChange={(e) => {
            if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
          }}
          className="h-full w-full cursor-pointer object-contain"
        />

        {!playing ? (
          <button
            type="button"
            onClick={toggle}
            aria-label="Play the recording"
            data-video-play
            className="absolute top-1/2 left-1/2 flex h-[52px] w-[52px] -translate-x-1/2 -translate-y-1/2 items-center justify-center border-[1.5px] border-fg bg-surface"
          >
            <span
              aria-hidden
              className="ml-[3px] block h-0 w-0 border-t-8 border-b-8 border-l-[13px] border-t-transparent border-b-transparent border-l-fg"
            />
          </button>
        ) : null}

        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-line bg-bg px-3.5 py-2.5">
          <span className="mono shrink-0 text-[9px]">{mmss(at)}</span>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(at)}
            aria-valuetext={mmss(at)}
            data-video-scrub
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") seek(at + 5);
              else if (e.key === "ArrowLeft") seek(at - 5);
              else if (e.key === "Home") seek(0);
              else if (e.key === "End") seek(duration);
              else if (e.key === " " || e.key === "Enter") toggle();
              else return;
              e.preventDefault();
            }}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              if (rect.width > 0) seek(((e.clientX - rect.left) / rect.width) * duration);
            }}
            className="h-0.5 min-w-0 flex-1 cursor-pointer bg-line"
          >
            <div className="h-0.5 bg-accent" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
          </div>
          <span className="mono shrink-0 text-[9px] text-muted">{mmss(duration)}</span>
        </div>
      </div>
    </section>
  );
}

function mmss(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// lightbox
// ---------------------------------------------------------------------------

/**
 * Full-size view: a plain fixed-position overlay, no portal and no dependency.
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
  const overlay = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /*
   * `esc`, the Tab trap and the focus returned on close (handoff § Accessibility). The trap is not
   * optional given the `aria-modal="true"` above: without it Tab walked straight out of the overlay
   * into the feedback textarea and the page's links, so assistive tech was told the page behind was
   * unavailable while focus could in fact reach every control on it.
   */
  useModalKeys(overlay, onClose);

  useEffect(() => {
    // The page behind must not scroll while the overlay is up — and the previous value is restored
    // rather than cleared, so this cannot leave the body permanently locked.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      ref={overlay}
      role="dialog"
      aria-modal="true"
      aria-label={`${lit.caption} — full size`}
      onClick={onClose}
      data-lightbox
      className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-4 bg-fg/80 p-6"
    >
      <div
        className="flex max-w-full items-center gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mono min-w-0 text-[10px] break-words text-bg">{lit.caption}</span>
        <a
          href={lit.href}
          data-lightbox-raw
          className="btnlabel tap border border-bg/50 px-2 py-1 text-bg hover:bg-bg/10"
        >
          open raw
        </a>
        <button
          type="button"
          ref={closeRef}
          onClick={onClose}
          data-lightbox-close
          className="btnlabel tap border border-bg/50 px-2 py-1 text-bg hover:bg-bg/10"
        >
          close · esc
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
