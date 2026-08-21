import fs from 'node:fs/promises';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AwConfig } from '../../shared/schemas';
import { slugify } from '../util';
import { write } from '../workflows/common';

/** Which browser context a tool call targets (SPEC § viewports). */
export const BrowserViewport = z.enum(['mobile', 'desktop']);
export type BrowserViewport = z.infer<typeof BrowserViewport>;

type Viewports = AwConfig['viewports'];

export interface BrowserToolsOptions {
  /** Directory screenshots are written into; created on demand. */
  screenshotDir: string;
  /** Pixel sizes for the `mobile` / `desktop` contexts. */
  viewports: Viewports;
  /** Where warnings go; stderr by default, so stdout stays parseable. */
  log?: (message: string) => void;
}

/** Every tool returns this instead of throwing (SPEC: tools never throw). */
export type ToolError = { error: string };

export type GotoResult = { url: string; title: string } | ToolError;
export type ScreenshotResult = { path: string } | ToolError;
export type ClickResult = { ok: true; selector: string } | ToolError;
export type FillResult = { ok: true; selector: string } | ToolError;
export type ConsoleErrorsResult = { count: number; errors: string[] };

const ACTION_TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 30_000;
/** Hard cap so a noisy page cannot grow the buffer without bound. */
const MAX_BUFFERED_ERRORS = 500;
const MAX_MESSAGE_CHARS = 2_000;

// ---------------------------------------------------------------------------
// Module-level lazy singletons: one browser, one context+page per viewport name.
// ---------------------------------------------------------------------------

interface Session {
  context: BrowserContext;
  page: Page;
  /** `error`-level console messages + pageerrors collected since the last read. */
  errors: string[];
}

let browserPromise: Promise<Browser> | null = null;
const sessions = new Map<BrowserViewport, Promise<Session>>();

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((err: unknown) => {
      browserPromise = null; // allow a later retry
      throw err;
    });
  }
  return browserPromise;
}

function truncate(s: string, max = MAX_MESSAGE_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function push(session: Session, message: string): void {
  if (session.errors.length >= MAX_BUFFERED_ERRORS) return;
  session.errors.push(truncate(message));
}

async function createSession(name: BrowserViewport, viewports: Viewports): Promise<Session> {
  const browser = await getBrowser();
  const { width, height } = viewports[name];
  // deviceScaleFactor 1 keeps PNG pixel width identical to the CSS viewport width.
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  context.setDefaultTimeout(ACTION_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  const page = await context.newPage();
  const session: Session = { context, page, errors: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') push(session, `[console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    push(session, `[pageerror] ${err.message}`);
  });
  return session;
}

function getSession(name: BrowserViewport, viewports: Viewports): Promise<Session> {
  let pending = sessions.get(name);
  if (!pending) {
    pending = createSession(name, viewports).catch((err: unknown) => {
      sessions.delete(name); // failed creation must not be cached
      throw err;
    });
    sessions.set(name, pending);
  }
  return pending;
}

/** Close every context and the browser itself. Safe to call more than once. */
export async function closeBrowser(): Promise<void> {
  const pending = [...sessions.values()];
  sessions.clear();
  for (const p of pending) {
    try {
      const session = await p;
      await session.context.close();
    } catch {
      // a context that never opened, or already closed, needs no cleanup
    }
  }
  const browser = browserPromise;
  browserPromise = null;
  if (browser) {
    try {
      await (await browser).close();
    } catch {
      // ignore
    }
  }
}

function errorOf(err: unknown): ToolError {
  const message = err instanceof Error ? err.message : String(err);
  return { error: truncate(message.split('\n').slice(0, 6).join('\n')) };
}

/** Placeholder for a screen whose name slugifies to nothing — never an empty file name. */
const FALLBACK_SCREEN = 'screen';

/**
 * Strip the viewport word a model already baked into the screen name.
 *
 * SPEC fixes the file name as `<screen>-<viewport>.png`, and the suffix is added here — so a
 * `screen` that already ends in the viewport it is being shot at doubles it. Observed in the
 * live design-loop run: `about-team-mobile` + mobile produced `about-team-mobile-mobile.png`.
 *
 * Only a TRAILING token equal to the viewport being appended is dropped, because that is the
 * only token that can actually duplicate the suffix. Stripping viewport words wherever they sat
 * collapsed distinct screens onto one file — `mobile-nav`, `desktop-nav` and `nav` all became
 * `nav-<viewport>.png`, so a responsive-nav run shot four screenshots and kept two, silently.
 * `about-team-desktop-after` keeps its inner `desktop`: an odd name beats a lost screenshot.
 *
 * It never returns an empty name — a screen called exactly "mobile" keeps its single token
 * rather than becoming `-mobile.png`.
 */
export function normalizeScreenName(slug: string, viewport?: string): string {
  const tokens = slug.split('-').filter(Boolean);
  while (viewport !== undefined && tokens.length > 1 && tokens[tokens.length - 1] === viewport) {
    tokens.pop();
  }
  return tokens.length > 0 ? tokens.join('-') : FALLBACK_SCREEN;
}

/** Longest file-name stem; a 300-character screen name would otherwise fail with ENAMETOOLONG. */
const MAX_SCREEN_CHARS = 80;

/**
 * `<screenshotDir>/<slugified screen>-<viewport>.png`.
 * A `screen` containing `/` becomes nested directories, each segment slugified, so a caller
 * can never escape `screenshotDir`. Only the last segment — the file name — is normalised;
 * a directory the agent chose to nest under keeps the name it was given.
 */
export function screenshotPath(
  screenshotDir: string,
  screen: string,
  viewport: BrowserViewport,
): string {
  const segments = screen.split('/').map(slugify).filter(Boolean);
  if (segments.length === 0) segments.push(FALLBACK_SCREEN);
  const viewportSlug = slugify(viewport);
  const stem = normalizeScreenName(segments.pop()!, viewportSlug)
    .slice(0, MAX_SCREEN_CHARS)
    .replace(/-$/, '');
  const file = `${stem || FALLBACK_SCREEN}-${viewportSlug}.png`;
  return path.join(screenshotDir, ...segments, file);
}

/**
 * Hands out one file per screen for the life of a session.
 *
 * `screenshotPath` alone is not enough: two different `screen` values can slugify to the same
 * stem (`ログイン` and `!!!` both slugify to nothing), and the second write would then destroy
 * the first screenshot while the tool still reported success — design-loop lists screenshots by
 * scanning the directory, so nothing downstream would notice. A path already claimed by another
 * screen therefore gets a `-2`, `-3`, … suffix (the rule T09 step 7 uses for report files) and a
 * warning naming both screens. Re-shooting the SAME screen keeps its path and overwrites, which
 * is the fix-and-re-check loop working as intended.
 */
export function makeScreenshotNamer(
  screenshotDir: string,
  log: (message: string) => void = (message) => write(2, message),
) {
  const claimed = new Map<string, string>();
  return {
    resolve(screen: string, viewport: BrowserViewport): string {
      const base = screenshotPath(screenshotDir, screen, viewport);
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length);
      for (let n = 1; ; n += 1) {
        const candidate = n === 1 ? base : `${stem}-${n}${ext}`;
        const owner = claimed.get(candidate);
        if (owner !== undefined && owner !== screen) continue;
        if (candidate !== base) {
          log(
            `warning: screenshot name clash — screen "${screen}" resolves to ${base}, already ` +
              `taken by screen "${claimed.get(base)}"; saving as ${candidate} instead`,
          );
        }
        claimed.set(candidate, screen);
        return candidate;
      }
    },
  };
}

/** A page that has never navigated: Playwright reports `about:blank`, some builds `''`. */
export function isBlankPage(url: string): boolean {
  const value = url.trim();
  return value === '' || value === 'about:blank';
}

/**
 * The refusal a screenshot of a viewport with no successful navigation gets (T14).
 *
 * Each viewport is its own browser context, so `browser_goto` on `mobile` leaves `desktop` at
 * `about:blank`. Observed in the T14 acceptance run: the agent navigated once, then took the
 * mobile *and* desktop screenshots of "the same screen" — and the desktop PNG was a blank white
 * page that the workflow went on to present as verification of the change. Silent blank evidence
 * is the one outcome this workflow exists to prevent, so the tool refuses and says exactly which
 * call is missing; the agent still has steps left to make it.
 *
 * The same refusal covers a `browser_goto` that FAILED (dev server not up yet, wrong port): the
 * URL check alone does not, because Chromium leaves `page.url()` set to the URL it could not
 * load while the page itself is blank.
 */
export function blankViewportError(viewport: BrowserViewport, lastUrl: string): ToolError {
  return {
    error:
      `viewport "${viewport}" has not been navigated successfully yet — a screenshot of it would ` +
      `be a blank page. Call browser_goto {"url":"${lastUrl || '<the URL of that screen>'}","viewport":"${viewport}"} ` +
      'first (and check it returned a url/title, not an error), then take the screenshot again. ' +
      'Every viewport is a separate browser window and must be navigated on its own.',
  };
}

/**
 * The bodies behind the tools, as plainly-typed async functions.
 * `makeBrowserTools` wraps these; scripts (and later workflows) can call them directly
 * without synthesising AI SDK tool-execution options.
 */
export function makeBrowserActions(opts: BrowserToolsOptions) {
  const { screenshotDir, viewports } = opts;
  const namer = makeScreenshotNamer(screenshotDir, opts.log);
  /** Last URL any viewport reached, so the refusal above can name the call to make. */
  let lastUrl = '';
  /**
   * Viewports whose most recent `browser_goto` succeeded — tracked, never inferred from
   * `page.url()`. A refused/timed-out navigation leaves Chromium showing a blank page while
   * `page.url()` reports the URL it failed to load, so the URL alone cannot tell the two apart
   * and a blank PNG would be written and presented as verification.
   */
  const navigated = new Set<BrowserViewport>();

  return {
    async goto(input: { url: string; viewport: BrowserViewport }): Promise<GotoResult> {
      try {
        const { page } = await getSession(input.viewport, viewports);
        await page.goto(input.url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
        lastUrl = page.url();
        navigated.add(input.viewport);
        return { url: page.url(), title: await page.title() };
      } catch (err) {
        // A failed navigation invalidates whatever was on screen before it.
        navigated.delete(input.viewport);
        return errorOf(err);
      }
    },

    async screenshot(input: {
      screen: string;
      viewport: BrowserViewport;
    }): Promise<ScreenshotResult> {
      try {
        const { page } = await getSession(input.viewport, viewports);
        // Before the name is claimed: a refused screenshot must not burn the file name its
        // retry will need.
        if (!navigated.has(input.viewport) || isBlankPage(page.url())) {
          return blankViewportError(input.viewport, lastUrl);
        }
        const file = namer.resolve(input.screen, input.viewport);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: true });
        return { path: file };
      } catch (err) {
        return errorOf(err);
      }
    },

    async click(input: { selector: string; viewport: BrowserViewport }): Promise<ClickResult> {
      try {
        const { page } = await getSession(input.viewport, viewports);
        await page.click(input.selector, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, selector: input.selector };
      } catch (err) {
        return errorOf(err);
      }
    },

    async fill(input: {
      selector: string;
      value: string;
      viewport: BrowserViewport;
    }): Promise<FillResult> {
      try {
        const { page } = await getSession(input.viewport, viewports);
        await page.fill(input.selector, input.value, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, selector: input.selector };
      } catch (err) {
        return errorOf(err);
      }
    },

    /** Drains the buffer: each message is reported exactly once. */
    async consoleErrors(input: { viewport: BrowserViewport }): Promise<ConsoleErrorsResult> {
      const pending = sessions.get(input.viewport);
      if (!pending) return { count: 0, errors: [] };
      try {
        const session = await pending;
        const errors = session.errors.splice(0, session.errors.length);
        return { count: errors.length, errors };
      } catch (err) {
        return { count: 1, errors: [errorOf(err).error] };
      }
    },
  };
}

export type BrowserActions = ReturnType<typeof makeBrowserActions>;

/**
 * Playwright tools for the `designer` and `tester` profiles (SPEC § Tools table).
 * The browser is a module-level singleton, so repeated calls share one Chromium process;
 * workflows must call `closeBrowser()` when they finish.
 */
export function makeBrowserTools(opts: BrowserToolsOptions) {
  const actions = makeBrowserActions(opts);
  const viewport = BrowserViewport.describe('which browser context to use');

  return {
    browser_goto: tool({
      description: 'Navigate a viewport to a URL and return the final URL and page title.',
      inputSchema: z.object({ url: z.string().describe('absolute URL to open'), viewport }),
      execute: (input): Promise<GotoResult> => actions.goto(input),
    }),

    browser_screenshot: tool({
      description:
        'Save a full-page PNG of a viewport to <screenshotDir>/<screen>-<viewport>.png and return the path. ' +
        'The viewport must have been opened with browser_goto first — each viewport is a separate ' +
        'browser window, so shooting one you only navigated in the other viewport is refused.',
      inputSchema: z.object({
        screen: z
          .string()
          .describe(
            'short name of the screen, e.g. "login" — never include the viewport, it is appended',
          ),
        viewport,
      }),
      execute: (input): Promise<ScreenshotResult> => actions.screenshot(input),
    }),

    browser_click: tool({
      description: 'Click the first element matching a CSS/text selector in a viewport.',
      inputSchema: z.object({ selector: z.string(), viewport }),
      execute: (input): Promise<ClickResult> => actions.click(input),
    }),

    browser_fill: tool({
      description: 'Fill an input/textarea matching a selector with a value.',
      inputSchema: z.object({ selector: z.string(), value: z.string(), viewport }),
      execute: (input): Promise<FillResult> => actions.fill(input),
    }),

    browser_console_errors: tool({
      description:
        'Return console errors and uncaught page errors collected since the last call, then clear the buffer.',
      inputSchema: z.object({ viewport }),
      execute: (input): Promise<ConsoleErrorsResult> => actions.consoleErrors(input),
    }),
  };
}

export type BrowserTools = ReturnType<typeof makeBrowserTools>;
