import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { collectionText } from '../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import type { Skin } from '../src/skins/roles';
import { builtinFile } from '../src/skins/validate';
import type { FeedbackShown, Improvement, InboxCard } from '../src/types';
import { serveApi } from './api';

/* Writing to Hornhoof's developers inside About, a finding about Hornhoof itself on its card and their inbox, as a person
   meets them: in each built-in skin and one of a person's own, every block stands in the same place with the same size
   among skins written in the same fonts, text
   stays readable and whole, controls keep their heights and nothing runs off the screen, in every shipped language, at a
   phone's width and a desktop's. What each engine measured is kept in a file, so the engines can be compared. */

/* A skin of a person's own that changes only colours, so its layout must match Cyberpunk's exactly. */
const SAMPLE = builtinFile(builtinSkin('cyberpunk')!, { ru: 'Сумерки', en: 'Dusk' });
const OWN: Skin = { ...SAMPLE, colors: { ...SAMPLE.colors, bg: '#10002B', surface: '#1A0440', surface2: '#240A52', accent: '#FF9E00', accent_ink: '#FFC266', button: '#FF9E00', on_button: '#1A0E00', scrollbar_track: '#1A0440' } };
const CHOICES: string[] = [...BUILTIN_SKINS.map(skin => skin.id), 'custom-1'];
type Choice = string;
/* Skins whose headings and text start with the same font lay out the same. */
const fontsOf = (choice: Choice) => {
  const { fonts } = builtinSkin(choice) ?? OWN;
  return `${fonts.display[0]} ${fonts.body[0]}`;
};
export const WIDTHS = [1440, 375];

const TITLE = 'The agent terminal froze after the update and the whole department waited for an hour';
const TEXT = 'It happened on two machines. The log said Terminalverbindungsunterbrechungswiederherstellungsfehler and nothing more.\nAfter a restart it came back.';
/* What the server would send for it: the words cleaned, with the technical data. */
const SHOWN: FeedbackShown = {
  report: {
    kind: 'bug',
    title: TITLE,
    text: 'It happened on [path] with the key [secret] and the mail [email]. The log said Terminalverbindungsunterbrechungswiederherstellungsfehler and nothing more.\nAfter a restart it came back.',
    facts: { version: '0.18.12', platform: ['darwin arm64', 'linux x64', 'windows x64'], errorCode: 'terminal_lost_after_update_on_a_long_running_node' },
  },
  hidden: { secret: 1, email: 1, address: 2, path: 1 },
  digest: 'd'.repeat(64),
};
const FINDING: Improvement = {
  id: 'i9', title: 'The terminal of an agent closes after every update of Hornhoof on a busy machine', text: 'Change: keep the terminal through an update.', seen: 3, status: 'open', scope: 'platform', code: 'terminal_lost',
  result: null, at: '2026-11-12T08:00:00.000Z', updatedAt: '2026-11-12T09:00:00.000Z', agent: { id: 'b1', name: 'Bruno' }, department: { id: 'd2', name: 'Development' }, decidedBy: null, tasks: [],
  parts: { problem: 'The terminal closes after an update.', facts: [{ text: 'It closed 4 times this week.', source: 'failures, 5 to 11 November' }], guesses: [], why: 'Work stops until someone opens it.', change: 'Keep the terminal through an update.', gain: null },
};
/* The same finding once sent: when it went, its number in the inbox of Hornhoof's developers, its issue and the repeats
   to report; and another the version it runs now fixed. */
const SENT: Improvement = {
  ...FINDING, id: 'i10', title: 'The queue of an agent stops after a restart of its machine and every turn waits for a person', status: 'sent', seen: 4, decidedBy: 'Maximiliana Wolkenstein-Rodenegg',
  sent: { at: '2026-11-13T09:00:00.000Z', number: 1347, issue: { number: 1347, url: 'https://github.com/invariant0x/hornhoof/issues/1347' }, fixedIn: null, repeats: 3 },
};
const FIXED: Improvement = { ...SENT, id: 'i11', title: 'Terminalverbindungsunterbrechungswiederherstellungsfehler after an update', seen: 2, sent: { ...SENT.sent!, number: 1288, issue: null, fixedIn: '0.24.0', repeats: 1 } };
const card = (over: Partial<InboxCard>): InboxCard => ({
  id: 'f1', number: 1, kind: 'bug', title: TITLE, text: 'The agent terminal stayed black.', errorCode: null, versions: ['0.18.12'], platforms: ['linux x64'], signals: 1, installations: 1, priority: 'normal',
  firstAt: '2026-11-12T08:00:00.000Z', lastAt: '2026-11-12T09:00:00.000Z', issue: null, ...over,
});
const CARDS: InboxCard[] = [
  card({ id: 'f1', priority: 'high', signals: 12, installations: 5, errorCode: 'terminal_lost_after_update_on_a_long_running_node', versions: ['0.18.11', '0.18.12', '0.18.9'], platforms: ['darwin arm64', 'linux arm64', 'linux x64'], text: TEXT }),
  card({ id: 'f2', number: 2, kind: 'idea', title: 'Click [here](javascript:alert(1)) <b>now</b>', text: '**stars** and https://evil.example/a/very/long/address/that/goes/on/and/on/without/a/single/space', priority: 'low' }),
  card({ id: 'f3', number: 1347, kind: 'improvement', title: 'Show the queue of turns on the map', priority: 'normal', signals: 3, installations: 3, issue: { number: 1347, url: 'https://github.com/invariant0x/hornhoof/issues/1347' } }),
];

export async function messagesFor(locale: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>;
  return dictionary[locale]!;
}

/* The answers of the server; inbox says which installation this is, as each scene needs. */
export async function prepare(page: Page, inbox: { value: boolean }) {
  await serveApi(page);
  await page.route('**/api/updates/current', route => route.fulfill({ json: { version: '0.18.12', commit: 'browser-test' } }));
  await page.route('**/api/feedback', route => route.fulfill({ json: { inbox: inbox.value } }));
  await page.route('**/api/feedback/preview', route => route.fulfill({ json: SHOWN }));
  await page.route('**/api/feedback/inbox', route => route.fulfill({ json: { cards: CARDS } }));
  await page.route('**/api/improvements', route => route.fulfill({ json: { improvements: [FINDING, SENT, FIXED] } }));
}

/* Errors of the page, and any file of the app it could not load. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('response', response => { if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  return problems;
}

async function setLook(page: Page, choice: Choice, language: Language) {
  await page.evaluate(({ choice, collection, language }) => {
    localStorage.setItem('hh-skins', collection);
    localStorage.setItem('hh-theme', choice);
    localStorage.setItem('hh-lang', language);
  }, { choice, collection: collectionText([{ id: 'custom-1', skin: OWN }]), language });
}

export type Scene = { name: string; inbox: boolean; open: (page: Page, words: Messages) => Promise<Locator> };

/* Writing to the developers inside About, opened from its button once About holds the focus it takes when it opens, so
   what a test types next stays where it is typed. */
async function dialog(page: Page, words: Messages): Promise<Locator> {
  await page.goto('/about');
  const about = page.getByRole('dialog', { name: words.about.title, exact: true });
  await expect(about).toBeFocused();
  const part = about.getByRole('region', { name: words.feedback.section, exact: true });
  await part.getByRole('button', { name: words.feedback.write, exact: true }).click();
  await expect(part.getByRole('button', { name: words.common.next, exact: true })).toBeVisible();
  return part;
}

/* Every place a person meets, opened the way they open it. */
export const SCENES: Scene[] = [
  { name: 'feedback-write', inbox: false, open: async (page, words) => {
    const box = await dialog(page, words);
    await box.getByLabel(words.feedback.titleLabel, { exact: true }).fill(TITLE);
    await box.getByLabel(words.feedback.text, { exact: true }).fill(TEXT);
    return box;
  } },
  { name: 'feedback-check', inbox: false, open: async (page, words) => {
    const box = await dialog(page, words);
    await box.getByLabel(words.feedback.titleLabel, { exact: true }).fill(TITLE);
    await box.getByLabel(words.feedback.text, { exact: true }).fill(TEXT);
    await box.getByRole('button', { name: words.common.next, exact: true }).click();
    await expect(box.getByRole('region', { name: words.feedback.check, exact: true })).toBeVisible();
    return box;
  } },
  { name: 'platform-card', inbox: false, open: async page => {
    await page.goto('/improvements');
    return page.getByRole('article', { name: FINDING.title, exact: true });
  } },
  { name: 'sent-card', inbox: false, open: async page => {
    await page.goto('/improvements');
    return page.getByRole('article', { name: SENT.title, exact: true });
  } },
  { name: 'fixed-card', inbox: false, open: async page => {
    await page.goto('/improvements');
    return page.getByRole('article', { name: FIXED.title, exact: true });
  } },
  { name: 'inbox', inbox: true, open: async (page, words) => {
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { level: 1, name: words.inbox.title, exact: true })).toBeVisible();
    return page.locator('.imps');
  } },
];

export async function openScene(page: Page, scene: Scene, words: Messages): Promise<Locator> {
  const found = await scene.open(page, words);
  await expect(found).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return found;
}

/* Where every block and control of the place stands, with its padding, margin, border and font. */
async function geometry(place: Locator): Promise<Record<string, unknown>[]> {
  return place.evaluate(root => {
    const selectors = [':scope', 'header', 'h2', 'h3', '.field', '.field > label', '.field > .label', '.field-control', 'input', 'textarea', '.fb-kinds button', '.fb-note', '.fb-check', 'dt', 'dd', '.fb-hidden', '.form-foot', '.form-foot > *', '.imp', '.imp-meta', '.badge', '.fb-text', '.entry-actions > *', '.fb-issue', '.req-actions > *', '.imp-case', '.imp-fate', '.imp-fate a', '.imp-fixed'];
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
  });
}

/* The lowest WCAG contrast of the text that can be read, each element's colour on the backgrounds behind it. */
async function lowestContrast(place: Locator): Promise<{ ratio: number; what: string }> {
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

/* A field keeps 44 px, a kind choice and a button of a form's foot or of a record from 44 px, the description from 120 px. */
async function heights(place: Locator): Promise<string[]> {
  return place.evaluate(root => {
    const wrong: string[] = [];
    const h = (e: Element) => Math.round(e.getBoundingClientRect().height * 100) / 100;
    for (const e of root.querySelectorAll('.field input')) if (Math.abs(h(e) - 44) > 0.5) wrong.push(`${e.tagName} ${h(e)}`);
    for (const e of root.querySelectorAll('.fb-input')) if (h(e) < 119.5) wrong.push(`textarea ${h(e)}`);
    for (const e of root.querySelectorAll('.form-foot > *, .entry-actions > *, .fb-kinds button')) if (h(e) < 43.5) wrong.push(`${e.className} ${e.textContent?.trim().slice(0, 20)} ${h(e)}`);
    return wrong;
  });
}

/* Nothing runs off the screen sideways, and no text inside the place is cut: every element holds its own content. */
export async function whole(page: Page, place: Locator): Promise<string[]> {
  const page_ = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  const cut = await place.evaluate(root =>
    [root, ...root.querySelectorAll('*')]
      .filter(e => !(e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement) && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible')
      .map(e => `${e.tagName.toLowerCase()}.${e.className} ${e.scrollWidth}>${e.clientWidth}`),
  );
  return [...(page_ ? [] : ['the page scrolls sideways']), ...cut];
}

/* A picture of the whole place for Design; one taller than the window is shot whole, the window growing in height only. */
export async function shoot(page: Page, place: Locator, path: string) {
  const size = page.viewportSize()!;
  const room = Math.ceil((await place.boundingBox())!.height) + 240;
  if (room > size.height) await page.setViewportSize({ width: size.width, height: room });
  await place.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await place.screenshot({ path, animations: 'disabled' });
  if (room > size.height) await page.setViewportSize(size);
}

function keep(info: TestInfo, name: string, body: unknown) {
  const path = info.outputPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}

/* The places named, in each theme and language, at the widths named: every block stands where it stands in the skins of
   the same fonts, text stays readable and whole, controls keep their heights and nothing runs off the screen. */
export async function checkScenes(page: Page, browserName: string, info: TestInfo, widths: number[], names: string[]) {
  const problems = watchProblems(page);
  const inbox = { value: false };
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, inbox);
  await page.goto('/');
  const report: Record<string, unknown> = { browserName, languages: LANGUAGES.map(l => l.id), contrast: {}, geometry: {} };
  for (const { id: language } of LANGUAGES) for (const width of widths) {
    const words = await messagesFor(language);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    for (const scene of names.map(name => SCENES.find(one => one.name === name)!)) {
      inbox.value = scene.inbox;
      const first = new Map<string, Record<string, unknown>[]>();
      for (const choice of CHOICES) {
        await setLook(page, choice, language);
        const found = await openScene(page, scene, words);
        await expect(page.locator('html')).toHaveAttribute('data-theme', choice);
        const now = await geometry(found);
        const same = first.get(fontsOf(choice));
        if (same) expect(now, `${language} ${width} ${scene.name} in ${choice}`).toEqual(same);
        else { (report.geometry as Record<string, unknown>)[`${language}-${width}-${scene.name}-${fontsOf(choice)}`] = now; first.set(fontsOf(choice), now); }
        const lowest = await lowestContrast(found);
        (report.contrast as Record<string, unknown>)[`${language}-${width}-${scene.name}-${choice}`] = lowest;
        expect(lowest.ratio, `${language} ${width} ${scene.name} ${choice} ${lowest.what}`).toBeGreaterThanOrEqual(4.5);
        expect(await heights(found), `${language} ${width} ${scene.name} ${choice}`).toEqual([]);
        expect(await whole(page, found), `${language} ${width} ${scene.name} ${choice}`).toEqual([]);
        await shoot(page, found, info.outputPath(`${browserName}/${language}-${width}-${scene.name}-${choice}.png`));
      }
    }
  }
  keep(info, `${browserName}/feedback-geometry.json`, report);
  expect(problems).toEqual([]);
}
