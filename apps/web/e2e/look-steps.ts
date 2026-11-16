import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Language, Messages } from '../src/i18n';
import { builtinSkin } from '../src/skins/registry';
import type { Skin } from '../src/skins/roles';

/* What the checks of a place's look in every skin share, as a person meets it: feedback-steps.ts and stage1-forms-steps.ts
   open their places, measure them and keep what each engine measured with these steps. */

/* The fonts of a skin, own standing for the skin of a person's own: blocks stand in the same place in every skin written in
   the same fonts. Skins whose headings and text start with the same font lay out the same; Onest and Tektur are carried,
   so the rest of a stack never shows. */
export const fontsOf = (choice: string, own: Skin) => {
  const { fonts } = builtinSkin(choice) ?? own;
  return `${fonts.display[0]} ${fonts.body[0]}`;
};

export async function messagesFor(locale: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>;
  return dictionary[locale]!;
}

/* What WebKit says of a request to the app's API that a navigation of the page cut off, the page having caught it or
   not: "Fetch API cannot load <origin>/api/... due to access control checks." That is the engine's word, and no error
   of the page (#1090), and it is all that is let go: a rejection nobody caught still comes as "TypeError: Load failed",
   and a request cut off anywhere but the API counts. Read from the first line of the stack, which keeps the address. */
export function cutByNavigation(page: Page, error: Error): boolean {
  if (page.context().browser()?.browserType().name() !== 'webkit') return false;
  const origin = new URL(page.url()).origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Fetch API cannot load ${origin}/api/\\S* due to access control checks\\.$`).test(error.stack?.split('\n', 1)[0] ?? '');
}

/* Errors of the page, and any file of the app it could not load. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', error => { if (!cutByNavigation(page, error)) problems.push(error.message); });
  page.on('response', response => { if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  return problems;
}

export type Place = { open: (page: Page, words: Messages) => Promise<Locator> };

/* A place opened the way a person opens it, once it shows and its fonts are in. */
export async function openPlace(page: Page, place: Place, words: Messages): Promise<Locator> {
  const found = await place.open(page, words);
  await expect(found).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return found;
}

/* Where every block and control of the place that the selectors name stands, with its padding, margin, border and font. */
export async function geometry(place: Locator, selectors: readonly string[]): Promise<Record<string, unknown>[]> {
  return place.evaluate((root, selectors) => {
    const seen = new Set<Element>();
    const out: Record<string, unknown>[] = [];
    const origin = root.getBoundingClientRect();
    for (const selector of selectors) {
      const found = selector === ':scope' ? [root] : [...root.querySelectorAll(selector)];
      for (const element of found) {
        if (seen.has(element)) continue;
        seen.add(element);
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        out.push({
          what: `${selector} ${element.textContent?.trim().slice(0, 24) ?? ''}`,
          x: Math.round((box.x - origin.x) * 100) / 100, y: Math.round((box.y - origin.y) * 100) / 100,
          width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100,
          padding: style.padding, margin: style.margin, border: style.borderWidth, font: `${style.fontFamily.split(',')[0]} ${style.fontSize} ${style.lineHeight} ${style.fontWeight}`,
        });
      }
    }
    return out;
  }, selectors);
}

/* The lowest WCAG contrast of the text that can be read in the place, each element's colour on the backgrounds behind it. */
export async function lowestContrast(place: Locator): Promise<{ ratio: number; what: string }> {
  return place.evaluate(root => {
    const parse = (value: string): number[] => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : [0, 0, 0, 0];
    };
    const over = (top: number[], under: number[]) => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!)).concat(1);
    const luminance = (c: number[]) => [0, 1, 2].map(i => c[i]! / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const behind = (element: Element | null): number[] => {
      const layers: number[][] = [];
      for (let at = element; at; at = at.parentElement) layers.push(parse(getComputedStyle(at).backgroundColor));
      return layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255, 1]);
    };
    let lowest = { ratio: Infinity, what: '' };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || !walker.currentNode.textContent?.trim() || !parent.getClientRects().length || parent.closest(':disabled, .sr, [aria-hidden="true"]')) continue;
      const ground = behind(parent);
      const [a, b] = [luminance(over(parse(getComputedStyle(parent).color), ground)), luminance(ground)].sort((x, y) => y - x);
      const ratio = Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
      if (ratio < lowest.ratio) lowest = { ratio, what: `${parent.tagName.toLowerCase()}.${parent.className} ${parent.textContent?.trim().slice(0, 30)}` };
    }
    return lowest;
  });
}

/* A picture of the whole place for Design. A place taller than the window is shot whole: the window grows in height only,
   so nothing moves sideways, the place stands in its middle clear of the bar on top, and the window goes back after it. */
export async function shoot(page: Page, place: Locator, path: string) {
  const size = page.viewportSize()!;
  const room = Math.ceil((await place.boundingBox())!.height) + 240;
  if (room > size.height) await page.setViewportSize({ width: size.width, height: room });
  await place.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await place.screenshot({ path, animations: 'disabled' });
  if (room > size.height) await page.setViewportSize(size);
}

/* What an engine measured, kept in a file of the test's output so the engines can be compared. */
export function keep(info: TestInfo, name: string, body: unknown) {
  const path = info.outputPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}
