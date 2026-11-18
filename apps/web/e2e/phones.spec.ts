import { expect, test, type Locator, type Page } from '@playwright/test';
import { BUILTIN_SKINS } from '../src/skins/registry';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import type { MachineView } from '../src/types';
import { ME, openTaskCard, serveApi } from './api';
import type { PhoneView } from '../src/ui/Phones';
import { inOneRowAtEnd } from './button-row';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const machine: MachineView = { id: 'm1', hostname: 'Company computer', os: 'linux', arch: 'arm64', owner: { id: ME.person.id, name: ME.person.name }, online: true, lastSeenAt: null, plans: [], load: null, lendsTests: false, running: { agents: [], parts: [] } };
const phone: PhoneView = { id: 'ph1', name: 'Android компании с длинным названием телефона', machineId: machine.id, owner: { id: ME.person.id, name: ME.person.name }, lending: true, online: true, stopping: false, state: 'available', queued: 2 };
const missing: PhoneView = { ...phone, online: false, state: 'offline', connection: 'not_connected' };
const ready: PhoneView = { ...phone, connection: 'ready' };
const away: PhoneView = { ...phone, online: false, state: 'offline', connection: 'computer_offline' };

/* Each state of a phone's card the style book draws as a status: its words, the token of its role for the words and the
   frame, the line on what to do, and why Watch screen is off where it is. */
type CardState = { title: string; file: string; phone: PhoneView; words: (t: Messages) => string; ink: string; frame: string; hint?: (t: Messages) => string; noScreen?: (t: Messages) => string };
const CARD_STATES: CardState[] = [
  { title: 'a phone its computer does not see', file: 'not-connected', phone: missing, words: t => t.phones.notConnected.state, ink: '--amber-ink', frame: '--amber-ink', hint: t => t.phones.notConnected.hint, noScreen: t => t.phones.noScreen.not_connected },
  { title: 'a phone available to assistants', file: 'available', phone: ready, words: t => t.phones.states.available, ink: '--ok', frame: '--ok' },
  { title: 'a phone whose computer is offline', file: 'computer-offline', phone: away, words: t => t.phones.states.offline, ink: '--muted', frame: '--line2', noScreen: t => t.phones.noScreen.computer_offline },
];

async function words(language: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${language}.ts`) as Record<string, Messages>;
  return dictionary[language]!;
}

async function setup(page: Page, language: Language, skin: string, listed: PhoneView | null = null) {
  const t = await words(language);
  /* The page's clock runs from the moment it is installed until it is paused, however briefly on a busy machine, and a
     pause cannot go back: it starts a minute before NOW, longer than a test may take, and stands still at NOW. */
  await page.clock.install({ time: NOW - 60_000 });
  await page.clock.pauseAt(NOW);
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [machine], builtin: null, priority: false, move: null, canMove: false, copies: null } }));
  let registered: PhoneView | null = listed;
  await page.route('**/api/phones', route => {
    if (route.request().method() === 'POST') { registered = phone; return route.fulfill({ status: 201, json: registered }); }
    return route.fulfill({ json: { phones: registered ? [registered] : [] } });
  });
  await page.route('**/api/phones/probe', route => route.fulfill({ json: { devices: [{ serial: '192.168.1.80:5555', model: 'Pixel 8', status: 'device', hardwareKey: 'a'.repeat(64) }] } }));
  await page.route('**/api/phones/ph1/stop', route => { registered = { ...phone, lending: false, state: 'owner' }; return route.fulfill({ json: registered }); });
  await page.route('**/api/phones/ph1/resume', route => { registered = phone; return route.fulfill({ json: registered }); });
  await page.route('**/api/phones/ph1/live', route => route.fulfill({ json: { lending: true, frame: { sequence: 1, at: new Date(NOW).toISOString(), imageUrl: null } } }));
  await page.addInitScript(({ language, skin }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', skin); }, { language, skin });
  await page.goto('/machines', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: t.phones.heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return t;
}

async function fits(host: Locator) {
  const result = await host.evaluate(el => {
    const frame = el.getBoundingClientRect();
    return [...el.querySelectorAll<HTMLElement>('button,input,select')].filter(n => n.getBoundingClientRect().height > 0).map(n => {
      const box = n.getBoundingClientRect();
      return { text: n.textContent ?? n.getAttribute('name'), height: box.height, overflow: Math.max(frame.left - box.left, box.right - frame.right, 0) };
    });
  });
  for (const r of result) { expect(r.height, r.text ?? '').toBeGreaterThanOrEqual(44); expect(r.overflow, r.text ?? '').toBeLessThanOrEqual(1); }
}

/* On a wide card the parts stand side by side, and the words of their headings stand on one line, within a pixel. The
   words, not the heading's box: a part stretched to its row keeps its box at the top while its words move down. */
async function partsInLine(card: Locator) {
  const tops = await card.locator('.part-h').evaluateAll(headings => headings.map(h => {
    const words = document.createRange();
    words.selectNodeContents(h);
    return words.getBoundingClientRect().top;
  }));
  expect(tops).toHaveLength(2);
  expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThanOrEqual(1);
}

/* What a token of the open skin computes to, to compare a colour with the token rather than with a number. */
async function tokenColour(page: Page, token: string): Promise<string> {
  return page.evaluate(name => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

/* Each shipped theme and language is a test of its own: each loads the page anew, and eight loads in one test took a busy
   machine past the time a test has. The title names the language, not its id, so the run of a release checks every
   theme and language at 1440px as before, and the full run the 375px ones. */
for (const width of [375, 1440]) for (const skin of BUILTIN_SKINS) for (const language of LANGUAGES) {
  test(`register, watch and Stop at ${width}px in the ${skin.id} theme, ${language.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const t = await setup(page, language.id, skin.id);
    const section = page.getByRole('region', { name: t.phones.heading });
    await expect(section.getByText(t.phones.empty, { exact: true })).toBeVisible();
    await section.getByRole('button', { name: t.phones.add, exact: true }).click();
    const form = section.getByRole('form', { name: t.phones.add });
    await form.getByRole('button', { name: t.phones.find, exact: true }).click();
    await expect(form.getByLabel(t.phones.name, { exact: true })).toBeFocused();
    await expect(form.getByLabel(t.phones.name, { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await form.getByLabel(t.phones.name, { exact: true }).fill(phone.name);
    await form.getByLabel(t.phones.address, { exact: true }).fill('192.168.1.80:5555');
    await fits(form);
    if (info.project.name === 'phones-chromium' && skin.id === 'cyberpunk' && language.id === 'ru') await page.screenshot({ path: info.outputPath(`add-${width}.png`), fullPage: true });
    await form.getByRole('button', { name: t.phones.find, exact: true }).click();
    await expect(form.getByText(t.phones.devices.device, { exact: true })).toBeVisible();
    await form.getByRole('button', { name: t.phones.add, exact: true }).click();
    const card = section.getByRole('article', { name: phone.name });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: t.phones.watch }).click();
    await expect(card.getByText(t.phones.noPicture).first()).toBeVisible();
    await fits(card);
    if (width === 1440) await partsInLine(card);
    await card.getByRole('button', { name: t.phones.stop, exact: true }).click();
    await expect(card.getByText(t.phones.paused, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: t.phones.resume })).toBeEnabled();
    // Neither shipped language is RTL; this checks the same controls in a synthetic RTL direction.
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    await fits(card);
    expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    if (info.project.name === 'phones-chromium' && skin.id === 'light' && language.id === 'ru') await page.screenshot({ path: info.outputPath(`stopped-${width}.png`), fullPage: true });
  });
}

/* Find phone and Cancel stand side by side at the end edge of the form, as Save and Cancel of a key do (Design, #1321).
   Neither shipped language is right to left, so right to left is the same form in a synthetic direction. */
for (const width of [1440, 375]) for (const language of LANGUAGES) for (const dir of ['ltr', 'rtl'] as const) {
  test(`Find phone and Cancel stand in one row at the end edge, ${dir}, at ${width}px, ${language.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const t = await setup(page, language.id, 'light');
    await page.evaluate(dir => { document.documentElement.dir = dir; }, dir);
    const section = page.getByRole('region', { name: t.phones.heading });
    await section.getByRole('button', { name: t.phones.add, exact: true }).click();
    const form = section.getByRole('form', { name: t.phones.add });
    await expect(form).toBeVisible();
    await inOneRowAtEnd(form, [t.phones.find, t.phones.cancel]);
    await fits(form);
    if (info.project.name === 'phones-chromium') await form.screenshot({ path: info.outputPath(`add-phone-buttons-${language.id}-${dir}-${width}.png`) });
  });
}

/* The card in each of those states: the state in its role's colours while the owner stays a muted line, Watch screen off
   with its reason where the phone cannot be watched, Stop on, and everything inside the card in both directions. */
for (const shown of CARD_STATES) for (const width of [375, 1440]) for (const skin of BUILTIN_SKINS) for (const language of LANGUAGES) {
  test(`${shown.title} at ${width}px in the ${skin.id} theme, ${language.name}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const t = await setup(page, language.id, skin.id, shown.phone);
    const section = page.getByRole('region', { name: t.phones.heading });
    const card = section.getByRole('article', { name: shown.phone.name });
    const state = card.locator('.stline').getByText(shown.words(t), { exact: true });
    await expect(state).toHaveCSS('color', await tokenColour(page, shown.ink));
    await expect(state).toHaveCSS('border-top-color', await tokenColour(page, shown.frame));
    await expect(card.locator('.stline').getByText(t.phones.owner(shown.phone.owner.name), { exact: true })).toHaveCSS('color', await tokenColour(page, '--muted'));
    const texts: Locator[] = [];
    if (shown.hint) texts.push(card.getByText(shown.hint(t), { exact: true }));
    else await expect(card.getByText(t.phones.notConnected.hint, { exact: true })).toHaveCount(0);
    const watch = card.getByRole('button', { name: t.phones.watch });
    if (shown.noScreen) {
      await expect(watch).toBeDisabled();
      await expect(watch).toHaveAccessibleDescription(shown.noScreen(t));
      texts.push(card.getByText(shown.noScreen(t), { exact: true }));
    } else {
      await expect(watch).toBeEnabled();
      await expect(watch).toHaveAccessibleDescription('');
    }
    for (const text of texts) await expect(text).toBeVisible();
    await expect(card.getByRole('button', { name: t.phones.stop, exact: true })).toBeEnabled();
    for (const direction of ['ltr', 'rtl']) {
      await page.evaluate(dir => { document.documentElement.dir = dir; }, direction);
      await fits(card);
      const outer = await card.boundingBox();
      for (const text of texts) {
        const inner = await text.boundingBox();
        expect(inner!.x).toBeGreaterThanOrEqual(outer!.x - 1);
        expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
      }
      if (width === 1440) await partsInLine(card);
      expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.dir = 'ltr'; });
    if (info.project.name === 'phones-chromium' && ['light', 'cyberpunk'].includes(skin.id)) await card.screenshot({ path: info.outputPath(`${shown.file}-${skin.id}-${language.id}-${width}.png`) });
  });
}

test('task recording opens and advances with virtual time', async ({ page }) => {
  const t = await setup(page, 'en', 'cyberpunk');
  await page.route('**/api/tasks/t1/phone-recordings', route => route.fulfill({ json: { recordings: [{ id: 's1', phone: 'Pixel', agent: 'Assistant', status: 'ended', reason: 'completed', startedAt: new Date(NOW).toISOString(), endedAt: new Date(NOW).toISOString(), frames: [1, 2].map(sequence => ({ sequence, at: new Date(NOW + sequence * 1000).toISOString(), imageUrl: null })) }] } }));
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.tasks, exact: true }).click();
  await openTaskCard(page, 1);
  const recording = page.getByRole('region', { name: t.phones.recordings });
  await recording.getByRole('button', { name: t.phones.replay }).click();
  await expect(recording.getByText(t.phones.frameOf(1, 2), { exact: true })).toBeVisible();
  await recording.getByRole('button', { name: t.phones.play, exact: true }).click();
  await page.clock.runFor(1500);
  await expect(recording.getByText(t.phones.frameOf(2, 2), { exact: true })).toBeVisible();
  await fits(recording);
});
