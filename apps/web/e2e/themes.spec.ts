import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { BUILTIN, COLOR_TOKENS, parseTemplate, sampleOf, templateText, THEMES, type ColorRole } from '../src/theme-template';
import { serveApi } from './api';

/* The four built-in themes and a custom template, in the account menu and the settings of a person who sees the whole
   company: what each looks like, that switching moves nothing, that text stays readable, and that the chosen one is on the
   page before the app starts. The custom template changes only colours, so its layout must match too. */
const CHOICES = [...THEMES, 'custom'] as const;
type Choice = (typeof CHOICES)[number];
const CUSTOM = { ...sampleOf('dark'), name: 'Neon', colors: { ...sampleOf('dark').colors, bg: '#10002B', surface: '#1A0440', surface2: '#240A52', accent: '#FF9E00', accent_ink: '#FFC266', button: '#FF9E00', on_button: '#1A0E00' }, cut: 1.5 };
const RTL = /^(?:ar|he|fa|ur|ps|sd|ug|yi)(?:-|$)/;
/* A colour of the sheet as the browser gives it back. */
const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
const WIDTHS = [1440, 375];

async function messagesFor(locale: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>;
  const messages = dictionary[locale];
  if (!messages) throw new Error(`No dictionary export for shipped locale ${locale}`);
  return messages;
}

async function prepare(page: Page, language: Language, theme: Choice | null, withTemplate = true) {
  await serveApi(page);
  await page.route('**/api/link', route => route.fulfill({ json: { link: null, domain: 'hornhoof.org' } }));
  await page.route('**/api/repo-host', route => route.fulfill({ json: { host: null } }));
  await page.route('**/api/link/names/*', route => route.fulfill({ json: { name: 'acme', free: true } }));
  /* Only the first page of a test starts from these; what the test changes later stays for the next page. */
  await page.addInitScript(({ language, theme, custom }) => {
    if (sessionStorage.getItem('hh-test-seeded')) return;
    sessionStorage.setItem('hh-test-seeded', '1');
    localStorage.setItem('hh-lang', language);
    if (custom) localStorage.setItem('hh-theme-custom', custom);
    if (theme) localStorage.setItem('hh-theme', theme);
  }, { language, theme, custom: withTemplate ? templateText(CUSTOM) : null });
}

/* Errors of the page, and any file of the app it could not load. The answers of /api are this test's own, and those it
   leaves out answer 404 on purpose, so the console's line for them is not counted. Nor is a font Firefox stops loading
   because the test goes to the next page (NS_BINDING_ABORTED). */
const ABORTED = 'status=2152398850';
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' && !text.startsWith('Failed to load resource') && !(text.includes('downloadable font') && text.includes(ABORTED))) problems.push(text);
  });
  page.on('response', response => { if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  return problems;
}

async function openSettings(page: Page, words: Messages): Promise<Locator> {
  await page.getByRole('button', { name: words.shell.account, exact: true }).click();
  await page.getByRole('button', { name: words.settings.menu, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: words.settings.title });
  await expect(dialog.getByRole('group', { name: words.shell.theme })).toBeVisible();
  /* The settings ask whether the suggested link is free; its answer is the last thing to come. */
  await expect(dialog.getByText(words.link.free(`acme.hornhoof.org`), { exact: true })).toBeVisible();
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

async function chooseLanguages(page: Page): Promise<Language[]> {
  const ranked: { id: Language; characters: number }[] = [];
  for (const { id } of LANGUAGES) {
    const words = await messagesFor(id);
    await page.evaluate(language => localStorage.setItem('hh-lang', language), id);
    await page.goto('/');
    const dialog = await openSettings(page, words);
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

/* Where every block and control of the bar, the menu and the window stands, with its padding and margin, with the window
   scrolled to its top: a click scrolls to the button it presses. */
async function geometry(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    for (const scrolled of document.querySelectorAll('.dialog')) scrolled.scrollTop = 0;
    const selectors = ['.topbar', '.tabs', '.tabs button', '.avatar', '.account-menu', '.account-menu > *', '.account-menu button', '.dialog', '.dialog > *', '.dialog .settings-part > *', '.dialog button', '.dialog a', '.dialog label', '.dialog .alert', '.theme-template > *'];
    return [...new Set(selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)]))].map(element => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { what: `${element.tagName.toLowerCase()}.${element.className} ${element.textContent?.slice(0, 24)}`, x: box.x, y: box.y, width: box.width, height: box.height, padding: style.padding, margin: style.margin, border: style.borderWidth, font: `${style.fontSize} ${style.lineHeight} ${style.fontWeight}` };
    });
  });
}

/* The lowest WCAG contrast of the text that can be read in the menu and the window, at least 4.5 in every theme: each
   element's colour on the backgrounds behind it, laid over each other. A disabled control is left out, as WCAG leaves it. */
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

const themeName = (words: Messages, choice: Choice) => words.shell[choice];

async function pick(page: Page, scope: Locator, words: Messages, choice: Choice) {
  await scope.getByRole('group', { name: words.shell.theme }).getByRole('button', { name: themeName(words, choice), exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', choice === 'custom' ? CUSTOM.base : choice);
}

const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });

test('the account menu and the settings keep every block in place in each theme, on the longest and the shortest language', async ({ page, browserName }, info) => {
  test.setTimeout(0);
  const problems = watchProblems(page);
  await prepare(page, 'en', 'light');
  await page.goto('/');
  const languages = await chooseLanguages(page);
  const report: Record<string, unknown> = { browserName, languages, contrast: {} };
  for (const language of languages) for (const width of WIDTHS) {
    const words = await messagesFor(language);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.evaluate(lang => { localStorage.setItem('hh-lang', lang); localStorage.setItem('hh-theme', 'light'); }, language);
    await page.goto('/');
    const dialog = await openSettings(page, words);
    let settings: unknown[] | null = null;
    for (const choice of CHOICES) {
      await pick(page, dialog, words, choice);
      const now = await geometry(page);
      if (settings) expect(now, `${language} ${width} settings in ${choice}`).toEqual(settings);
      settings ??= now;
      const lowest = await lowestContrast(page);
      (report.contrast as Record<string, unknown>)[`${language}-${width}-settings-${choice}`] = lowest;
      expect(lowest.ratio, `${choice} ${lowest.what}`).toBeGreaterThanOrEqual(4.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await shot(page, info, `${browserName}-${language}-${width}-settings-${choice}`);
    }
    await dialog.getByRole('button', { name: words.common.done, exact: true }).click();
    await page.getByRole('button', { name: words.shell.account, exact: true }).click();
    const menu = page.locator('.account-menu');
    let menuGeometry: unknown[] | null = null;
    for (const choice of CHOICES) {
      await pick(page, menu, words, choice);
      const now = await geometry(page);
      if (menuGeometry) expect(now, `${language} ${width} menu in ${choice}`).toEqual(menuGeometry);
      menuGeometry ??= now;
      const lowest = await lowestContrast(page);
      (report.contrast as Record<string, unknown>)[`${language}-${width}-menu-${choice}`] = lowest;
      expect(lowest.ratio, `${choice} ${lowest.what}`).toBeGreaterThanOrEqual(4.5);
      await shot(page, info, `${browserName}-${language}-${width}-menu-${choice}`);
    }
    report[`${language}-${width}-geometry`] = { settings: settings?.length, menu: menuGeometry?.length };
  }
  writeFileSync(info.outputPath('themes-report.json'), JSON.stringify(report, null, 2));
  expect(problems).toEqual([]);
});

test('the chosen theme and template are on the page before the app starts', async ({ page }) => {
  const problems = watchProblems(page);
  await prepare(page, 'en', 'custom');
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/src/main.tsx', async route => { await held; await route.continue(); });
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForFunction(() => document.readyState !== 'loading');
  /* The page has been read, the app has not run: the plain script at the top of the head has already set the theme. */
  const early = await page.evaluate(() => {
    const head = [...document.head.children];
    const boot = head.findIndex(element => element.matches('script[src="/theme-boot.js"]:not([type])'));
    const later = head.findIndex(element => element.matches('link[rel="stylesheet"], style, script[src*="main.tsx"]'));
    return { before: boot >= 0 && (later < 0 || boot < later), theme: document.documentElement.dataset.theme, bg: document.documentElement.style.getPropertyValue('--bg'), app: document.getElementById('root')?.childElementCount };
  });
  expect(early).toEqual({ before: true, theme: CUSTOM.base, bg: CUSTOM.colors.bg, app: 0 });
  release();
  await expect(page.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(rgb(CUSTOM.colors.bg));
  expect(problems).toEqual([]);
});

test('a template loads from a file, a bad one is refused in plain words, and the theme on the page downloads as a sample', async ({ page }) => {
  const problems = watchProblems(page);
  await prepare(page, 'en', 'matrix', false);
  await page.goto('/');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Custom template…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Custom template' });
  const download = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download template', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('hornhoof-theme-matrix.json');
  const chunks: Buffer[] = [];
  for await (const chunk of (await file.createReadStream())!) chunks.push(chunk as Buffer);
  expect(parseTemplate(Buffer.concat(chunks).toString('utf8'))).toEqual({ ok: true, template: sampleOf('matrix') });
  const load = dialog.getByLabel('Load template', { exact: true });
  await load.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...JSON.parse(templateText(CUSTOM)), colors: { bg: 'url(https://example.com/x.png)' } })) });
  await expect(dialog.getByRole('alert')).toHaveText('colors.bg: this looks like code. Links such as url(), expressions, tags and control characters are not allowed.');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'matrix');
  await load.setInputFiles({ name: 'neon.json', mimeType: 'application/json', buffer: Buffer.from(templateText(CUSTOM)) });
  await expect(dialog.getByText('Your template "Neon" is loaded.', { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', CUSTOM.base);
  const tokens = await page.evaluate(names => names.map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()), Object.values(COLOR_TOKENS));
  expect(tokens).toEqual(Object.keys(COLOR_TOKENS).map(role => CUSTOM.colors[role as ColorRole]));
  await dialog.getByRole('button', { name: 'Reset template', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', CUSTOM.base);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(rgb(BUILTIN[CUSTOM.base].colors.bg));
  expect(problems).toEqual([]);
});
