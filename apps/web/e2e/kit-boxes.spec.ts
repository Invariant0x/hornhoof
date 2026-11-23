import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { THEME_KIT_SLOTS } from '@hornhoof/protocol/themes';
import type { Messages } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { builtinSkin } from '../src/skins/registry';
import type { MachineView } from '../src/types';
import type { PhoneView } from '../src/ui/Phones';
import { ME, openTaskCard, serveApi } from './api';
import { captureWith } from './capture';
import { RgbaCanvas } from './fixture-png';

/* A theme's painted kit (#1970, the theme UI kit 1.0, TEST-PLAN 2) draws over the token look and never moves a box: on
   every frame, every box of the page is where it is with the kit and without it, the page and its panels have no sideways
   scroll, and a side panel's scrollbar keeps the frame room from the panel's edge, so a painted frame is never under it.
   A danger action is told by its verb and its place, last in its row, not by its colour alone.

   The kit is installed as #1960's store gives it: the company's theme, its look and kit from /api/themes/:id/look, its
   pictures from /api/themes/files/. The pictures here are made by the test; HH_KIT_PACK names a pack folder on this
   machine to draw the real one for Design's shots, and that art never goes into git (#84, #105). */

const capture = captureWith('kit', process.env.HH_SCREENSHOT_DIR);
const PACK = process.env.HH_KIT_PACK;
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const SIZES = { 1440: { width: 1440, height: 900 }, 375: { width: 375, height: 812 } } as const;
const THEME = 'egypt';
const BASE = `/api/themes/files/${THEME}/1.0.0/`;

type Slot = { file: string; slice?: string; width?: string; outset?: string; repeat?: string; size?: string };
type Kit = { slots: Record<string, Slot>; colors: Record<string, string> };

/* Every slot of the kit, with the measures of its kind as the Egypt packs give them, on plain made pictures. */
function madeKit(): { kit: Kit; files: Map<string, Buffer> } {
  const FRAMES: Record<string, Omit<Slot, 'file'>> = {
    dialog: { slice: '63 62 56 62 fill', width: '31.5px 31px 28px 31px', outset: '12.9px 11.2px 11.2px 11.2px', repeat: 'round' },
    menu: { slice: '38 30 35 30 fill', width: '19px 15px 17.5px 15px', outset: '11px 3.4px 10.3px 3.4px', repeat: 'round' },
    window: { slice: '38 30 35 30 fill', width: '19px 15px 17.5px 15px', outset: '11px 3.4px 10.3px 3.4px', repeat: 'round' },
    drawer: { slice: '50 45 50 45 fill', width: '25px 22.5px 25px 22.5px', outset: '9px 12.8px 7.2px 12.8px', repeat: 'round' },
    card: { slice: '36 fill', width: '18px', outset: '1.5px', repeat: 'round' },
    table: { slice: '36 fill', width: '18px', outset: '1.5px', repeat: 'round' },
    'plaque-frame': { slice: '24 43 24 43 fill', width: '12px 21.5px 12px 21.5px', outset: '1.2px', repeat: 'round' },
    tile: { slice: '16 fill', width: '8px' },
  };
  const FILLS = ['ground', 'panel', 'dialog-fill', 'plaque', 'band'];
  const STRIPS = ['thead', 'row-hover', 'row-selected', 'track', 'fill', 'corner'];
  const slots: Record<string, Slot> = {};
  const files = new Map<string, Buffer>();
  for (const name of THEME_KIT_SLOTS) {
    const file = `${name}@2x.png`;
    let w = 64, h = 40, rim = 6;
    if (FRAMES[name]) [w, h, rim] = [136, 136, 20];
    if (FILLS.includes(name) || STRIPS.includes(name)) [w, h, rim] = [64, 64, 0];
    if (name === 'tab-on') [w, h, rim] = [96, 8, 0];
    if (name === 'divider') [w, h, rim] = [200, 14, 0];
    const picture = new RgbaCanvas(w, h);
    picture.polygon([[0, 0], [w, 0], [w, h], [0, h]], [120, 84, 40, 255]);
    if (rim) picture.polygon([[rim, rim], [w - rim, rim], [w - rim, h - rim], [rim, h - rim]], [236, 220, 188, 255]);
    files.set(file, picture.png());
    if (FRAMES[name]) slots[name] = { file, ...FRAMES[name] };
    else if (FILLS.includes(name)) slots[name] = { file, size: '96px 96px' };
    else if (STRIPS.includes(name)) slots[name] = { file, size: '100% 100%' };
    else if (name === 'tab-on') slots[name] = { file, size: 'calc(100% - 20px) 5px' };
    else if (name === 'divider') slots[name] = { file, slice: '0 24 fill', width: '0 12px', outset: '3px 0' };
    else slots[name] = { file, slice: '12 fill', width: '6px' };
  }
  const colors = { 'tab-ink': '#502704', 'tab-on-ink': '#3A1C02', 'chip-on-ink': '#241000', 'danger-ink': '#6A1030', 'badge-ink': '#6A1030', 'scroll-thumb': '#AE7F48', 'scroll-track': '#896C45', 'danger-on-ink': '#FFF1DC' };
  return { kit: { slots, colors }, files };
}

/* A pack folder as the kit's author ships it: kit.json beside its pictures. */
function packKit(folder: string): { kit: Kit; files: Map<string, Buffer> } {
  const kit = JSON.parse(readFileSync(join(folder, 'kit.json'), 'utf8')) as Kit;
  return { kit, files: new Map(Object.values(kit.slots).map(slot => [slot.file, readFileSync(join(folder, slot.file))])) };
}

const KIT = PACK ? packKit(PACK) : madeKit();

/* Built-in Egypt's look as an archive's ui/look.json holds it. */
const look = (): Record<string, unknown> => {
  const raw = JSON.parse(JSON.stringify(builtinSkin(THEME))) as Record<string, unknown>;
  delete raw.id;
  delete raw.world;
  return raw;
};

const machine: MachineView = { id: 'm1', hostname: 'Company computer', os: 'linux', arch: 'arm64', owner: { id: ME.person.id, name: ME.person.name }, online: true, lastSeenAt: null, plans: [], load: null, lendsTests: false, running: { agents: [], parts: [] } };
const phone: PhoneView = { id: 'ph1', name: 'Android of the company', machineId: machine.id, owner: { id: ME.person.id, name: ME.person.name }, lending: true, online: true, stopping: false, state: 'available', queued: 2, connection: 'ready' };

async function setup(page: Page, language: 'en' | 'ru', width: keyof typeof SIZES, installed: boolean) {
  await page.setViewportSize(SIZES[width]);
  await serveApi(page);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: installed ? THEME : 'cyberpunk' } } }));
  await page.route(`**/api/themes/${THEME}/look`, route => route.fulfill({ json: { id: THEME, version: '1.0.0', base: BASE, look: look(), fonts: [], kit: KIT.kit, world: null } }));
  await page.route(`**${BASE}ui/kit/*`, route => {
    const name = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()!);
    const bytes = KIT.files.get(name);
    return bytes ? route.fulfill({ body: bytes, contentType: name.endsWith('.webp') ? 'image/webp' : 'image/png' }) : route.fulfill({ status: 404, body: '' });
  });
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [machine], builtin: null, priority: false, move: null, canMove: false, copies: null } }));
  await page.route('**/api/phones', route => route.fulfill({ json: { phones: [phone] } }));
  await page.addInitScript(({ language, theme }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', theme); }, { language, theme: installed ? THEME : 'cyberpunk' });
}

/* Waits until the kit is on and every picture of it has come, so a frame is measured and shot as it is seen. */
async function kitDrawn(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-kit', 'on');
  await page.evaluate(async () => {
    const root = document.documentElement;
    const urls = [...root.style].filter(name => /^--kit-[a-z0-9-]+$/.test(name) && !/-(slice|width|outset|repeat|size|bg)$/.test(name) && !name.startsWith('--kit-c-'))
      .map(name => /url\("(.+)"\)/.exec(root.style.getPropertyValue(name))?.[1]).filter((url): url is string => !!url);
    await Promise.all(urls.map(url => { const picture = new Image(); picture.src = url; return picture.decode().catch(() => undefined); }));
    await document.fonts.ready;
  });
}

type Box = [string, number, number, number, number];
const boxes = (page: Page): Promise<Box[]> => page.evaluate(() => [...document.querySelectorAll('body *')].map((element): [string, number, number, number, number] => {
  const box = element.getBoundingClientRect();
  return [element.tagName + (element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).join('.')}` : ''), box.x, box.y, box.width, box.height];
}));

/* Takes every box with the kit, takes the kit's mark away, takes them again on the same frame and puts the mark back. */
async function nothingMoves(page: Page, frame: string) {
  const withKit = await boxes(page);
  await page.evaluate(() => { document.documentElement.dataset.kitOff = document.documentElement.dataset.kit ?? ''; delete document.documentElement.dataset.kit; });
  const without = await boxes(page);
  await page.evaluate(() => { document.documentElement.dataset.kit = document.documentElement.dataset.kitOff || 'on'; delete document.documentElement.dataset.kitOff; });
  expect(without.length, `${frame}: the same elements`).toBe(withKit.length);
  const moved = withKit.filter((box, i) => box.slice(1).some((value, k) => Math.abs((value as number) - (without[i]![k + 1] as number)) > 0.5));
  expect(moved.map(box => box[0]), `${frame}: no box moves or resizes with the kit`).toEqual([]);
  expect(withKit.length, `${frame}: it has boxes`).toBeGreaterThan(20);
}

/* No sideways scroll on the page or on any panel. */
async function noSidewaysScroll(page: Page, frame: string) {
  const wide = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll<HTMLElement>('.acard, .ac-body, .dv-drawer, .dv-drawer-b, .tr-side, .orch, .dialog')]
    .filter(element => element.scrollWidth > element.clientWidth + 1).map(element => `${element.tagName}.${element.className}`));
  expect(wide, `${frame}: no sideways scroll`).toEqual([]);
}

/* A side panel's scrollbar stands the frame room in from the panel's edge: for a panel whose body scrolls, the body ends
   that far from the panel's inner edge; for one that scrolls itself, its end border is that wide. */
async function barKeepsFrameRoom(page: Page, panel: string, body: string | null) {
  const { room, gap } = await page.locator(panel).first().evaluate((element, body) => {
    const style = getComputedStyle(element);
    const room = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame-room'));
    const rtl = style.direction === 'rtl';
    if (!body) return { room: Math.min(room, 8), gap: parseFloat(rtl ? style.borderLeftWidth : style.borderRightWidth) - 1 };
    const inner = element.querySelector(body)!.getBoundingClientRect();
    const outer = element.getBoundingClientRect();
    return { room, gap: rtl ? inner.left - outer.left - parseFloat(style.borderLeftWidth) : outer.right - parseFloat(style.borderRightWidth) - inner.right };
  }, body);
  expect(room, 'the frame room is a token of its own').toBeGreaterThan(0);
  expect(Math.abs(gap - room), `${panel}: the bar keeps the frame room from the edge`).toBeLessThanOrEqual(0.5);
}

/* Every element a frame rule of the kit names, and that is on screen, draws that frame: no screen rule of its own (a border
   shorthand resets border-image) takes it away, so a face painted whole never leaves its element see-through. */
async function framesDrawn(page: Page, frame: string) {
  const lost = await page.evaluate(() => {
    const root = document.documentElement;
    const out: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const rule of [...rules]) {
        if (!(rule instanceof CSSStyleRule)) {
          if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
          continue;
        }
        const slot = /var\(--kit-([a-z0-9-]+)\)/.exec(rule.selectorText.includes('[data-kit') ? rule.style.getPropertyValue('border-image') || rule.style.getPropertyValue('border-image-source') : '')?.[1];
        if (!slot || !root.style.getPropertyValue(`--kit-${slot}`)) continue;
        for (const element of document.querySelectorAll(rule.selectorText)) {
          const box = element.getBoundingClientRect();
          if (box.width && box.height && getComputedStyle(element).borderImageSource === 'none') out.push(`${slot}: ${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`);
        }
      }
    };
    for (const sheet of [...document.styleSheets]) walk(sheet.cssRules);
    return [...new Set(out)];
  });
  expect(lost, `${frame}: every kit frame is drawn`).toEqual([]);
}

/* What a panel's words take: their boxes stay put whether the frame room is there or not, in any theme. */
async function wordsStayPut(page: Page, scroller: string) {
  const take = () => page.locator(scroller).first().evaluate(element => [...element.querySelectorAll('*')].map(child => {
    const box = child.getBoundingClientRect();
    return [Math.round(box.x * 2) / 2, Math.round(box.width * 2) / 2];
  }));
  const kept = await take();
  await page.evaluate(() => document.documentElement.style.setProperty('--frame-room', '0px'));
  const none = await take();
  await page.evaluate(() => document.documentElement.style.removeProperty('--frame-room'));
  expect(none, `${scroller}: its words stand where they stand without the room`).toEqual(kept);
}

for (const language of ['en', 'ru'] as const) {
  for (const width of [1440, 375] as const) {
    const t = MESSAGES[language];
    test.describe(`a painted kit, ${language}, ${width}`, () => {
      test(`moves no box on the tasks, a task card and the department panel, ${language} ${width}`, async ({ page }, info: TestInfo) => {
        await setup(page, language, width, true);
        await page.goto('/tasks');
        await kitDrawn(page);
        await expect(page.locator('.tr-views label').first()).toBeVisible();
        await nothingMoves(page, 'tasks');
        await noSidewaysScroll(page, 'tasks');
        await framesDrawn(page, 'tasks');
        if (width === 1440) {
          await barKeepsFrameRoom(page, '.tr-side', null);
          await wordsStayPut(page, '.tr-side');
        }
        if (process.env.HH_SCREENSHOT_DIR) await capture(page, info, `tasks-${language}-${width}`);

        await openTaskCard(page, 3);
        await expect(page.locator('.acard .ac-body')).toBeVisible();
        await kitDrawn(page);
        await nothingMoves(page, 'task card');
        await noSidewaysScroll(page, 'task card');
        await framesDrawn(page, 'task card');
        await barKeepsFrameRoom(page, '.acard', '.ac-body');
        await wordsStayPut(page, '.ac-body');
        if (process.env.HH_SCREENSHOT_DIR) await capture(page, info, `task-card-${language}-${width}`);

        await page.goto('/departments/d2');
        await page.getByRole('button', { name: t.dept.about, exact: true }).click();
        await expect(page.locator('.dv-drawer .dv-drawer-b')).toBeVisible();
        await kitDrawn(page);
        await nothingMoves(page, 'department panel');
        await noSidewaysScroll(page, 'department panel');
        await framesDrawn(page, 'department panel');
        await barKeepsFrameRoom(page, '.dv-drawer', '.dv-drawer-b');
        await wordsStayPut(page, '.dv-drawer-b');
        if (process.env.HH_SCREENSHOT_DIR) await capture(page, info, `department-panel-${language}-${width}`);
      });

      test(`keeps a field in error marked in pink once focus leaves it, and its focus ring while it has focus, ${language} ${width}`, async ({ page }) => {
        await setup(page, language, width, true);
        await page.goto('/about');
        const about = page.getByRole('dialog', { name: t.about.title, exact: true });
        await expect(about).toBeVisible();
        await kitDrawn(page);
        const part = about.getByRole('region', { name: t.feedback.section, exact: true });
        await part.getByRole('button', { name: t.feedback.write, exact: true }).click();
        const text = part.getByLabel(t.feedback.text, { exact: true });
        await text.fill(language === 'en' ? 'The terminal stopped answering after the update.' : 'После обновления окно терминала перестало отвечать.');
        await part.getByRole('button', { name: t.common.next, exact: true }).click();
        await expect(part.getByText(t.feedback.titleRequired, { exact: true })).toBeVisible();
        const title = part.getByLabel(t.feedback.titleLabel, { exact: true });
        await expect(title).toHaveAttribute('aria-invalid', 'true');
        const colour = (name: string) => page.evaluate(token => { const probe = document.createElement('i'); probe.style.color = `var(${token})`; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }, name);
        const line = () => title.evaluate(field => { const style = getComputedStyle(field); return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor }; });
        await text.focus();
        expect(await line(), 'a field in error without focus keeps a pink line').toEqual({ style: 'solid', width: 2, color: await colour('--pink') });
        await title.focus();
        expect(await line(), 'with focus it shows the focus ring').toEqual({ style: 'solid', width: 2, color: await colour('--cyan-ink') });
      });

      test(`tells a danger action by its verb and its last place, on its own plate and light label, ${language} ${width}`, async ({ page }, info: TestInfo) => {
        await setup(page, language, width, true);
        await page.goto('/machines');
        await expect(page.getByRole('heading', { name: t.phones.heading })).toBeVisible();
        await kitDrawn(page);
        const stop = page.getByRole('button', { name: t.phones.stop, exact: true });
        await expect(stop).toHaveClass(/\bbtn\b.*\bdanger\b|\bdanger\b.*\bbtn\b/);
        expect(await stop.evaluate(button => [...button.parentElement!.querySelectorAll(':scope > button')].at(-1) === button), 'the danger action ends its row').toBe(true);
        const drawn = await stop.evaluate(button => {
          const style = getComputedStyle(button);
          const root = document.documentElement.style;
          const plate = /url\("(.+)"\)/.exec(root.getPropertyValue('--kit-danger'))?.[1];
          return { source: style.borderImageSource, color: style.color, plate: plate ? `url("${new URL(plate, location.href).href}")` : 'none', ink: root.getPropertyValue('--kit-c-danger-on-ink') };
        });
        expect(drawn.source, 'the danger plate, not the primary one').toBe(drawn.plate);
        const expected = await page.evaluate(ink => { const probe = document.createElement('i'); probe.style.color = ink; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }, drawn.ink || 'var(--on-btn)');
        expect(drawn.color, 'the light label made for the plate').toBe(expected);
        await nothingMoves(page, 'machines');
        await noSidewaysScroll(page, 'machines');
        await framesDrawn(page, 'machines');
        if (process.env.HH_SCREENSHOT_DIR) await capture(page, info, `machines-${language}-${width}`);
      });
    });
  }
}

test('a theme without a kit leaves no trace of one, and no box moves between the two', async ({ page }) => {
  await setup(page, 'en', 1440, true);
  await page.goto('/tasks');
  await kitDrawn(page);
  const withKit = await boxes(page);
  await page.evaluate(() => { localStorage.setItem('hh-theme', 'cyberpunk'); });
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: 'cyberpunk' } } }));
  await page.reload();
  await expect(page.locator('.tr-views label').first()).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-kit');
  expect(await page.evaluate(() => [...document.documentElement.style].filter(name => name.startsWith('--kit-')))).toEqual([]);
  expect((await boxes(page)).length).toBeGreaterThan(withKit.length / 2);
});
