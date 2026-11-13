import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { collectionText } from '../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import { COLOR_TOKENS, type Skin } from '../src/skins/roles';
import { parseSkin, skinText } from '../src/skins/validate';
import { serveApi } from './api';

/* The Themes section of a person's settings and its row in the account menu, in every built-in theme and one of a
   person's own: what each looks like, that switching moves nothing among themes written in the same fonts, that text
   stays readable, that nothing runs off the screen, also mirrored right to left, and that the chosen theme is on the
   page before the app starts. Its files load, are refused in plain words, download as samples and are deleted. */
const { id: _cyberpunk, ...CYBERPUNK } = builtinSkin('cyberpunk')!;
const OWN: Skin = { ...CYBERPUNK, name: 'Dusk', colors: { ...CYBERPUNK.colors, bg: '#10002B', surface: '#1A0440', surface2: '#240A52', accent: '#FF9E00', accent_ink: '#FFC266', button: '#FF9E00', on_button: '#1A0E00' }, cut: 1.5 };
const CHOICES = [...BUILTIN_SKINS.map(skin => skin.id), 'custom-1'];
const RTL = /^(?:ar|he|fa|ur|ps|sd|ug|yi)(?:-|$)/;
/* A colour of a skin as the browser gives it back. */
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
const WIDTHS = [1440, 375];
const fontsOf = (choice: string) => JSON.stringify((builtinSkin(choice) ?? OWN).fonts);

async function messagesFor(locale: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>;
  const messages = dictionary[locale];
  if (!messages) throw new Error(`No dictionary export for shipped locale ${locale}`);
  return messages;
}

/* Only the first page of a test starts from these; what the test changes later stays for the next page. */
async function prepare(page: Page, language: Language, skin: string | null, own = true) {
  await serveApi(page);
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
  await page.getByRole('button', { name: new RegExp(`^${words.skins.title}: `) }).click();
  const dialog = page.getByRole('dialog', { name: words.profile.title });
  await expect(dialog.getByRole('list', { name: words.skins.builtins })).toBeVisible();
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

/* Where every block and control of the menu and the window stands, with its padding, margin and font, the window scrolled
   to its top: a click scrolls to the card it presses. */
async function geometry(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    for (const scrolled of document.querySelectorAll('.dialog')) scrolled.scrollTop = 0;
    const selectors = ['.account-menu', '.account-menu > *', '.dialog', '.dialog > *', '.skins > *', '.skins-part > *', '.skin-card', '.skin-card > *', '.skin-swatch > *', '.dialog button', '.dialog a', '.dialog label', '.skins-guide > *'];
    /* Named by place, not by text: the line that says which theme is on changes its words with the theme. */
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
  const content = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('.dialog')].map(box => box.scrollHeight)));
  const room = content + 64;
  if (room > size.height) await page.setViewportSize({ width: size.width, height: room });
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
  if (room > size.height) await page.setViewportSize(size);
}

async function pick(page: Page, dialog: Locator, words: Messages, choice: string) {
  const name = builtinSkin(choice) ? words.skins.names[choice as keyof Messages['skins']['names']] : OWN.name;
  await dialog.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice);
  await expect(dialog.getByText(words.skins.now(name), { exact: true })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return name;
}

test('the Themes section and its menu row keep every block in place in each theme, on the longest and the shortest language and right to left', async ({ page, browserName }, info) => {
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
    await page.evaluate(lang => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', 'cyberpunk'); }, language);
    await page.goto('/');
    await page.evaluate(direction => { document.documentElement.dir = direction; }, dir);
    const dialog = await openThemes(page, words);
    const section = new Map<string, unknown[]>();
    for (const choice of CHOICES) {
      await pick(page, dialog, words, choice);
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
    await expect(page.getByRole('button', { name: words.skins.menu(OWN.name), exact: true })).toBeVisible();
    const lowest = await lowestContrast(page);
    (report.contrast as Record<string, unknown>)[`${label}-menu`] = lowest;
    expect(lowest.ratio, `${label} menu ${lowest.what}`).toBeGreaterThanOrEqual(4.5);
    expect(await noSideScroll(page), `${label} menu: no sideways scroll`).toBe(true);
    await shot(page, info, `${browserName}-${label}-menu`);
    report[`${label}-groups`] = [...section.keys()].length;
  }
  writeFileSync(info.outputPath('themes-report.json'), JSON.stringify(report, null, 2));
  expect(problems).toEqual([]);
});

test('the chosen theme of the collection is on the page before the app starts, and a switch is whole in the next frame', async ({ page }) => {
  const problems = watchProblems(page);
  await prepare(page, 'en', 'custom-1');
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/src/main.tsx', async route => { await held; await route.continue(); });
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState !== 'loading');
  /* The page has been read, the app has not run: the plain script at the top of the head has already set the theme. */
  const early = await page.evaluate(() => {
    const head = [...document.head.children];
    const boot = head.findIndex(element => element.matches('script[src="/skins-boot.js"]:not([type])'));
    const later = head.findIndex(element => element.matches('link[rel="stylesheet"], style, script[src*="main.tsx"]'));
    return { before: boot >= 0 && (later < 0 || boot < later), theme: document.documentElement.dataset.theme, bg: document.documentElement.style.getPropertyValue('--bg'), app: document.getElementById('root')?.childElementCount };
  });
  expect(early).toEqual({ before: true, theme: 'custom-1', bg: OWN.colors.bg, app: 0 });
  release();
  const words = await messagesFor('en');
  const dialog = await openThemes(page, words);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(rgb(OWN.colors.bg));
  /* The colour of the page in each of the next frames after a click: the new theme from the first one, never a mix. */
  for (const choice of ['matrix', 'light', 'pixel'] as const) {
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      const look = (left: number) => requestAnimationFrame(() => {
        seen.push(getComputedStyle(document.body).backgroundColor);
        if (left > 1) look(left - 1);
      });
      document.addEventListener('click', () => look(3), { once: true, capture: true });
    });
    await dialog.getByRole('button', { name: words.skins.names[choice], exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { seen: string[] }).seen.length === 3);
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual(Array(3).fill(rgb(builtinSkin(choice)!.colors.bg)));
  }
  expect(problems).toEqual([]);
});

test('Pixel writes in its own pixel font, served by Hornhoof itself, in Latin and Cyrillic', async ({ page }) => {
  const problems = watchProblems(page);
  const fonts: string[] = [];
  page.on('request', request => { if (/\.woff2(\?|$)/.test(request.url())) fonts.push(new URL(request.url()).pathname); });
  await prepare(page, 'ru', 'pixel', false);
  await page.goto('/');
  const words = await messagesFor('ru');
  const dialog = await openThemes(page, words);
  expect(await dialog.getByRole('heading', { name: words.skins.names.pixel, exact: true }).evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^"?Pixelify Sans"?,/);
  expect(await page.evaluate(() => ['Pixelify Sans', 'Пиксель'].map(text => document.fonts.check(`16px "Pixelify Sans"`, text)))).toEqual([true, true]);
  expect(fonts.filter(path => path.includes('pixelify-sans-cyrillic'))).not.toEqual([]);
  expect(fonts.filter(path => path.includes('pixelify-sans-latin'))).not.toEqual([]);
  expect(problems).toEqual([]);
});

test('theme files load beside each other, a bad one is refused in plain words, any theme downloads as a sample, and a deleted one gives way to Cyberpunk', async ({ page }) => {
  const problems = watchProblems(page);
  await prepare(page, 'en', 'matrix', false);
  await page.goto('/');
  const words = await messagesFor('en');
  const dialog = await openThemes(page, words);
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download Matrix', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('hornhoof-skin-matrix.json');
  const chunks: Buffer[] = [];
  for await (const chunk of (await file.createReadStream())!) chunks.push(chunk as Buffer);
  const { id: _matrix, ...matrix } = builtinSkin('matrix')!;
  expect(parseSkin(Buffer.concat(chunks).toString('utf8'))).toEqual({ ok: true, skin: { ...matrix, name: 'Matrix' } });
  const load = dialog.getByLabel('Load themes', { exact: true });
  const bad = { ...JSON.parse(skinText(OWN)), colors: { ...OWN.colors, bg: 'url(https://example.com/x.png)' } };
  await load.setInputFiles([
    { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bad)) },
    { name: 'proto.json', mimeType: 'application/json', buffer: Buffer.from(skinText(OWN).replace('{', '{"__proto__": {"polluted": true},')) },
    { name: 'dusk.json', mimeType: 'application/json', buffer: Buffer.from(skinText(OWN)) },
    { name: 'dawn.json', mimeType: 'application/json', buffer: Buffer.from(skinText({ ...OWN, name: 'Dawn' })) },
  ]);
  await expect(dialog.getByRole('alert').getByRole('listitem')).toHaveText([
    'bad.json: colors.bg: this looks like code. Links such as url(), expressions, tags and control or direction characters are not allowed.',
    'proto.json: __proto__: this name is not allowed in a theme file, because code could use it to change how Hornhoof works.',
  ]);
  await expect(dialog.getByRole('status')).toHaveText('Added: Dusk, Dawn.');
  expect(await page.evaluate(() => ({} as Record<string, unknown>).polluted)).toBeUndefined();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'matrix');
  await dialog.getByRole('button', { name: 'Dawn', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom-2');
  const tokens = await page.evaluate(names => names.map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()), Object.values(COLOR_TOKENS));
  expect(tokens).toEqual(Object.keys(COLOR_TOKENS).map(role => OWN.colors[role as keyof typeof COLOR_TOKENS]));
  /* The window has its own address, so it opens again with the page. */
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom-2');
  const again = page.getByRole('dialog', { name: words.profile.title });
  await again.getByRole('button', { name: 'Delete Dawn', exact: true }).click();
  await again.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'cyberpunk');
  await expect(again.getByRole('button', { name: 'Cyberpunk', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByRole('list', { name: 'Your themes' }).getByRole('listitem')).toHaveCount(1);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(rgb(CYBERPUNK.colors.bg));
  expect(problems).toEqual([]);
});
