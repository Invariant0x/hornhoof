import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { collectionText } from '../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import type { Skin } from '../src/skins/roles';
import { builtinFile } from '../src/skins/validate';
import type { FeedbackShown, Improvement, InboxCard } from '../src/types';
import { serveApi } from './api';
import { fontsOf, geometry, keep, lowestContrast, messagesFor, openPlace as openScene, shoot, watchProblems } from './look-steps';

export { messagesFor, openScene, shoot };

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

/* The answers of the server; inbox says which installation this is, as each scene needs. */
export async function prepare(page: Page, inbox: { value: boolean }) {
  await serveApi(page);
  await page.route('**/api/updates/current', route => route.fulfill({ json: { version: '0.18.12', commit: 'browser-test' } }));
  await page.route('**/api/feedback', route => route.fulfill({ json: { inbox: inbox.value } }));
  await page.route('**/api/feedback/preview', route => route.fulfill({ json: SHOWN }));
  await page.route('**/api/feedback/inbox', route => route.fulfill({ json: { cards: CARDS } }));
  await page.route('**/api/improvements', route => route.fulfill({ json: { improvements: [FINDING, SENT, FIXED] } }));
}

export async function setLook(page: Page, choice: Choice, language: Language) {
  await page.evaluate(({ choice, collection, language }) => {
    localStorage.setItem('hh-skins', collection);
    localStorage.setItem('hh-theme', choice);
    localStorage.setItem('hh-lang', language);
  }, { choice, collection: collectionText([{ id: 'custom-1', skin: OWN }]), language });
}

export type Scene = { name: string; inbox: boolean; open: (page: Page, words: Messages) => Promise<Locator> };

/* Writing to the developers inside About, opened from its button once About holds the focus it takes when it opens, so
   what a test types next stays where it is typed. */
export async function dialog(page: Page, words: Messages): Promise<Locator> {
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

/* The blocks and controls of a place whose stand, padding, margin, border and font are measured. */
const PARTS = [':scope', 'header', 'h2', 'h3', '.field', '.field > label', '.field > .label', '.field-control', 'input', 'textarea', '.fb-kinds button', '.fb-note', '.fb-check', 'dt', 'dd', '.fb-hidden', '.form-foot', '.form-foot > *', '.imp', '.imp-meta', '.badge', '.fb-text', '.entry-actions > *', '.fb-issue', '.req-actions > *', '.imp-case', '.imp-fate', '.imp-fate a', '.imp-fixed'];

/* A field keeps 44 px, a kind choice and a button of a form's foot or of a record from 44 px, the description from 120 px. */
export async function heights(place: Locator): Promise<string[]> {
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
        const now = await geometry(found, PARTS);
        const same = first.get(fontsOf(choice, OWN));
        if (same) expect(now, `${language} ${width} ${scene.name} in ${choice}`).toEqual(same);
        else { (report.geometry as Record<string, unknown>)[`${language}-${width}-${scene.name}-${fontsOf(choice, OWN)}`] = now; first.set(fontsOf(choice, OWN), now); }
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
