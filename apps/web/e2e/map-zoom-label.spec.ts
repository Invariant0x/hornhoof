import { expect, test, type Page } from '@playwright/test';
import { LANGUAGES, type Language } from '../src/i18n';
import { BUILTIN_SKINS, type BuiltinSkinId } from '../src/skins/registry';
import { serveApi } from './api';

/* The map's scale readout fits every percentage from shortest to three digits without clipping, ellipsis or hidden overflow,
   in every built-in skin, every shipped language and right-to-left layout, while its three neighbour buttons stay >= 44 px. */
test.describe.configure({ timeout: 0 });

const SKINS: readonly BuiltinSkinId[] = BUILTIN_SKINS.map(s => s.id);

type ZoomCheck = {
  text: string;
  zvClientWidth: number;
  zvScrollWidth: number;
  zvClientHeight: number;
  zvScrollHeight: number;
  overflowX: string;
  overflowY: string;
  textOverflow: string;
  whiteSpace: string;
  flexShrink: string;
  fontFamily: string;
  fontWeight: string;
  fontVariantNumeric: string;
  paddingLeft: number;
  paddingRight: number;
  lines: number;
  startPad: number;
  endPad: number;
  topPad: number;
  bottomPad: number;
  hitsOwn: boolean;
  insideViewport: boolean;
  pageOverflows: boolean;
  overlapsTicker: boolean;
  ordered: boolean;
  buttons: { width: number; height: number; flexShrink: string }[];
};

async function openMap(page: Page, language: Language, skin: BuiltinSkinId, dir: 'ltr' | 'rtl', width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.evaluate(({ language, skin }) => {
    localStorage.clear();
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', skin);
  }, { language, skin });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(d => {
    document.documentElement.dir = d;
  }, dir);
  await expect(page.locator('.map .zoom .zv')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function measureZoom(page: Page, dir: 'ltr' | 'rtl', rootSelector: '.map' | '.dview' = '.map'): Promise<ZoomCheck> {
  return page.evaluate(({ d, rootSelector }) => {
    const root = document.querySelector<HTMLElement>(rootSelector)!;
    const zoom = root.querySelector<HTMLElement>('.zoom')!;
    const zv = zoom.querySelector<HTMLElement>('.zv')!;
    const btns = [...zoom.querySelectorAll<HTMLElement>('.zbtn')];
    const ticker = root.querySelector<HTMLElement>('.ticker');

    const range = document.createRange();
    range.selectNodeContents(zv);
    const textRect = range.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
    const tops: number[] = [];
    for (const r of rects) {
      if (!tops.some(t => Math.abs(t - r.top) <= 2)) tops.push(r.top);
    }
    const lines = tops.length;
    const zvRect = zv.getBoundingClientRect();
    const zoomRect = zoom.getBoundingClientRect();
    const style = getComputedStyle(zv);

    const midY = (textRect.top + textRect.bottom) / 2;
    const sampleXs = [textRect.left + 1, (textRect.left + textRect.right) / 2, textRect.right - 1];
    const hitsOwn = textRect.width > 0 && sampleXs.every(x => {
      const hit = document.elementFromPoint(x, midY);
      return hit === zv || (hit !== null && zv.contains(hit));
    });

    const overlapsTicker = (() => {
      if (!ticker) return false;
      const t = ticker.getBoundingClientRect();
      return !(zoomRect.right <= t.left || zoomRect.left >= t.right || zoomRect.bottom <= t.top || zoomRect.top >= t.bottom);
    })();

    const [outBtn, inBtn, fitBtn] = btns.map(b => b.getBoundingClientRect());
    const ordered = Boolean(outBtn && inBtn && fitBtn) && (
      d === 'ltr'
        ? outBtn!.right <= zvRect.left + 0.5 && zvRect.right <= inBtn!.left + 0.5 && inBtn!.right <= fitBtn!.left + 0.5
        : fitBtn!.right <= inBtn!.left + 0.5 && inBtn!.right <= zvRect.left + 0.5 && zvRect.right <= outBtn!.left + 0.5
    );

    return {
      text: zv.textContent ?? '',
      zvClientWidth: zv.clientWidth,
      zvScrollWidth: zv.scrollWidth,
      zvClientHeight: zv.clientHeight,
      zvScrollHeight: zv.scrollHeight,
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      flexShrink: style.flexShrink,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontVariantNumeric: style.fontVariantNumeric,
      paddingLeft: parseFloat(style.paddingLeft),
      paddingRight: parseFloat(style.paddingRight),
      lines,
      startPad: textRect.left - zvRect.left,
      endPad: zvRect.right - textRect.right,
      topPad: textRect.top - zvRect.top,
      bottomPad: zvRect.bottom - textRect.bottom,
      hitsOwn,
      insideViewport: zoomRect.left >= 0 && zoomRect.right <= window.innerWidth,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth,
      overlapsTicker,
      ordered,
      buttons: btns.map(b => {
        const r = b.getBoundingClientRect();
        return { width: r.width, height: r.height, flexShrink: getComputedStyle(b).flexShrink };
      }),
    };
  }, { d: dir, rootSelector });
}

function assertWholeZoom(m: ZoomCheck, context: string) {
  expect(m.text, `${context}: percentage text`).toMatch(/^\d+%$/);
  expect(m.zvScrollWidth, `${context}: scrollWidth <= clientWidth`).toBeLessThanOrEqual(m.zvClientWidth);
  expect(m.zvScrollHeight, `${context}: scrollHeight <= clientHeight`).toBeLessThanOrEqual(m.zvClientHeight);
  expect(m.overflowX, `${context}: no hidden x overflow`).toBe('visible');
  expect(m.overflowY, `${context}: no hidden y overflow`).toBe('visible');
  expect(m.textOverflow, `${context}: no ellipsis`).toBe('clip');
  expect(m.whiteSpace, `${context}: single line nowrap`).toBe('nowrap');
  expect(m.flexShrink, `${context}: label does not shrink`).toBe('0');
  expect(m.fontFamily, `${context}: readable body font token`).toMatch(/\bOnest\b/);
  expect(m.fontWeight, `${context}: explicit 500 face`).toBe('500');
  expect(m.fontVariantNumeric, `${context}: tabular digits`).toContain('tabular-nums');
  expect(m.paddingLeft, `${context}: token left padding`).toBeGreaterThanOrEqual(8);
  expect(m.paddingRight, `${context}: token right padding`).toBeGreaterThanOrEqual(8);
  expect(m.lines, `${context}: one rendered text line`).toBe(1);
  expect(m.startPad, `${context}: start glyph clearance`).toBeGreaterThanOrEqual(6);
  expect(m.endPad, `${context}: end glyph clearance`).toBeGreaterThanOrEqual(6);
  expect(m.topPad, `${context}: top glyph clearance`).toBeGreaterThanOrEqual(0);
  expect(m.bottomPad, `${context}: bottom glyph clearance`).toBeGreaterThanOrEqual(0);
  expect(m.hitsOwn, `${context}: nothing covers or clips the glyphs`).toBe(true);
  expect(m.insideViewport, `${context}: zoom bar inside viewport`).toBe(true);
  expect(m.pageOverflows, `${context}: no horizontal page scroll`).toBe(false);
  expect(m.overlapsTicker, `${context}: zoom bar clear of ticker`).toBe(false);
  expect(m.ordered, `${context}: buttons and label ordered for ${context}`).toBe(true);
  expect(m.buttons, `${context}: three zoom buttons`).toHaveLength(3);
  for (const btn of m.buttons) {
    expect(btn.flexShrink, `${context}: button does not shrink`).toBe('0');
    expect(btn.width, `${context}: button width >= 44 px`).toBeGreaterThanOrEqual(44);
    expect(btn.height, `${context}: button height >= 44 px`).toBeGreaterThanOrEqual(44);
  }
}

async function setWheelFromMin(page: Page, rootSelector: '.map' | '.dview', canvasSelector: string, minK: number, targetK: number) {
  await page.evaluate(({ rootSelector, canvasSelector, minK, targetK }) => {
    const btns = document.querySelectorAll<HTMLButtonElement>(`${rootSelector} .zoom .zbtn`);
    for (let i = 0; i < 20; i++) btns[0]!.click();
    if (targetK > minK) {
      const deltaY = -Math.log(targetK / minK) / 0.0015;
      document.querySelector<HTMLElement>(canvasSelector)!.dispatchEvent(
        new WheelEvent('wheel', { deltaY, clientX: 200, clientY: 200, bubbles: true, cancelable: true }),
      );
    }
  }, { rootSelector, canvasSelector, minK, targetK });
}

async function sweepScales(page: Page, dir: 'ltr' | 'rtl', context: string, checkButtonsPointer: boolean) {
  const zv = page.locator('.map .zoom .zv');
  const btns = page.locator('.map .zoom .zbtn');

  /* Initial fitted scale on the map ("115%" at 1440, "41%" at 375). */
  const initial = await measureZoom(page, dir);
  assertWholeZoom(initial, `${context} initial (${initial.text})`);

  if (checkButtonsPointer) {
    await btns.nth(1).click();
    assertWholeZoom(await measureZoom(page, dir), `${context} pointer zoom-in`);
    await btns.nth(0).click();
    assertWholeZoom(await measureZoom(page, dir), `${context} pointer zoom-out`);
    await btns.nth(2).click();
    assertWholeZoom(await measureZoom(page, dir), `${context} pointer fit`);
  }

  for (const [k, label] of [[0.3, '30%'], [1, '100%'], [1.15, '115%'], [1.38, '138%'], [2, '200%'], [2.5, '250%']] as const) {
    await setWheelFromMin(page, '.map', '.map', 0.3, k);
    await expect(zv).toHaveText(label);
    assertWholeZoom(await measureZoom(page, dir), `${context} (${label})`);
  }

  /* Restore fitted scale via the Fit button. */
  await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.map .zoom .zbtn')[2]!.click());
  if (context.includes('1440')) await expect(zv).toHaveText('115%');
  assertWholeZoom(await measureZoom(page, dir), `${context} fit`);
}

test('map: scale label fits whole across scales and skins, en and ru ltr, at 1440', async ({ page }) => {
  await serveApi(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const { id } of LANGUAGES) {
    for (const skin of SKINS) {
      await openMap(page, id, skin, 'ltr', 1440);
      await expect(page.locator('.map .zoom .zv')).toHaveText('115%');
      await sweepScales(page, 'ltr', `${id} ltr ${skin} 1440`, skin === 'cyberpunk');
    }
  }
  /* Minimum department scale ("15%") on the shared ZoomBar inside a department canvas. */
  await openMap(page, 'en', 'cyberpunk', 'ltr', 1440);
  await page.locator('.dept').first().click();
  await expect(page.locator('.dview .zoom .zv')).toBeVisible();
  await setWheelFromMin(page, '.dview', '.dcanvas', 0.15, 0.15);
  await expect(page.locator('.dview .zoom .zv')).toHaveText('15%');
  assertWholeZoom(await measureZoom(page, 'ltr', '.dview'), 'en ltr cyberpunk 1440 dept (15%)');
});

test('map: scale label fits whole across scales and skins, en and ru ltr, at 375', async ({ page }) => {
  await serveApi(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const { id } of LANGUAGES) {
    for (const skin of SKINS) {
      await openMap(page, id, skin, 'ltr', 375);
      await sweepScales(page, 'ltr', `${id} ltr ${skin} 375`, skin === 'cyberpunk');
    }
  }
});

test('map: scale label fits whole across scales and skins, right to left, at 1440 and 375', async ({ page }) => {
  await serveApi(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const { id } of LANGUAGES) {
    for (const skin of SKINS) {
      await openMap(page, id, skin, 'rtl', 1440);
      await sweepScales(page, 'rtl', `${id} rtl ${skin} 1440`, skin === 'cyberpunk');
      await page.setViewportSize({ width: 375, height: 812 });
      await page.evaluate(() => document.querySelectorAll<HTMLButtonElement>('.map .zoom .zbtn')[2]!.click());
      await sweepScales(page, 'rtl', `${id} rtl ${skin} 375`, skin === 'light');
    }
  }
});
