import { expect, test, type Locator, type Page } from '@playwright/test';
import { BUILTIN_SKINS } from '../src/skins/registry';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import type { MachineView } from '../src/types';
import { ME, openTaskCard, serveApi } from './api';
import type { PhoneView } from '../src/ui/Phones';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const machine: MachineView = { id: 'm1', hostname: 'Company computer', os: 'linux', arch: 'arm64', owner: { id: ME.person.id, name: ME.person.name }, online: true, lastSeenAt: null, plans: [], load: null, lendsTests: false, running: { agents: [], parts: [] } };
const phone: PhoneView = { id: 'ph1', name: 'Android компании с длинным названием телефона', machineId: machine.id, owner: { id: ME.person.id, name: ME.person.name }, lending: true, online: true, stopping: false, state: 'available', queued: 2 };

async function words(language: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${language}.ts`) as Record<string, Messages>;
  return dictionary[language]!;
}

async function setup(page: Page, language: Language, skin: string) {
  const t = await words(language);
  await page.clock.install({ time: NOW });
  await page.clock.pauseAt(NOW);
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [machine], builtin: null, priority: false, move: null, canMove: false, copies: null } }));
  let registered: PhoneView | null = null;
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

for (const width of [375, 1440]) {
  test(`register, watch and Stop at ${width}px in every shipped theme and language`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const skin of BUILTIN_SKINS) for (const language of LANGUAGES) {
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
      await card.getByRole('button', { name: t.phones.stop, exact: true }).click();
      await expect(card.getByText(t.phones.paused, { exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: t.phones.resume })).toBeEnabled();
      // Neither shipped language is RTL; this checks the same controls in a synthetic RTL direction.
      await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
      await fits(card);
      expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      if (info.project.name === 'phones-chromium' && skin.id === 'light' && language.id === 'ru') await page.screenshot({ path: info.outputPath(`stopped-${width}.png`), fullPage: true });
      // The fixture deliberately keeps /api/stream open; navigation disposes that request.
      await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    }
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
