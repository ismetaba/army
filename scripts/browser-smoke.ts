/**
 * T06 smoke test: screenshot a URL at both default viewports.
 *
 *   npx tsx scripts/browser-smoke.ts [url]
 *
 * Writes `screenshots/smoke/smoke-mobile.png` and `screenshots/smoke/smoke-desktop.png`,
 * prints both paths and the console-error count, then closes the browser. Exit 0 on success,
 * 1 if any step failed.
 */
import path from 'node:path';
import { closeBrowser, makeBrowserActions, type BrowserViewport } from '../src/tools/browser';

const DEFAULT_URL = 'https://example.com';
// SPEC § AwConfig.viewports defaults.
const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  desktop: { width: 1440, height: 900 },
} as const;

async function main(): Promise<number> {
  const url = process.argv[2]?.trim() || DEFAULT_URL;
  const screenshotDir = path.resolve('screenshots/smoke');
  const browser = makeBrowserActions({ screenshotDir, viewports: VIEWPORTS });

  console.log(`url: ${url}`);
  let failed = false;

  for (const viewport of ['mobile', 'desktop'] as const satisfies readonly BrowserViewport[]) {
    const nav = await browser.goto({ url, viewport });
    if ('error' in nav) {
      console.error(`${viewport}: goto failed: ${nav.error}`);
      failed = true;
      continue;
    }
    const shot = await browser.screenshot({ screen: 'smoke', viewport });
    if ('error' in shot) {
      console.error(`${viewport}: screenshot failed: ${shot.error}`);
      failed = true;
      continue;
    }
    const { count, errors } = await browser.consoleErrors({ viewport });
    console.log(`${viewport}: ${shot.path} (${VIEWPORTS[viewport].width}px, "${nav.title}")`);
    console.log(`${viewport}: console errors: ${count}`);
    for (const message of errors) console.log(`  ${message}`);
  }

  return failed ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`browser-smoke failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  // Always release Chromium so the process can exit.
  await closeBrowser();
}
process.exit(code);
