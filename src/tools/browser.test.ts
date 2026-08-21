import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blankViewportError,
  isBlankPage,
  makeScreenshotNamer,
  normalizeScreenName,
  screenshotPath,
} from './browser';

const DIR = '/repo/screenshots/add-a-placeholder-about-team-page-with';

/** SPEC § design-loop: screenshots are `<screen>-<viewport>.png`, and nothing else. */
function name(screen: string, viewport: 'mobile' | 'desktop'): string {
  return path.basename(screenshotPath(DIR, screen, viewport));
}

describe('normalizeScreenName', () => {
  it('leaves a screen name that carries no viewport word alone', () => {
    expect(normalizeScreenName('about-team', 'mobile')).toBe('about-team');
    expect(normalizeScreenName('login', 'desktop')).toBe('login');
  });

  it('drops a trailing token equal to the viewport being appended', () => {
    expect(normalizeScreenName('about-team-mobile', 'mobile')).toBe('about-team');
    expect(normalizeScreenName('about-team-desktop', 'desktop')).toBe('about-team');
  });

  it('drops a repeated trailing viewport word', () => {
    expect(normalizeScreenName('about-team-mobile-mobile', 'mobile')).toBe('about-team');
  });

  it('keeps a viewport word that is not the trailing token', () => {
    // Only the trailing token can duplicate the suffix; stripping the others made distinct
    // screens collide onto one file.
    expect(normalizeScreenName('about-team-desktop-after', 'desktop')).toBe(
      'about-team-desktop-after',
    );
    expect(normalizeScreenName('mobile-nav', 'mobile')).toBe('mobile-nav');
  });

  it('keeps a trailing word naming the OTHER viewport', () => {
    // `home-desktop` at mobile must not become `home`, which another screen already owns.
    expect(normalizeScreenName('home-desktop', 'mobile')).toBe('home-desktop');
  });

  it('never returns an empty name', () => {
    expect(normalizeScreenName('mobile', 'mobile')).toBe('mobile');
    expect(normalizeScreenName('', 'mobile')).toBe('screen');
  });
});

describe('screenshotPath', () => {
  it('composes <screen>-<viewport>.png', () => {
    expect(name('about-team', 'mobile')).toBe('about-team-mobile.png');
    expect(name('about-team', 'desktop')).toBe('about-team-desktop.png');
  });

  it('does not double the viewport the model already wrote into the screen name', () => {
    // The file the live design-loop run actually produced was about-team-mobile-mobile.png.
    expect(name('about-team-mobile', 'mobile')).toBe('about-team-mobile.png');
  });

  it('keeps distinct screens in distinct files', () => {
    // The regression this replaced: `mobile-nav`, `desktop-nav` and `nav` all resolved to
    // nav-<viewport>.png, so one responsive-nav run shot four screenshots and kept two.
    const files = ['mobile-nav', 'desktop-nav', 'nav'].map((s) => name(s, 'mobile'));
    expect(new Set(files).size).toBe(3);
    expect(new Set(['home', 'home-mobile', 'desktop-home'].map((s) => name(s, 'desktop'))).size,
    ).toBe(3);
  });

  it('still distinguishes the two viewports of one screen', () => {
    expect(name('about-team-mobile', 'desktop')).toBe('about-team-mobile-desktop.png');
    expect(name('nav', 'mobile')).toBe('nav-mobile.png');
    expect(name('nav', 'desktop')).toBe('nav-desktop.png');
  });

  it('always ends in exactly one -<viewport>.png suffix', () => {
    for (const screen of ['home', 'home-mobile', 'home-desktop-mobile', 'mobile', '']) {
      for (const viewport of ['mobile', 'desktop'] as const) {
        const file = name(screen, viewport);
        expect(file.endsWith(`-${viewport}.png`)).toBe(true);
        expect(file.startsWith('-')).toBe(false);
        expect(file).not.toContain(`-${viewport}-${viewport}`);
      }
    }
  });

  it('caps the file-name stem so a long screen name cannot fail with ENAMETOOLONG', () => {
    const file = name('a'.repeat(300), 'mobile');
    expect(file.length).toBeLessThanOrEqual(96);
    expect(file.endsWith('-mobile.png')).toBe(true);
  });

  it('nests on "/" and normalises only the file name', () => {
    expect(screenshotPath(DIR, 'about/team-mobile', 'mobile')).toBe(
      path.join(DIR, 'about', 'team-mobile.png'),
    );
    // A directory named after a viewport is the agent's own grouping and is left as it is.
    expect(screenshotPath(DIR, 'mobile/nav', 'mobile')).toBe(
      path.join(DIR, 'mobile', 'nav-mobile.png'),
    );
  });

  it('cannot escape the screenshot directory', () => {
    const file = screenshotPath(DIR, '../../etc/passwd', 'mobile');
    expect(file.startsWith(`${DIR}${path.sep}`)).toBe(true);
    expect(file).toBe(path.join(DIR, 'etc', 'passwd-mobile.png'));
  });
});

describe('makeScreenshotNamer', () => {
  function namer() {
    const warnings: string[] = [];
    return { n: makeScreenshotNamer(DIR, (m) => warnings.push(m)), warnings };
  }

  it('gives one path per screen and reuses it when the same screen is re-shot', () => {
    const { n, warnings } = namer();
    const first = n.resolve('checkout', 'mobile');
    expect(n.resolve('checkout', 'mobile')).toBe(first);
    expect(n.resolve('checkout', 'desktop')).not.toBe(first);
    expect(warnings).toEqual([]);
  });

  it('never lets one screen overwrite another, and says so', () => {
    const { n, warnings } = namer();
    // Both names slugify to nothing, so both resolve to screen-mobile.png.
    const first = n.resolve('\u30ed\u30b0\u30a4\u30f3', 'mobile');
    const second = n.resolve('!!!', 'mobile');
    expect(first).toBe(path.join(DIR, 'screen-mobile.png'));
    expect(second).toBe(path.join(DIR, 'screen-mobile-2.png'));
    expect(n.resolve('???', 'mobile')).toBe(path.join(DIR, 'screen-mobile-3.png'));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('screenshot name clash');
    expect(warnings[0]).toContain('!!!');
  });

  it('does not collide for the responsive-nav case at all', () => {
    const { n, warnings } = namer();
    const files = ['mobile-nav', 'desktop-nav'].flatMap((s) => [
      n.resolve(s, 'mobile'),
      n.resolve(s, 'desktop'),
    ]);
    expect(new Set(files).size).toBe(4);
    expect(warnings).toEqual([]);
  });
});

describe('isBlankPage', () => {
  it('recognises a page that has never navigated', () => {
    expect(isBlankPage('about:blank')).toBe(true);
    expect(isBlankPage('')).toBe(true);
    expect(isBlankPage('   ')).toBe(true);
  });

  it('leaves a real URL alone', () => {
    expect(isBlankPage('http://localhost:5173/#/placeholder')).toBe(false);
  });
});

describe('blankViewportError', () => {
  it('names the exact browser_goto the agent skipped', () => {
    const { error } = blankViewportError('desktop', 'http://localhost:5173/#/placeholder');
    expect(error).toContain(
      'browser_goto {"url":"http://localhost:5173/#/placeholder","viewport":"desktop"}',
    );
    expect(error).toContain('blank');
  });

  it('still explains itself when no URL has been visited yet', () => {
    const { error } = blankViewportError('mobile', '');
    expect(error).toContain('"url":"<the URL of that screen>"');
  });
});
