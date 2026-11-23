import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { collectionText } from '../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin, type BuiltinSkinId } from '../src/skins/registry';
import { COLOR_TOKENS, type Skin } from '../src/skins/roles';
import { builtinFile, parseSkin, skinText } from '../src/skins/validate';
import { serveApi } from './api';

/* The Themes part of Settings, under Appearance & language, and the account menu without a row of its own, in every
   built-in skin and one of a person's own: what each looks like, that switching moves no block among skins written in the same fonts, that text
   stays readable, that nothing runs off the screen, also mirrored right to left, and that the chosen skin is on the page
   before the app starts. Its files are added, refused in plain words, downloaded as samples, removed and put back. */
const CYBERPUNK = builtinSkin('cyberpunk')!;
const SAMPLE = builtinFile(CYBERPUNK, { ru: 'Сумерки', en: 'Dusk' });
const OWN: Skin = {
  ...SAMPLE,
  colors: { ...SAMPLE.colors, bg: '#10002B', surface: '#1A0440', surface2: '#240A52', accent: '#FF9E00', accent_ink: '#FFC266', button: '#FF9E00', on_button: '#1A0E00', scrollbar_track: '#1A0440' },
  cut: 1.5,
};
/* Each skin is applied by a click, from the one on before it: the first page starts in Pixel. */
const CHOICES = [...BUILTIN_SKINS.map(skin => skin.id), 'custom-1'];
const RTL = /^(?:ar|he|fa|ur|ps|sd|ug|yi)(?:-|$)/;
/* A colour of a skin as the browser gives it back. */
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
const WIDTHS = [1440, 375];
/* Skins whose headings and text start with the same font lay out the same; Onest and Tektur are carried, so the rest of a
   stack never shows. */
const fontsOf = (choice: string) => {
  const { fonts } = builtinSkin(choice) ?? OWN;
  return `${fonts.display[0]} ${fonts.body[0]}`;
};
const nameOf = (words: Messages, language: Language, choice: string) => (builtinSkin(choice) ? words.skins.names[choice as BuiltinSkinId] : OWN.name[language]);

async function messagesFor(locale: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>;
  const messages = dictionary[locale];
  if (!messages) throw new Error(`No dictionary export for shipped locale ${locale}`);
  return messages;
}

/* Only the first page of a test starts from these; what the test changes later stays for the next page. */
async function prepare(page: Page, language: Language, skin: string | null, own = true) {
  await serveApi(page);
  /* Keep CompanyLink above Themes static so its random-name check timer never shifts geometry mid-switch. */
  await page.route('**/api/link', route => route.fulfill({ json: { link: { name: 'acme', url: 'https://acme.hornhoof.org' }, domain: 'hornhoof.org' } }));
  await page.addInitScript(({ language, skin, collection }) => {
    if (sessionStorage.getItem('hh-test-seeded')) return;
    sessionStorage.setItem('hh-test-seeded', '1');
    localStorage.setItem('hh-lang', language);
    if (collection) localStorage.setItem('hh-skins', collection);
    if (skin) localStorage.setItem('hh-theme', skin);
  }, { language, skin, collection: own ? collectionText([{ id: 'custom-1', skin: OWN }]) : null });
}

/* Errors of the page, any file of the app it could not load, and any file it asked another site for. The answers of /api
   are this test's own, and those it leaves out answer 404 on purpose. Nor is a font Firefox stops loading because the test
   goes to the next page (NS_BINDING_ABORTED) counted. */
const ABORTED = 'status=2152398850';
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' && !text.startsWith('Failed to load resource') && !(text.includes('downloadable font') && text.includes(ABORTED))) problems.push(text);
  });
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['data:', 'blob:'].includes(url.protocol) && url.hostname !== 'localhost') problems.push(`outside: ${request.url()}`);
  });
  page.on('response', response => { if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  return problems;
}

async function openThemes(page: Page, words: Messages): Promise<Locator> {
  await page.getByRole('button', { name: words.shell.account, exact: true }).click();
  await page.getByRole('button', { name: words.settings.menu, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: words.settings.title });
  /* Company theme store lives under Company & access for the CEO. */
  await dialog.getByRole('button', { name: words.settings.groups.company, exact: true }).click();
  await expect(dialog.getByRole('button', { name: words.settings.groups.company, exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(dialog.getByRole('link', { name: 'https://acme.hornhoof.org', exact: true })).toBeVisible();
  await expect(dialog.getByRole('region', { name: words.skins.catalog })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return dialog;
}

/* Every text a person reads in what is open, to rank the shipped languages by how much they take. */
async function renderedLength(page: Page): Promise<number> {
  return page.evaluate(() => {
    let total = 0;
    for (const root of document.querySelectorAll('.account-menu, .dialog')) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (parent && parent.getClientRects().length) total += walker.currentNode.textContent?.trim().length ?? 0;
      }
    }
    return total;
  });
}

/* The longest and the shortest shipped language on these screens, and a shipped right-to-left one once there is one. */
async function chooseLanguages(page: Page): Promise<Language[]> {
  const ranked: { id: Language; characters: number }[] = [];
  for (const { id } of LANGUAGES) {
    const words = await messagesFor(id);
    await page.evaluate(language => localStorage.setItem('hh-lang', language), id);
    await page.goto('/');
    const dialog = await openThemes(page, words);
    let characters = await renderedLength(page);
    await dialog.getByRole('button', { name: words.common.done, exact: true }).click();
    await page.getByRole('button', { name: words.shell.account, exact: true }).click();
    characters += await renderedLength(page);
    ranked.push({ id, characters });
  }
  ranked.sort((a, b) => a.characters - b.characters || a.id.localeCompare(b.id));
  const rtl = LANGUAGES.map(language => language.id).filter(id => RTL.test(id));
  return [...new Set([ranked[0]!.id, ranked.at(-1)!.id, ...rtl.slice(0, 1)])];
}

/* Where every block of the window stands, with its padding, margin and font, the window scrolled to its top: a click
   scrolls to the card it presses. The actions inside a card are left out: the card on says Applied by a state, not Apply. */
async function geometry(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    for (const scrolled of document.querySelectorAll('.dialog, .settings-scroll')) scrolled.scrollTop = 0;
    const selectors = ['.dialog', '.dialog > *', '.settings-body > *', '.settings-nav > *', '.skins > *', '.skins-head > *', '.skins-adds .btn', '.skins-catalog > *', '.skin-cards > *', '.skin-card > *', '.skin-preview > *', '.skins-guide > *'];
    /* Named by place, not by text: the line that says which skin is on changes its words with the skin. */
    return [...new Set(selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)]))].map((element, at) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { what: `${at} ${element.tagName.toLowerCase()}.${element.className}`, x: box.x, y: box.y, width: box.width, height: box.height, padding: style.padding, margin: style.margin, border: style.borderWidth, font: `${style.fontSize} ${style.lineHeight} ${style.fontWeight}` };
    });
  });
}

/* The lowest WCAG contrast of the text that can be read in the menu and the window, at least 4.5 in every theme: each
   element's colour on the backgrounds behind it, laid over each other. */
async function lowestContrast(page: Page): Promise<{ ratio: number; what: string }> {
  return page.evaluate(() => {
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
    for (const root of document.querySelectorAll('.account-menu, .dialog')) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent || !walker.currentNode.textContent?.trim() || !parent.getClientRects().length || parent.closest(':disabled, .sr')) continue;
        const ground = behind(parent);
        const [a, b] = [luminance(over(parse(getComputedStyle(parent).color), ground)), luminance(ground)].sort((x, y) => y - x);
        const ratio = Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
        if (ratio < lowest.ratio) lowest = { ratio, what: `${parent.tagName.toLowerCase()}.${parent.className} ${parent.textContent?.trim().slice(0, 30)}` };
      }
    }
    return lowest;
  });
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.dialog')].every(box => box.scrollWidth <= box.clientWidth));
/* The whole window for Design, as tall as its content: the page grows for the picture and goes back to its size. */
async function shot(page: Page, info: TestInfo, name: string) {
  const size = page.viewportSize()!;
  const content = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.dialog')].map(box => { const body = box.querySelector<HTMLElement>('.settings-scroll'); return body ? box.getBoundingClientRect().height - body.clientHeight + body.scrollHeight : box.scrollHeight; })));
  const room = content + 64;
  if (room > size.height) await page.setViewportSize({ width: size.width, height: room });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  if (room > size.height) await page.setViewportSize(size);
}

/* The pixels of a picture that hold ink, unlike its top left corner, the ground, leaving out a margin at its edges:
   read by the page itself, so each engine reads its own drawing. */
async function inkOf(page: Page, picture: Buffer, margin = 0): Promise<[number, number][]> {
  return page.evaluate(async ({ png, margin }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const marks: [number, number][] = [];
    for (let at = 0; at < data.length; at += 4) {
      const [x, y] = [(at / 4) % bitmap.width, Math.floor(at / 4 / bitmap.width)];
      const inside = x >= margin && y >= margin && x < bitmap.width - margin && y < bitmap.height - margin;
      if (inside && Math.abs(data[at]! - data[0]!) + Math.abs(data[at + 1]! - data[1]!) + Math.abs(data[at + 2]! - data[2]!) > 96) marks.push([x, y]);
    }
    return marks;
  }, { png: picture.toString('base64'), margin });
}

/* How tall lowercase letters stand in a font, as drawn: rows of pixels in CSS pixels, the height a person sees. The line
   is padded, and only what stands inside its padding counts: a picture of a box can take in a row of the page beside it. */
async function lowercaseHeight(page: Page, font: string): Promise<number> {
  const probe = await page.evaluate(async font => {
    const line = document.createElement('span');
    line.className = 'height-probe';
    line.style.cssText = `position: fixed; inset-block-start: 0; inset-inline-start: 0; z-index: 2147483647; padding: 8px; background: var(--surface); color: var(--ink); font: ${font}; line-height: 1.4`;
    line.textContent = 'хохохо';
    document.body.append(line);
    const style = getComputedStyle(line);
    await document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, line.textContent);
    return true;
  }, font);
  expect(probe).toBe(true);
  const marks = await inkOf(page, await page.locator('.height-probe').screenshot(), 4);
  await page.evaluate(() => document.querySelector('.height-probe')?.remove());
  const rows = marks.map(([, y]) => y);
  return (Math.max(...rows) - Math.min(...rows) + 1) / (await page.evaluate(() => devicePixelRatio));
}

/* The card of a skin, by its name. */
const skinCard = (dialog: Locator, name: string) => dialog.locator('.skin-card').filter({ has: dialog.page().getByRole('heading', { name, exact: true }) });

/* Applies a skin with a click on its card and waits until the page, the card's state and the line under the heading say so. */
async function pick(page: Page, dialog: Locator, words: Messages, language: Language, choice: string) {
  const name = nameOf(words, language, choice);
  await dialog.getByRole('button', { name: `${words.skins.apply}: ${name}`, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice);
  await expect(skinCard(dialog, name).getByText(words.skins.applied, { exact: true })).toBeFocused();
  await expect(dialog.getByRole('status')).toHaveText(words.skins.nowOn(name));
  await page.evaluate(async () => { await document.fonts.ready; });
}

test('the Themes part and the account menu keep every block in place in each skin, on the longest and the shortest language and right to left', async ({ page, browserName }, info) => {
  test.setTimeout(0);
  const problems = watchProblems(page);
  await prepare(page, 'en', null);
  await page.goto('/');
  const languages = await chooseLanguages(page);
  const report: Record<string, unknown> = { browserName, languages, contrast: {} };
  /* No shipped language is written right to left yet, so the shortest one is also laid out mirrored. */
  const looks = [...languages.map(language => ({ language, dir: 'ltr' })), { language: languages[0]!, dir: 'rtl' }];
  for (const { language, dir } of looks) for (const width of WIDTHS) {
    const words = await messagesFor(language);
    const label = `${language}-${dir}-${width}`;
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.evaluate(lang => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', 'pixel'); }, language);
    await page.goto('/');
    await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
    const dialog = await openThemes(page, words);
    const section = new Map<string, unknown[]>();
    for (const choice of CHOICES) {
      await pick(page, dialog, words, language, choice);
      const now = await geometry(page);
      const same = section.get(fontsOf(choice));
      if (same) expect(now, `${label} section in ${choice}`).toEqual(same);
      else section.set(fontsOf(choice), now);
      const lowest = await lowestContrast(page);
      (report.contrast as Record<string, unknown>)[`${label}-section-${choice}`] = lowest;
      expect(lowest.ratio, `${label} ${choice} ${lowest.what}`).toBeGreaterThanOrEqual(4.5);
      expect(await noSideScroll(page), `${label} ${choice}: no sideways scroll`).toBe(true);
      await shot(page, info, `${browserName}-${label}-section-${choice}`);
    }
    await dialog.getByRole('button', { name: words.common.done, exact: true }).click();
    await page.getByRole('button', { name: words.shell.account, exact: true }).click();
    await expect(page.getByRole('button', { name: words.shell.logOut, exact: true })).toBeVisible();
    await expect(page.locator('.account-menu').getByText(words.skins.title, { exact: true }), 'the menu has no themes row').toHaveCount(0);
    const lowest = await lowestContrast(page);
    (report.contrast as Record<string, unknown>)[`${label}-menu`] = lowest;
    expect(lowest.ratio, `${label} menu ${lowest.what}`).toBeGreaterThanOrEqual(4.5);
    expect(await noSideScroll(page), `${label} menu: no sideways scroll`).toBe(true);
    await shot(page, info, `${browserName}-${label}-menu`);
    report[`${label}-groups`] = [...section.keys()];
  }
  writeFileSync(info.outputPath('themes-report.json'), JSON.stringify(report, null, 2));
  expect(problems).toEqual([]);
});

test('the chosen skin of the collection is on the page before the app starts, and a switch is whole in the next frame', async ({ page }) => {
  const problems = watchProblems(page);
  await prepare(page, 'en', 'custom-1');
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/src/main.tsx', async route => { await held; await route.continue(); });
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState !== 'loading');
  /* The page has been read, the app has not run: the plain script at the top of the head has already set the skin. */
  const early = await page.evaluate(() => {
    const head = [...document.head.children];
    const boot = head.findIndex(element => element.matches('script[src="/skins-boot.js"]:not([type])'));
    const later = head.findIndex(element => element.matches('link[rel="stylesheet"], style, script[src*="main.tsx"]'));
    const root = document.documentElement;
    return { before: boot >= 0 && (later < 0 || boot < later), theme: root.dataset.theme, cut: root.dataset.cut, bg: root.style.getPropertyValue('--bg'), app: document.getElementById('root')?.childElementCount };
  });
  expect(early).toEqual({ before: true, theme: 'custom-1', cut: 'bevel', bg: OWN.colors.bg, app: 0 });
  release();
  const words = await messagesFor('en');
  const dialog = await openThemes(page, words);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(rgb(OWN.colors.bg));
  /* The colour of the page in each of the next frames once the company theme switches: the new skin from the first one, never a mix. */
  for (const choice of ['matrix', 'egypt', 'light', 'pixel'] as const) {
    await page.evaluate(target => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      const look = (left: number) => requestAnimationFrame(() => {
        seen.push(getComputedStyle(document.body).backgroundColor);
        if (left > 1) look(left - 1);
      });
      const observer = new MutationObserver(() => {
        if (document.documentElement.dataset.theme === target) {
          observer.disconnect();
          look(3);
        }
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }, choice);
    await dialog.getByRole('button', { name: `${words.skins.apply}: ${words.skins.names[choice]}`, exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { seen: string[] }).seen.length === 3);
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual(Array(3).fill(rgb(builtinSkin(choice)!.colors.bg)));
    if (choice === 'egypt') {
      await expect(page.locator('html')).toHaveAttribute('data-world', 'egypt');
      await expect(page.locator('html')).toHaveAttribute('data-surface', 'papyrus');
    } else {
      await expect(page.locator('html')).not.toHaveAttribute('data-world');
      await expect(page.locator('html')).not.toHaveAttribute('data-surface');
    }
  }
  expect(problems).toEqual([]);
});

test('Pixel writes headings and buttons in Handjet, served by Hornhoof itself in Latin and Cyrillic, text in Onest, and cuts corners in steps', async ({ page }) => {
  const problems = watchProblems(page);
  const fonts: string[] = [];
  page.on('request', request => { if (/\.woff2(\?|$)/.test(request.url())) fonts.push(new URL(request.url()).pathname); });
  await prepare(page, 'ru', 'pixel', false);
  await page.goto('/');
  const words = await messagesFor('ru');
  const dialog = await openThemes(page, words);
  const family = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).fontFamily);
  expect(await family(dialog.getByRole('heading', { name: words.skins.names.pixel, exact: true }))).toMatch(/^"?Handjet"?,/);
  expect(await family(dialog.getByText(words.skins.desc, { exact: true }))).toMatch(/^"?Onest"?,/);
  expect(await page.evaluate(() => ['Pixel', 'Пиксель'].map(text => document.fonts.check('600 16px "Handjet"', text)))).toEqual([true, true]);
  expect(fonts.filter(path => path.includes('handjet-cyrillic-500'))).not.toEqual([]);
  expect(fonts.filter(path => path.includes('handjet-latin-500'))).not.toEqual([]);
  /* Twelve corners of two steps against the six of a slant; a ghost button is square. */
  const points = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).clipPath.split(',').length);
  expect(await points(dialog.getByRole('button', { name: words.skins.archive.upload, exact: true }))).toBe(12);
  expect(await dialog.getByRole('button', { name: `${words.skins.download}: ${words.skins.names.pixel}`, exact: true }).evaluate(element => getComputedStyle(element).clipPath)).toBe('none');
  await dialog.getByRole('button', { name: `${words.skins.apply}: ${words.skins.names.light}`, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await points(dialog.getByRole('button', { name: words.skins.archive.upload, exact: true }))).toBe(6);
  expect(problems).toEqual([]);
});

/* Measured as Design does, on what is drawn: lowercase of a button (14 px), a heading (18 px) and a large title. */
test('Pixel lowercase stands as tall as Tektur, within a pixel, at the size of a button, a heading and a title, and no weight or slant of its dots is faked', async ({ page, browserName }, info) => {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, 'ru', 'pixel', false);
  await page.goto('/');
  /* On the page itself: the settings window is drawn above anything the page puts on top. */
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pixel');
  const heights: Record<string, { handjet: number; tektur: number }> = {};
  for (const size of [14, 18, 56]) heights[`${size}px`] = { handjet: await lowercaseHeight(page, `600 ${size}px var(--f-display)`), tektur: await lowercaseHeight(page, `600 ${size}px Tektur`) };
  writeFileSync(info.outputPath('lowercase-heights.json'), JSON.stringify({ browserName, heights }, null, 2));
  for (const [size, { handjet, tektur }] of Object.entries(heights)) expect(Math.abs(handjet - tektur), `${browserName} ${size}: Handjet ${handjet}, Tektur ${tektur}`).toBeLessThanOrEqual(1);
  const words = await messagesFor('ru');
  const dialog = await openThemes(page, words);
  const heading = dialog.getByRole('heading', { name: words.skins.names.pixel, exact: true });
  expect(await heading.evaluate(element => getComputedStyle(element).fontSynthesis)).toBe('none');
  /* The Pixel card beside Cyberpunk's, written in Tektur, on one picture for Design. */
  const card = (name: string) => dialog.locator('.skin-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const content = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll<HTMLElement>('.dialog')].map(box => { const body = box.querySelector<HTMLElement>('.settings-scroll'); return body ? box.getBoundingClientRect().height - body.clientHeight + body.scrollHeight : box.scrollHeight; })));
  await page.setViewportSize({ width: 1440, height: Math.max(900, content + 64) });
  const [first, second] = [(await card(words.skins.names.cyberpunk).boundingBox())!, (await card(words.skins.names.pixel).boundingBox())!];
  const x = Math.min(first.x, second.x), y = Math.min(first.y, second.y);
  await page.screenshot({ path: info.outputPath(`${browserName}-ru-1440-cards-cyberpunk-pixel.png`), animations: 'disabled', clip: { x, y, width: Math.max(first.x + first.width, second.x + second.width) - x, height: Math.max(first.y + first.height, second.y + second.height) - y } });
  expect(problems).toEqual([]);
});

test('a skin file is added beside the others, a bad one is refused in plain words, any skin downloads as a sample, and a removed one can be put back', async ({ page }) => {
  const problems = watchProblems(page);
  await prepare(page, 'en', 'matrix', false);
  await page.goto('/');
  const words = await messagesFor('en');
  const dialog = await openThemes(page, words);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download: Matrix', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('hornhoof-skin-matrix.json');
  const chunks: Buffer[] = [];
  for await (const chunk of (await file.createReadStream())!) chunks.push(chunk as Buffer);
  expect(parseSkin(Buffer.concat(chunks).toString('utf8'))).toEqual({ ok: true, skin: builtinFile(builtinSkin('matrix')!, { ru: 'Матрица', en: 'Matrix' }) });
  const add = (name: string, text: string) => dialog.locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  const bad = { ...JSON.parse(skinText(OWN)), colors: { ...OWN.colors, bg: 'url(https://example.com/x.png)' } };
  await add('bad.json', JSON.stringify(bad));
  await expect(dialog.getByRole('alert')).toHaveText(`${words.skins.addFailed}${words.skins.errors.unsafe('colors.bg', '')}`);
  await add('proto.json', skinText(OWN).replace('{', '{"__proto__": {"polluted": true},'));
  await expect(dialog.getByRole('alert')).toHaveText(`${words.skins.addFailed}${words.skins.errors.forbidden_key('__proto__', '')}`);
  await expect(dialog.getByRole('button', { name: words.skins.archive.upload, exact: true })).toBeFocused();
  await add('dusk.json', skinText(OWN));
  await expect(dialog.getByRole('status')).toHaveText(words.skins.added('Dusk'));
  await add('dawn.json', skinText({ ...OWN, name: { ru: 'Рассвет', en: 'Dawn' } }));
  await expect(dialog.getByRole('status')).toHaveText(words.skins.added('Dawn'));
  expect(await page.evaluate(() => ({} as Record<string, unknown>).polluted)).toBeUndefined();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'matrix');
  await dialog.getByRole('button', { name: 'Apply: Dawn', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom-2');
  const tokens = await page.evaluate(names => names.map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()), Object.values(COLOR_TOKENS));
  expect(tokens).toEqual(Object.keys(COLOR_TOKENS).map(role => OWN.colors[role as keyof typeof COLOR_TOKENS]));
  /* The window has its own address, so it opens again with the page. */
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom-2');
  const again = page.getByRole('dialog', { name: words.settings.title });
  await again.getByRole('button', { name: 'Remove: Dawn', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'cyberpunk');
  await expect(skinCard(again, 'Cyberpunk').getByText(words.skins.applied, { exact: true })).toBeVisible();
  await expect(skinCard(again, 'Cyberpunk').getByRole('button', { name: 'Apply: Cyberpunk', exact: true })).toHaveCount(0);
  await expect(again.getByRole('status')).toHaveText(`${words.skins.removed('Dawn')} ${words.skins.nowOn('Cyberpunk')}${words.skins.undo}`);
  await expect(again.getByRole('button', { name: 'Apply: Dusk', exact: true })).toBeFocused();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(rgb(CYBERPUNK.colors.bg));
  await again.getByRole('button', { name: words.skins.undo, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom-2');
  await expect(again.getByRole('region', { name: words.skins.catalog }).getByRole('heading', { level: 6 })).toHaveText(['Cyberpunk', 'Light', 'Matrix', 'Pixel', 'Ancient Egypt', 'Dusk', 'Dawn']);
  expect(problems).toEqual([]);
});
