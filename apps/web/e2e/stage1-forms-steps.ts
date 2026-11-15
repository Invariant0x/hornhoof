import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import { collectionText } from '../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin } from '../src/skins/registry';
import type { Skin } from '../src/skins/roles';
import { builtinFile } from '../src/skins/validate';
import type { Decisions, PersonView, ProposalDecision, Roster, SubView } from '../src/types';
import { serveApi } from './api';

/* The forms of stage 1 as Design drew them: adding and editing a person, a personal AI assistant with its key, hiring into a
   department and connecting plans and keys. In each built-in theme and a theme of a person's own every block of a form
   stands in the same place with the same size as in every other theme with the same fonts, text stays readable, controls
   keep their heights, and nothing runs off the screen,
   on the longest and the shortest shipped language, at a phone's width and a desktop's. What each engine measured is kept
   in a file, so the three engines can be compared with each other. */

/* A theme of a person's own that changes only colours of Cyberpunk, so its layout must match Cyberpunk's exactly. */
const SAMPLE = builtinFile(builtinSkin('cyberpunk')!, { ru: 'Сумерки', en: 'Dusk' });
const CUSTOM: Skin = { ...SAMPLE, colors: { ...SAMPLE.colors, bg: '#10002B', surface: '#1A0440', surface2: '#240A52', accent: '#FF9E00', accent_ink: '#FFC266', button: '#FF9E00', on_button: '#1A0E00' } };
const CHOICES = [...BUILTIN_SKINS.map(skin => skin.id), 'custom-1'] as const;
type Choice = (typeof CHOICES)[number];
/* The fonts of a theme: blocks stand in the same place in every theme written in the same fonts. */
/* Skins whose headings and text start with the same font lay out the same; Onest and Tektur are carried, so the rest of a
   stack never shows. */
const fontsOf = (choice: Choice) => {
  const { fonts } = builtinSkin(choice) ?? CUSTOM;
  return `${fonts.display[0]} ${fonts.body[0]}`;
};
const RTL = /^(?:ar|he|fa|ur|ps|sd|ug|yi)(?:-|$)/;
export const WIDTHS = [1440, 375];

const WHOLE = { whole: true, departments: [], teams: [] };
export const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: WHOLE },
  { id: 'p2', name: 'Maximiliana Wolkenstein-Rodenegg', email: 'maximiliana.wolkenstein-rodenegg@acme-international.com', title: 'CMO', status: 'active', isOwner: false, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] }, telegram: { username: 'maximiliana_w', id: null } },
  { id: 'p3', name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', status: 'invited', isOwner: false, access: WHOLE },
  {
    id: 'h1', name: 'Ava', email: null, title: 'Personal assistant', status: 'active', isOwner: false, access: { whole: false, departments: [], teams: [] },
    assistant: { owner: { id: 'p2', name: 'Maximiliana Wolkenstein-Rodenegg' }, program: 'openclaw', eventsUrl: 'http://192.168.1.5:18789/hooks/wake', skillsUrl: null, agent: null, key: { createdAt: '2026-11-11T10:00:00.000Z' } },
  },
];
const KEY = `hha_${'K7x-Qp'.repeat(7)}a`;
const SECRET = `hhs_${'s3_Vb9'.repeat(7)}z`;
/* OpenClaw's settings as the server gives them, with their longest lines: the address and the key. */
const SETUP = {
  file: '~/.openclaw/openclaw.json',
  text: ['{', '  mcp: {', '    servers: {', '      hornhoof: {', '        url: "https://acme.hornhoof.app/api/assistant/mcp",', '        transport: "streamable-http",', `        headers: { Authorization: "Bearer ${KEY}" },`, '      },', '    },', '  },', '  hooks: {', '    enabled: true,', `    token: "${SECRET}",`, '  },', '}'].join('\n'),
};
const MADE = { key: KEY, signingSecret: SECRET, address: 'https://acme.hornhoof.app', setup: SETUP, person: PEOPLE[3] };
export const INVITE = 'https://hq.acme.com/invite/hh_inv_98f2c4a17b0e4d12a9c3f0e6b5d7a8c1';
const MACHINE = { id: 'm1', hostname: 'dev-laptop', status: 'needs_login' as const, online: true };
const KIMI: SubView = {
  kind: 'personal', last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, limits: null, budget: null, isOrchestrator: false,
  accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null, id: 's-kimi', provider: 'kimi', label: 'Kimi', status: 'needs_login', online: true, machines: [MACHINE],
};
const role = (id: string, en: string, ru: string, required: boolean, holder: string | null) => ({
  id, title: { en, ru }, kind: 'member' as const, tier: 'standard' as const, perProduct: false, skills: [], subscription: null, required, holder,
});
/* A department no subscription serves yet, so the warning shows, with a head, a required role and one more. */
const ROSTER: Roster = {
  people: [],
  roles: [
    { ...role('OPS-HEAD', 'Head of operations', 'Руководитель операционного отдела', true, null), kind: 'head' },
    role('OPS-PROGRAM', 'Program operator', 'Оператор программ', true, null),
    role('OPS-INTEG', 'Integrations engineer', 'Инженер интеграций', false, null),
  ],
  products: [],
  subscriptions: [],
};
const DECISIONS = (name: string): Decisions => ({
  requests: [],
  proposals: [{
    id: 'pr1', kind: 'staff', brief: 'Someone to keep the programs running.', department: { id: 'd-ops', name }, ownerPersonId: 'p1', canAnswer: true,
    items: [{ role: 'OPS-HEAD', checked: true }, { role: 'OPS-PROGRAM', checked: true }, { role: 'OPS-INTEG', checked: false }],
  } as ProposalDecision],
  machineAccess: [],
  counts: { byPerson: { p1: 1 }, byAgent: {}, total: 1 },
});

export async function messagesFor(locale: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>;
  return dictionary[locale]!;
}

export async function prepare(page: Page) {
  await serveApi(page);
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.6.1', commit: 'browser-test' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.6.1', commit: 'browser-test' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
  await page.route('**/api/requests', route => route.fulfill({ json: DECISIONS('Operations') }));
  await page.route('**/api/departments/d-ops/roster', route => route.fulfill({ json: ROSTER }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [KIMI] } }));
  await page.route('**/api/people**', route => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (method === 'GET' && pathname === '/api/people') return route.fulfill({ json: { people: PEOPLE } });
    if (method === 'POST' && pathname === '/api/people/h1/key') return route.fulfill({ status: 201, json: MADE });
    if (method === 'POST' && pathname === '/api/people/p3/invite') return route.fulfill({ json: { person: PEOPLE[2], inviteUrl: INVITE } });
    return route.fallback();
  });
}

/* Errors of the page, and any file of the app it could not load. */
function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  page.on('response', response => { if (!new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
  return problems;
}

async function setTheme(page: Page, choice: Choice) {
  await page.evaluate(({ choice, collection }) => {
    localStorage.setItem('hh-skins', collection);
    localStorage.setItem('hh-theme', choice);
  }, { choice, collection: collectionText([{ id: 'custom-1', skin: CUSTOM }]) });
}

/* Where every block and control of the open form stands, with its padding, margin, border and font. */
async function geometry(form: Locator): Promise<Record<string, unknown>[]> {
  return form.evaluate(root => {
    const selectors = [':scope', '.form-head', '.form-title', '.form-title > svg', '.field', '.field > label', '.field > .label', '.field-control', 'input:not(.sr)', 'select', '.hint', '.kind-switch', '.kind-card', '.kind-card > svg', '.check-card', '.form-foot', '.form-foot > *', '.secret', '.secret > p', '.secret-code', '.alert', '.warn-line', '.warn-line > svg', '.plan', '.plan > svg', '.staff-row', '.staff-field', '.badge', 'h4', 'h4 > svg', '.entry-actions > *', '.key-line', '.access-list label', '.busy-swap'];
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

/* The lowest WCAG contrast of the text that can be read in the form, each element's colour on the backgrounds behind it. */
async function lowestContrast(form: Locator): Promise<{ ratio: number; what: string }> {
  return form.evaluate(root => {
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

/* Each control keeps its height: a field and a select 40 px, or 44 px on Subscriptions & API as Design checked it (#989),
   a button of a form's foot and a choice card from 44 px. On a desktop's width a button of the foot has the room for its
   words and stays on one line of 44 px. */
async function heights(form: Locator, wide: boolean): Promise<string[]> {
  return form.evaluate((root, wide) => {
    const wrong: string[] = [];
    const h = (e: Element) => Math.round(e.getBoundingClientRect().height * 100) / 100;
    const field = root.closest('.subs') ? 44 : 40;
    for (const e of root.querySelectorAll('.field input:not(.sr, [type="checkbox"], [type="radio"]), .field select, .staff-pick select')) if (Math.abs(h(e) - field) > 0.5) wrong.push(`${e.tagName} ${h(e)}`);
    for (const e of root.querySelectorAll('.form-foot > *, .entry-actions > *, .kind-card, .check-card, .plan')) if (h(e) < 43.5) wrong.push(`${e.className} ${e.textContent?.trim().slice(0, 20)} ${h(e)}`);
    if (wide) for (const e of root.querySelectorAll('.form-foot > *')) if (h(e) > 44.5) wrong.push(`one line: ${e.className} ${e.textContent?.trim().slice(0, 20)} ${h(e)}`);
    for (const e of root.querySelectorAll('input[type="checkbox"], input[type="radio"]:not(.sr)')) if (Math.abs(h(e) - 16) > 0.5) wrong.push(`${e.getAttribute('type')} ${h(e)}`);
    return wrong;
  }, wide);
}

export const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.form-card, .t-card.staff, .key-form')].every(e => e.scrollWidth <= e.clientWidth + 1));

export type Form = { name: string; open: (page: Page, words: Messages) => Promise<Locator> };

async function people(page: Page) {
  await page.goto('/people');
  await expect(page.locator('table.ptable')).toBeVisible();
}

/* Every form of stage 1, opened the way a person opens it. */
export const FORMS: Form[] = [
  { name: 'invite-person', open: async (page, words) => {
    await people(page);
    await page.getByRole('button', { name: words.people.invitePerson, exact: true }).click();
    return page.locator('.form-card', { has: page.getByRole('radiogroup') });
  } },
  { name: 'invite-assistant', open: async (page, words) => {
    await people(page);
    await page.getByRole('button', { name: words.people.invitePerson, exact: true }).click();
    /* A person presses the card; the radio in it is for the keyboard and screen readers. */
    const radio = page.getByRole('radio', { name: words.people.kindAssistant, exact: true });
    await page.locator('label.kind-card', { has: radio }).click();
    await expect(radio).toBeChecked();
    return page.locator('.form-card', { has: page.getByRole('radiogroup') });
  } },
  { name: 'invite-link', open: async (page, words) => {
    await people(page);
    await page.getByRole('button', { name: words.people.newLinkLabel('Sasha'), exact: true }).click();
    return page.locator('.form-card', { has: page.getByText(INVITE, { exact: true }) });
  } },
  { name: 'edit-person', open: async (page, words) => {
    await people(page);
    await page.getByRole('button', { name: words.people.editLabel(PEOPLE[1]!.name), exact: true }).click();
    return page.locator('.form-card', { has: page.getByRole('switch') });
  } },
  { name: 'assistant-key', open: async (page, words) => {
    await people(page);
    await page.getByRole('button', { name: words.people.editLabel('Ava'), exact: true }).click();
    await page.getByRole('button', { name: words.people.replaceKey, exact: true }).click();
    const card = page.locator('.form-card', { has: page.getByText(MADE.key, { exact: true }) });
    await expect(card).toBeVisible();
    return card;
  } },
  { name: 'staff-card', open: async page => {
    await page.goto('/tasks');
    const card = page.locator('.t-card.staff');
    await expect(card.locator('.staff-pick').first()).toBeVisible();
    return card;
  } },
  { name: 'connect-plans', open: async (page, words) => {
    await page.goto('/subscriptions');
    await page.getByRole('button', { name: words.subs.connect, exact: true }).click();
    return page.locator('.form-card', { has: page.locator('.plans') });
  } },
  { name: 'key-form', open: async (page, words) => {
    await page.goto('/subscriptions');
    await page.getByRole('button', { name: new RegExp(`^(Open the card of|Открыть карточку) Kimi`) }).click();
    await page.getByRole('button', { name: words.subs.pasteKeyLabel('Kimi'), exact: true }).click();
    return page.locator('.key-form');
  } },
];

export async function openForm(page: Page, form: Form, words: Messages): Promise<Locator> {
  const found = await form.open(page, words);
  await expect(found).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  return found;
}

/* The text the forms show in a language, to rank the shipped languages by how much room they take. */
async function chooseLanguages(page: Page): Promise<Language[]> {
  const ranked: { id: Language; characters: number }[] = [];
  for (const { id } of LANGUAGES) {
    const words = await messagesFor(id);
    await page.evaluate(language => localStorage.setItem('hh-lang', language), id);
    let characters = 0;
    for (const form of FORMS) characters += ((await (await openForm(page, form, words)).textContent()) ?? '').replace(/\s+/g, '').length;
    ranked.push({ id, characters });
  }
  ranked.sort((a, b) => a.characters - b.characters || a.id.localeCompare(b.id));
  const rtl = LANGUAGES.map(language => language.id).filter(id => RTL.test(id));
  return [...new Set([ranked[0]!.id, ranked.at(-1)!.id, ...rtl.slice(0, 1)])];
}

/* A picture of the whole form for Design. A form taller than the window is shot whole: the window grows in height only, so
   nothing moves sideways, the form stands in its middle clear of the bar on top, and the window goes back after it. */
async function shoot(page: Page, form: Locator, path: string) {
  const size = page.viewportSize()!;
  const room = Math.ceil((await form.boundingBox())!.height) + 240;
  if (room > size.height) await page.setViewportSize({ width: size.width, height: room });
  await form.evaluate(e => e.scrollIntoView({ block: 'center' }));
  await form.screenshot({ path, animations: 'disabled' });
  if (room > size.height) await page.setViewportSize(size);
}

function keep(info: TestInfo, name: string, body: unknown) {
  const path = info.outputPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}

/* The forms named, in each theme, on the longest and the shortest language, at the widths named: every block stands where
   it stands in the themes of the same fonts, text stays readable, controls keep their heights and nothing runs off the
   screen. */
export async function checkForms(page: Page, browserName: string, info: TestInfo, widths: number[], names: string[]) {
  const problems = watchProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { if (!localStorage.getItem('hh-lang')) localStorage.setItem('hh-lang', 'en'); });
  await prepare(page);
  await page.goto('/');
  /* Ranking only picks the shortest and the longest shipped language. Of two languages those are both, so both are checked
     whole without measuring them first; with more, each file ranks them again. */
  const languages = LANGUAGES.length <= 2 ? LANGUAGES.map(({ id }) => id) : await chooseLanguages(page);
  const report: Record<string, unknown> = { browserName, languages, contrast: {}, geometry: {} };
  for (const language of languages) for (const width of widths) {
    const words = await messagesFor(language);
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.evaluate(lang => localStorage.setItem('hh-lang', lang), language);
    for (const form of names.map(name => FORMS.find(one => one.name === name)!)) {
      const first = new Map<string, Record<string, unknown>[]>();
      for (const choice of CHOICES) {
        await setTheme(page, choice);
        const found = await openForm(page, form, words);
        await expect(page.locator('html')).toHaveAttribute('data-theme', choice);
        const now = await geometry(found);
        const same = first.get(fontsOf(choice));
        if (same) expect(now, `${language} ${width} ${form.name} in ${choice}`).toEqual(same);
        else (report.geometry as Record<string, unknown>)[`${language}-${width}-${form.name}-${choice}`] = now;
        if (!same) first.set(fontsOf(choice), now);
        const lowest = await lowestContrast(found);
        (report.contrast as Record<string, unknown>)[`${language}-${width}-${form.name}-${choice}`] = lowest;
        expect(lowest.ratio, `${language} ${width} ${form.name} ${choice} ${lowest.what}`).toBeGreaterThanOrEqual(4.5);
        expect(await heights(found, width === 1440), `${language} ${width} ${form.name} ${choice}`).toEqual([]);
        expect(await noSideScroll(page), `${language} ${width} ${form.name} ${choice}: no sideways scroll`).toBe(true);
        await shoot(page, found, info.outputPath(`${browserName}/${language}-${width}-${form.name}-${choice}.png`));
      }
    }
  }
  keep(info, `${browserName}/forms-geometry.json`, report);
  expect(problems).toEqual([]);
}
