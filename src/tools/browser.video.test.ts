/**
 * T15 `--video`, against a real Chromium — the one claim in this feature that no pure function
 * can carry: Playwright writes the `.webm` only when the context CLOSES, under a name it picks
 * at random, and `closeBrowser` has to turn that into a deterministic, non-empty, playable file.
 *
 * The page is served over HTTP from an ephemeral port rather than a `data:`/`file:` URL, because
 * `browser_goto` waits for `networkidle` and that is the shape of navigation the workflow does.
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { VIDEO_FILE, closeBrowser, makeBrowserActions } from './browser';

const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;

/**
 * The same override `getBrowser` honours, resolved once for both launch sites in this file.
 * Without it, machines whose Playwright cache holds a different Chromium revision (or none)
 * would fail every test here on launch — with no usable binary at all the suite skips instead,
 * the same posture diff.test.ts takes towards its optional seeded run.
 */
const CHROMIUM_PATH = process.env.AW_CHROMIUM_PATH?.trim() || undefined;
const hasChromium = (() => {
  try {
    return fs.existsSync(CHROMIUM_PATH ?? chromium.executablePath());
  } catch {
    return false;
  }
})();

/** A page with movement in it, so the recording is not one repeated still frame. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>t15</title>
<style>body{margin:0;font:48px system-ui}div{padding:2rem}</style>
<div id="t">0</div>
<script>let n=0;setInterval(()=>{document.getElementById('t').textContent=String(++n)},40)</script>`;

let server: Server;
let url = '';

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await closeBrowser(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * How long the recorded file plays, according to a browser asked to play it.
 *
 * The probe page is written NEXT TO the video and opened over `file://`, so the media request
 * is same-directory: a `file://` source loaded from a `setContent` page is refused outright,
 * which reads as "the video is broken" when the video is fine.
 */
async function playableSeconds(file: string): Promise<number> {
  const probe = path.join(path.dirname(file), 'aw-probe.html');
  fs.writeFileSync(probe, `<video id="v" preload="auto" src="${path.basename(file)}"></video>`);
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_PATH });
  try {
    const page = await browser.newPage();
    await page.goto(`file://${probe}`);
    return await page.evaluate(async () => {
      const video = document.getElementById('v') as HTMLVideoElement;
      const deadline = Date.now() + 20_000;
      // Polled rather than event-driven: the element starts loading from its `src` attribute
      // before this script runs, so a `durationchange` listener can be attached too late.
      for (;;) {
        if (video.error) throw new Error(`the browser refused the file: ${video.error.message}`);
        if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
        if (Date.now() > deadline) throw new Error('timed out waiting for the duration');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  } finally {
    await browser.close();
  }
}

describe.skipIf(!hasChromium)('recordVideo (real chromium)', () => {
  let dir = '';
  let files: string[] = [];

  it('writes one deterministically named, non-empty webm per viewport', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-t15-'));
    const actions = makeBrowserActions({
      screenshotDir: dir,
      viewports: VIEWPORTS,
      video: { dir },
    });

    // Mobile first, desktop second: the primary must be chosen by viewport, not by arrival.
    for (const viewport of ['mobile', 'desktop'] as const) {
      expect(await actions.goto({ url, viewport })).toMatchObject({ title: 't15' });
      expect(await actions.screenshot({ screen: 'home', viewport })).toHaveProperty('path');
    }

    const videos = await closeBrowser(() => undefined);
    expect(videos.map((v) => [v.viewport, path.basename(v.path), v.primary])).toEqual([
      ['mobile', 'video-mobile.webm', false],
      ['desktop', VIDEO_FILE, true],
    ]);
    for (const video of videos) {
      expect(fs.existsSync(video.path)).toBe(true);
      expect(video.bytes).toBe(fs.statSync(video.path).size);
      expect(video.bytes).toBeGreaterThan(0);
    }

    files = fs.readdirSync(dir).sort();
  }, 120_000);

  it('leaves Playwright’s randomly named original behind for nobody to commit', () => {
    // `git add -A` in the checkpoint commit picks up whatever is in this directory, so a
    // forgotten temporary is a second copy of the video in the target repo's history.
    expect(files).toEqual([
      'home-desktop.png',
      'home-mobile.png',
      'video-mobile.webm',
      VIDEO_FILE,
    ]);
  });

  it('produces a file a browser will actually play, with a real duration', async () => {
    const seconds = await playableSeconds(path.join(dir, VIDEO_FILE));
    expect(seconds).toBeGreaterThan(0);
    expect(Number.isFinite(seconds)).toBe(true);
  }, 120_000);

  it('reports nothing on a second close, so an idempotent cleanup cannot double-count', async () => {
    expect(await closeBrowser(() => undefined)).toEqual([]);
  });
});
