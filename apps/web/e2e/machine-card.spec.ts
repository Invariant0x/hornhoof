/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { BuiltinView, ConnectionHistory, DataView, MachineView, Org, ShownCommand, SubView } from '../src/types';
import { ME, serveApi, serveOwnerKey } from './api';
import { offences, sizes } from './owner-screens-look';
import type { Measured } from './owner-screens-sizes';

/* The lower part of a machine's open card (#1027), drawn by each engine: under the top, which stays as it was, a block of
   its own for the server and the data copy, one for the system, the programs and the access, one for the owner's
   settings and actions, then the connection to the server, with its drops in lines and their technical details behind a
   button. The owner's buttons stand in one group under the settings, the main one first and Disconnect last, every row
   of them on the end edge (#1036); the command that brings the core has Copy in a group under it, on the end edge, from
   44 px. Each look keeps to Design's rules, lets no word out of its card, lays the blocks out without overlap, and leaves
   the sizes of its pieces for a comparison between the engines afterwards. A picture of each card is kept, in the folder
   SHOTS names when it is set. */

test.describe.configure({ timeout: 180_000 });

const SHOTS = process.env.SHOTS;
const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const messages = { en, ru };

const SERVER = 'rack-01';
const BACKUP = 'dev-studio';
const NODE = 'build-node-with-a-rather-long-name-of-its-own';

const placed = (over: Partial<DataView>): DataView => ({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, ...over });
const machine = (id: string, hostname: string, over: Partial<MachineView>): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] }, programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }],
  keepsBackups: false, heldBackups: 0, ...over,
} as MachineView);
const openAccess = (id: string, hostname: string) => ({
  machine: { id, networkId: `n-${hostname}`, name: hostname, hostname, personId: 'p1', role: 'worker', os: 'linux', data: true },
  reachable: true, open: true, scope: 'orchestrator', employees: [], canOpen: true, canClose: true,
});

/* A plan of the CEO's on the server's machine, so the other two offer Add my plan. */
const PLAN = { id: 's1', provider: 'claude', status: 'ready', online: true } as MachineView['plans'][number];
const SUBS = [{
  id: 's1', provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready', online: true, last4: null, owner: { id: 'p1', name: 'Ivan' },
  place: { kind: 'company', id: null, name: 'Whole company' }, machines: [{ id: 'm1', hostname: SERVER, status: 'ready', online: true }], limits: null,
  limitsUpdatedAt: null, budget: null, isOrchestrator: false, accounts: [], tier: 'Max', accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [],
}] as unknown as SubView[];
/* The command the server gives for the core of the node: it joins the machine, so it shows with the owner's key. */
const CORE = 'curl -fsSL https://hq.acme.com/install.sh | bash -s -- --join DEMO_ONLY_CORE_JOIN_TOKEN_OF_A_LONG_KIND';
const CORE_SHOWN: ShownCommand = { id: 'c1', kind: 'core', plans: [], machineId: 'm3', machine: NODE, command: CORE, expiresAt: new Date(NOW + 3_600_000).toISOString() };

/* The machine the server runs on, the next in line with an up-to-date copy and its access open, and a node that joined
   before machines had a core. */
const MACHINES: MachineView[] = [
  machine('m1', SERVER, { data: placed({ number: 1, why: 'server' }), keepsBackups: true, heldBackups: 0, plans: [PLAN] }),
  machine('m2', BACKUP, { os: 'darwin', arch: 'arm64', data: placed({ number: 2, why: 'always.best_link', copy: { line: 'ready' } }), keepsBackups: true, heldBackups: 3, access: openAccess('m2', BACKUP) as MachineView['access'] }),
  machine('m3', NODE, { data: placed({}), needsCore: true, keepsBackups: null, heldBackups: null }),
];
const BUILTIN: BuiltinView = { online: true, load: null, running: { agents: [], parts: [] }, machine: { id: 'm1', hostname: SERVER } };

const drop = (at: string, back: string | null, offlineMs: number | null, over: object = {}) => ({
  nodeId: 'n1', subscriptionId: 'plan-1', at, back, offlineMs, cause: 'network', closeCode: 1006, closeReason: null, error: null, report: null, ...over,
});
const said = {
  disconnectedAt: ago(40), reconnectedAt: ago(39), offlineMs: 60_000, attempts: 4, cause: 'dns_error', closeCode: null, closeReason: null,
  errorCode: 'ENOTFOUND', error: 'getaddrinfo ENOTFOUND hornhoof.example', dnsFailed: true, watchdogTimedOut: false, clockJumpMs: 95_000, networkChanged: true,
};
/* The server's machine holds steady; the copy had four drops today; the node had one, days ago. */
const HISTORY: Record<string, ConnectionHistory> = {
  m1: { summary: { drops: 0, averageMs: null, cause: null }, events: [] },
  m2: {
    summary: { drops: 4, averageMs: 35_000, cause: 'network' },
    events: [
      { at: ago(40), back: ago(39), offlineMs: 60_000, cause: 'dns_error', drops: [drop(ago(40), ago(39), 60_000, { cause: 'replaced', closeCode: 4000, closeReason: 'Replaced by a newer connection.', report: said })] },
      { at: ago(180), back: ago(179.5), offlineMs: 30_000, cause: 'network', drops: [drop(ago(180), ago(179.5), 30_000)] },
      { at: ago(300), back: ago(299.9), offlineMs: 6000, cause: 'server_stopped', drops: [drop(ago(300), ago(299.9), 6000, { cause: 'server_stopped', closeCode: 1001 })] },
      { at: ago(600), back: ago(599.3), offlineMs: 42_000, cause: 'socket_error', drops: [drop(ago(600), ago(599.3), 42_000, { cause: 'socket_error', closeCode: 1002, error: `Invalid WebSocket frame: ${'a very long word '.repeat(4).replaceAll(' ', '_')}` })] },
    ],
  } as unknown as ConnectionHistory,
  m3: { summary: { drops: 0, averageMs: null, cause: null }, events: [{ at: ago(4000), back: ago(3999), offlineMs: 60_000, cause: 'node_closed', drops: [drop(ago(4000), ago(3999), 60_000, { cause: 'node_closed', closeCode: 1000, closeReason: 'Going away for an update.' })] }] } as unknown as ConnectionHistory,
};

type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; skin: 'cyberpunk' | 'light'; width: 1440 | 375 };
const LOOKS: Look[] = (['cyberpunk', 'light'] as const).flatMap(skin => ([1440, 375] as const).flatMap(width => [
  { lang: 'en' as const, dir: 'ltr' as const, skin, width }, { lang: 'ru' as const, dir: 'ltr' as const, skin, width },
  { lang: 'en' as const, dir: 'rtl' as const, skin, width }, { lang: 'ru' as const, dir: 'rtl' as const, skin, width },
]));
const lookName = ({ lang, dir, skin, width }: Look) => `${lang}-${dir}-${skin}-${width}`;

async function openMachines(page: Page, look: Look): Promise<void> {
  await page.setViewportSize({ width: look.width, height: look.width === 375 ? 2600 : 1400 });
  await page.clock.install({ time: NOW });
  await serveApi(page);
  await serveOwnerKey(page);
  await page.addInitScript(({ lang, skin, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, look);
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: MACHINES, builtin: BUILTIN, priority: true, move: null, canMove: true, copies: { leader: SERVER, copies: [{ hostname: BACKUP, sync: true }], onlySince: null } } }));
  await page.route('**/api/machines/*/connections', route => route.fulfill({ json: HISTORY[new URL(route.request().url()).pathname.split('/')[3]!] }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: SUBS } }));
  /* Once made, the core's command is among the shown ones the screen reloads, as the server keeps it. */
  let made = false;
  await page.route('**/api/machines/m3/core', route => { made = true; return route.fulfill({ json: CORE_SHOWN }); });
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: made ? [CORE_SHOWN] : [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: messages[look.lang].shell.tabs.machines, exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
}

/* What of the card lies outside it or is cut: a piece wider than the card's box, a line whose words run past its own
   box, or a word cut short with an ellipsis. */
async function spills(card: Locator): Promise<string[]> {
  return card.evaluate(root => {
    const out: string[] = [];
    const frame = root.getBoundingClientRect();
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${el.className} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    for (const el of root.querySelectorAll('*')) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || el.closest('svg')) continue;
      if (box.left < frame.left - 1 || box.right > frame.right + 1) out.push(`outside: ${name(el)} ${Math.round(box.left)}..${Math.round(box.right)} of ${Math.round(frame.left)}..${Math.round(frame.right)}`);
      const css = getComputedStyle(el);
      if (css.textOverflow === 'ellipsis') out.push(`ellipsis: ${name(el)}`);
      if (css.display !== 'inline' && el.scrollWidth > el.clientWidth + 1 && css.overflowX !== 'visible') out.push(`cut: ${name(el)} ${el.scrollWidth} > ${el.clientWidth}`);
    }
    return out;
  });
}

/* Pieces that lie over one another: the card's own blocks, and the blocks at its bottom. */
async function overlaps(card: Locator): Promise<string[]> {
  return card.evaluate(root => {
    const out: string[] = [];
    const groups = [[...root.querySelectorAll(':scope .blocks > *')], [...root.querySelectorAll(':scope .mc-blocks > *')]];
    for (const group of groups) group.forEach((a, i) => group.slice(i + 1).forEach(b => {
      const [p, q] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
      const x = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      const y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (x > 1 && y > 1) out.push(`${a.className} over ${b.className}`);
    }));
    return out;
  });
}

/* The code of a command reads left to right from its left edge on any page, and no flag of it, like --owner-key, breaks
   across lines (#1038). */
async function codeOffences(code: Locator): Promise<string[]> {
  return code.evaluate(el => {
    const out: string[] = [];
    const css = getComputedStyle(el);
    if (css.direction !== 'ltr') out.push(`direction ${css.direction}`);
    if (css.textAlign !== 'left') out.push(`text-align ${css.textAlign}`);
    /* Each line starts at the code's left edge. */
    const all = document.createRange();
    all.selectNodeContents(el);
    const lines = new Map<number, number>();
    for (const box of all.getClientRects()) lines.set(Math.round(box.bottom), Math.min(lines.get(Math.round(box.bottom)) ?? Infinity, box.left));
    const edge = el.getBoundingClientRect().left;
    for (const [bottom, left] of lines) if (Math.abs(left - edge) > 1) out.push(`the line ending at ${bottom} starts ${Math.round(left - edge)}px from the left edge`);
    for (const flag of el.querySelectorAll('.flag')) if (flag.getClientRects().length !== 1) out.push(`${flag.textContent} breaks across ${flag.getClientRects().length} lines`);
    return out;
  });
}

/* A group of buttons that wraps goes on from the same edge: each of its rows ends on the group's end edge. */
async function rowsOffEdge(group: Locator): Promise<string[]> {
  return group.evaluate(el => {
    const rtl = getComputedStyle(el).direction === 'rtl';
    const edge = el.getBoundingClientRect();
    const rows = new Map<number, DOMRect[]>();
    for (const button of el.children) {
      const box = button.getBoundingClientRect();
      rows.set(Math.round(box.top), [...(rows.get(Math.round(box.top)) ?? []), box]);
    }
    return [...rows].flatMap(([top, boxes]) => {
      const short = rtl ? Math.min(...boxes.map(b => b.left)) - edge.left : edge.right - Math.max(...boxes.map(b => b.right));
      return Math.abs(short) > 1 ? [`row at ${top} ends ${Math.round(short)}px before the end`] : [];
    });
  });
}

const columns = (card: Locator) => card.locator('.mc-blocks > .mc-blk').evaluateAll(all => new Set(all.map(el => Math.round(el.getBoundingClientRect().left))).size);

function shotPath(info: TestInfo, file: string): string {
  if (!SHOTS) return info.outputPath(file);
  mkdirSync(SHOTS, { recursive: true });
  return `${SHOTS}/${file}`;
}

async function shoot(page: Page, card: Locator, info: TestInfo, file: string): Promise<void> {
  const tall = await card.evaluate(el => Math.ceil(el.getBoundingClientRect().bottom + scrollY + 24));
  const size = page.viewportSize()!;
  if (tall > size.height) await page.setViewportSize({ width: size.width, height: Math.min(6000, tall) });
  await card.screenshot({ path: shotPath(info, file) });
  await page.setViewportSize(size);
}

/* The sizes of what this card's lower part is made of: the part as a whole, from its blocks to the end of the
   connection, its blocks and their pieces, and the connection's lines. The top of the card is not this task's: it is
   left out, as it was before. */
async function lowerSizes(card: Locator): Promise<Record<string, number>> {
  const named = (prefix: string, all: Record<string, number>) => Object.fromEntries(Object.entries(all).map(([key, value]) => [`${prefix} ${key}`, value]));
  const blocks = await sizes(card.locator('.mc-blocks'), { block: ':scope > .mc-blk', action: '.entry-actions > .act', choice: '.pm-opt', setting: '.lend', facts: '.facts' });
  const link = await sizes(card.locator('.blk-link'), { summary: '.mc-sum', drop: '.mc-drops > li' });
  const lower = await card.evaluate(el => Math.round(el.querySelector('.blk-link')!.getBoundingClientRect().bottom - el.querySelector('.mc-blocks')!.getBoundingClientRect().top));
  return { 'lower part height': lower, ...named('blocks', blocks), ...named('link', link) };
}

for (const look of LOOKS) {
  test(`the lower part of a machine's card, ${lookName(look)}`, async ({ page, browserName }, info) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    const t = messages[look.lang];
    const c = t.cards;
    await openMachines(page, look);
    const measured: Measured[] = [];
    for (const host of [SERVER, BACKUP, NODE]) {
      await page.getByRole('button', { name: `${look.lang === 'en' ? 'Open the card of' : 'Открыть карточку'} ${host}`, exact: true }).click();
      const card = page.getByRole('article', { name: host });
      const link = card.getByRole('region', { name: t.machines.connection.heading });
      await expect(link.locator('.mc-sum')).toBeVisible();
      if (look.dir === 'rtl') expect(await card.evaluate(el => getComputedStyle(el).direction)).toBe('rtl');

      /* The top stays as it was: the resources under About the machine, the plans alone on the right. */
      await expect(card.locator('.blk-facts > h4, .blk-facts h5')).toHaveText([c.aboutMachine, c.resources]);
      await expect(card.locator('.blk-side').getByRole('heading')).toHaveText([c.plansOn]);
      /* Then the blocks, each with its heading; a machine with no part in the server has no block for it. */
      const lower = host === NODE ? [c.systemBlock, c.ownerBlock] : [c.serverBlock, c.systemBlock, c.ownerBlock];
      await expect(card.locator('.mc-blocks > .mc-blk > h4')).toHaveText(lower);
      await expect(card.locator('.mc-blk .machine-note')).toHaveCount(0);

      const owner = card.getByRole('region', { name: c.ownerBlock });
      const actions = owner.locator('.entry-actions');
      const offered = { [SERVER]: [t.machines.disconnect], [BACKUP]: [t.machines.addPlan, t.machines.disconnect], [NODE]: [t.machines.addPlan, t.machines.makeCore(host), t.machines.disconnect] }[host]!;
      await expect(actions.getByRole('button')).toHaveText(offered);
      expect(await actions.evaluate(group => group.previousElementSibling?.matches('dl.facts'))).toBe(true);
      expect(await rowsOffEdge(actions)).toEqual([]);
      if (host === BACKUP) {
        const server = card.getByRole('region', { name: c.serverBlock });
        await expect(server.getByRole('radiogroup', { name: c.priority })).toBeVisible();
        await expect(server.getByText(t.machines.copy.ready, { exact: true })).toBeVisible();
        await expect(card.getByRole('region', { name: c.systemBlock }).getByRole('button', { name: t.window.computerClose, exact: true })).toBeVisible();
        await expect(link.locator('.mc-sum .status')).toHaveText(t.machines.connection.health.drops);
        await expect(link.locator('.mc-drops > li')).toHaveCount(4);
        await expect(link.locator('.mc-tech')).toHaveCount(0);
      } else {
        await expect(link.locator('.mc-sum .status')).toHaveText(t.machines.connection.health.stable);
      }

      expect.soft(await offences(card, { danger: [t.machines.disconnect], groups: '.mc-blk .entry-actions, .blk-link .entry-actions' })).toEqual([]);
      expect.soft(await spills(card)).toEqual([]);
      expect.soft(await overlaps(card)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await columns(card)).toBe(look.width === 375 ? 1 : lower.length);
      measured.push({ browser: browserName, look: lookName(look), screen: host === NODE ? 'node' : host, sizes: await lowerSizes(card) });
      await shoot(page, card, info, `card-${host === NODE ? 'node' : host}-${lookName(look)}-${browserName}.png`);

      if (host === NODE) {
        /* The core's command: Copy under each line of it, and Cancel under it all, each on the end edge, a button of
           44 px. */
        await owner.getByRole('button', { name: t.machines.makeCore(host), exact: true }).click();
        const shown = card.locator('.add-plan');
        await expect(shown.locator('code').first()).toContainText('--owner-key');
        await expect(shown.locator('.flag').filter({ hasText: /^--owner-key$/ })).toHaveCount(2);
        for (const line of await shown.locator('.command').all()) {
          const [code, group] = [line.locator('code'), line.locator('.entry-actions')];
          await expect(group.getByRole('button')).toHaveText([t.common.copy]);
          expect(await codeOffences(code)).toEqual([]);
          const [codeBox, groupBox] = [(await code.boundingBox())!, (await group.boundingBox())!];
          expect(groupBox.y).toBeGreaterThanOrEqual(codeBox.y + codeBox.height);
          expect(await rowsOffEdge(group)).toEqual([]);
          expect.soft(await offences(line, { danger: [], groups: '.entry-actions' })).toEqual([]);
        }
        const cancel = shown.locator(':scope > .entry-actions');
        await expect(cancel.getByRole('button')).toHaveText([t.subs.cancelCommand]);
        expect(await rowsOffEdge(cancel)).toEqual([]);
        expect.soft(await offences(shown, { danger: [], groups: ':scope > .entry-actions' })).toEqual([]);
        expect.soft(await spills(card)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        measured.push({ browser: browserName, look: lookName(look), screen: 'core command', sizes: await sizes(shown, { command: '.command', code: '.command code', copy: '.command .entry-actions > .btn', cancel: ':scope > .entry-actions > .btn' }) });
        await shoot(page, shown, info, `command-node-${lookName(look)}-${browserName}.png`);
      }

      if (host === BACKUP) {
        /* The technical details of the drops, when asked for, under each line. */
        const details = link.getByRole('button', { name: t.machines.connection.showDetails, exact: true });
        await details.click();
        await expect(link.getByRole('button', { name: t.machines.connection.hideDetails, exact: true })).toHaveAttribute('aria-expanded', 'true');
        await expect(link.locator('.mc-tech')).toHaveCount(4);
        expect.soft(await spills(card)).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        measured.push({ browser: browserName, look: lookName(look), screen: 'details', sizes: await sizes(link, { summary: '.mc-sum', drop: '.mc-drops > li', tech: '.mc-tech' }) });
        await shoot(page, link, info, `drops-details-${lookName(look)}-${browserName}.png`);
      }
    }
    writeFileSync(info.outputPath('sizes.json'), JSON.stringify(measured));
    expect(errors).toEqual([]);
  });
}
