/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { BuiltinView, ConnectionHistory, DataView, MachineView, Org, SubView } from '../src/types';
import { ME, brokenHeaderWords, serveApi, tableFits } from './api';
import { offences } from './owner-screens-look';

/* One computer with both a node role (plans, agents, lent tests, working folders) and a server-install / replica role
   (priority, database copy, backups, computer access) renders once under Machines, while two distinct computers that
   happen to share the same display name remain two rows (#2023). */

test.describe.configure({ timeout: 0 });

const SHOTS = process.env.SHOTS;
const GIB = 1024 ** 3;
const messages = { en, ru };

type Look = { language: 'en' | 'ru'; skin: 'light' | 'cyberpunk'; width: 1440 | 375; height: number; dir?: 'rtl' };

const LOOKS: Look[] = [
  { language: 'en', skin: 'light', width: 1440, height: 1400 },
  { language: 'en', skin: 'light', width: 375, height: 2600 },
  { language: 'ru', skin: 'light', width: 1440, height: 1400 },
  { language: 'ru', skin: 'light', width: 375, height: 2600 },
  { language: 'en', skin: 'cyberpunk', width: 1440, height: 1400 },
  { language: 'en', skin: 'cyberpunk', width: 375, height: 2600 },
  { language: 'ru', skin: 'cyberpunk', width: 1440, height: 1400 },
  { language: 'ru', skin: 'cyberpunk', width: 375, height: 2600 },
  { language: 'en', skin: 'light', width: 1440, height: 1400, dir: 'rtl' },
  { language: 'en', skin: 'light', width: 375, height: 2600, dir: 'rtl' },
];

const lookName = (look: Look) => `${look.language}-${look.skin === 'cyberpunk' ? 'dark' : 'light'}${look.dir ? '-rtl' : ''}-${look.width}px`;

const placed = (over: Partial<DataView>): DataView => ({
  number: null,
  why: null,
  pin: null,
  unfit: null,
  copy: null,
  leftAt: null,
  led: null,
  ...over,
});

const SUBS = [
  {
    id: 'sub-claude',
    provider: 'claude',
    kind: 'personal',
    label: 'Claude',
    status: 'ready',
    online: true,
    last4: null,
    owner: { id: 'p1', name: 'Ivan' },
    place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [
      { id: 'm-leader', hostname: 'rack-02', status: 'ready', online: true },
      { id: 'm-former', hostname: 'rack-01', status: 'ready', online: true },
    ],
    limits: null,
    limitsUpdatedAt: null,
    budget: null,
    isOrchestrator: false,
    accounts: [],
    tier: 'Max',
    accountsDiffer: false,
    signedInOnce: true,
    leaseMachine: null,
    agents: [],
  },
  {
    id: 'sub-codex',
    provider: 'codex',
    kind: 'personal',
    label: 'Codex',
    status: 'ready',
    online: true,
    last4: null,
    owner: { id: 'p1', name: 'Ivan' },
    place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [
      { id: 'm-former', hostname: 'rack-01', status: 'ready', online: true },
      { id: 'm-same-b', hostname: 'shared-box', status: 'ready', online: true },
    ],
    limits: null,
    limitsUpdatedAt: null,
    budget: null,
    isOrchestrator: false,
    accounts: [],
    tier: 'Pro',
    accountsDiffer: false,
    signedInOnce: true,
    leaseMachine: null,
    agents: [],
  },
] as unknown as SubView[];

const MACHINES: MachineView[] = [
  {
    id: 'm-leader',
    hostname: 'rack-02',
    os: 'linux',
    arch: 'x86_64',
    owner: { id: 'p1', name: 'Ivan' },
    serverInstall: false,
    online: true,
    lastSeenAt: null,
    plans: [{ id: 'sub-claude', provider: 'claude', status: 'ready', online: true }],
    load: {
      cpus: 16,
      load: 2.4,
      memFree: 44 * GIB,
      memTotal: 64 * GIB,
      jobs: 1,
      tests: 0,
      cpuModel: 'AMD EPYC',
      diskFree: 360 * GIB,
      diskTotal: 512 * GIB,
    },
    lendsTests: true,
    core: { webPort: 8080, path: 'direct' },
    needsCore: false,
    keepsBackups: true,
    heldBackups: 3,
    data: placed({ number: 1, why: 'server' }),
    programs: [{ id: 'claude', version: '2.1.0', updating: false, failed: false }],
    running: {
      agents: [
        {
          id: 'a-1',
          canOpen: true,
          name: 'Builder',
          busy: true,
          title: null,
          department: { id: 'd-1', name: 'Development' },
          provider: 'claude',
          since: '2026-11-24T01:12:00.000Z',
          task: { number: 2023, title: 'Unified machine row' },
          withCeo: false,
        },
      ],
      parts: [],
    },
  } as MachineView,
  {
    id: 'm-former',
    hostname: 'rack-01',
    os: 'linux',
    arch: 'x86_64',
    owner: { id: 'p1', name: 'Ivan' },
    serverInstall: false,
    online: true,
    lastSeenAt: null,
    plans: [
      { id: 'sub-claude', provider: 'claude', status: 'ready', online: true },
      { id: 'sub-codex', provider: 'codex', status: 'ready', online: true },
    ],
    load: {
      cpus: 12,
      load: 3.0,
      memFree: 20 * GIB,
      memTotal: 32 * GIB,
      jobs: 2,
      tests: 1,
      cpuModel: 'AMD Ryzen',
      diskFree: 140 * GIB,
      diskTotal: 256 * GIB,
      disk: {
        free: 140 * GIB,
        total: 256 * GIB,
        threshold: 10 * GIB,
        low: null,
        parts: { images: 6 * GIB, workingCopies: 5 * GIB },
        cleaned: [],
      },
    },
    replicas: { count: 1, bytes: 2 * GIB, companies: [{ name: 'Acme', bytes: 2 * GIB }] },
    folders: [
      { plan: 'sub-claude', bytes: 3 * GIB },
      { plan: null, bytes: 2 * GIB },
    ],
    lendsTests: true,
    core: { webPort: 8080, path: 'direct' },
    needsCore: false,
    keepsBackups: true,
    heldBackups: 2,
    access: {
      machine: { id: 'm-former', networkId: 'n-former', name: 'rack-01', hostname: 'rack-01', personId: 'p1', role: 'data', os: 'linux', data: true },
      reachable: true,
      open: true,
      scope: 'orchestrator',
      employees: [],
      canOpen: true,
      canClose: true,
    } as MachineView['access'],
    data: placed({
      number: 2,
      why: 'always.best_link',
      copy: { line: 'ready' },
      led: { until: '2026-11-24T01:08:00.000Z' },
    }),
    programs: [
      { id: 'claude', version: '2.1.0', updating: false, failed: false },
      { id: 'codex', version: '0.42.0', updating: false, failed: false },
    ],
    running: {
      agents: [
        {
          id: 'a-2',
          canOpen: true,
          name: 'Reviewer',
          busy: true,
          title: null,
          department: { id: 'd-1', name: 'Development' },
          provider: 'claude',
          since: '2026-11-24T01:11:00.000Z',
          task: { number: 2023, title: 'Unified machine row' },
          withCeo: false,
        },
      ],
      parts: [{ run: 14, kind: 'tests', task: 2023, part: 1, parts: 1, agent: 'Builder', startedAt: '2026-11-24T01:10:00.000Z' }],
    },
  } as MachineView,
  {
    id: 'm-same-a',
    hostname: 'shared-box',
    os: 'darwin',
    arch: 'arm64',
    owner: { id: 'p1', name: 'Ivan' },
    serverInstall: false,
    online: true,
    lastSeenAt: null,
    plans: [{ id: 'sub-claude', provider: 'claude', status: 'ready', online: true }],
    load: { cpus: 8, load: 0.5, memFree: 12 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'Apple M3', diskFree: 90 * GIB, diskTotal: 256 * GIB },
    lendsTests: true,
    core: null,
    needsCore: true,
    keepsBackups: null,
    heldBackups: null,
    data: placed({ unfit: { why: 'no_core' } }),
    running: { agents: [], parts: [] },
  } as MachineView,
  {
    id: 'm-same-b',
    hostname: 'shared-box',
    os: 'linux',
    arch: 'x86_64',
    owner: { id: 'p1', name: 'Ivan' },
    serverInstall: false,
    online: true,
    lastSeenAt: null,
    plans: [{ id: 'sub-codex', provider: 'codex', status: 'ready', online: true }],
    load: { cpus: 8, load: 1.0, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'Intel Core', diskFree: 80 * GIB, diskTotal: 256 * GIB },
    lendsTests: false,
    core: null,
    needsCore: true,
    keepsBackups: null,
    heldBackups: null,
    data: placed({ unfit: { why: 'no_core' } }),
    running: { agents: [], parts: [] },
  } as MachineView,
];

const BUILTIN: BuiltinView = {
  online: true,
  load: { cpus: 16, load: 2.4, memFree: 44 * GIB, memTotal: 64 * GIB, jobs: 1, tests: 0 },
  running: { agents: [], parts: [] },
  machine: { id: 'm-leader', hostname: 'rack-02' },
  webPort: 8080,
  refusedBy: [],
};

const STABLE: ConnectionHistory = { summary: { drops: 0, averageMs: null, cause: null }, events: [] };

async function saveShot(page: Page, info: TestInfo, name: string): Promise<void> {
  const tall = await page.evaluate(() => {
    const main = document.querySelector('main');
    return Math.ceil(Math.max(document.documentElement.scrollHeight, (main?.getBoundingClientRect().top ?? 0) + (main?.scrollHeight ?? 0) + 32));
  });
  const size = page.viewportSize()!;
  if (tall > size.height) await page.setViewportSize({ width: size.width, height: Math.min(6000, tall) });
  const out = info.outputPath(name);
  await page.screenshot({ path: out, fullPage: true });
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, name), fullPage: true });
  }
  if (tall > size.height) await page.setViewportSize(size);
}

for (const look of LOOKS) {
  test(`shows one unified row with both roles and keeps same-named computers apart (${lookName(look)})`, async ({ page }, info) => {
    const t = messages[look.language];
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.setViewportSize({ width: look.width, height: look.height });
    await page.clock.install({ time: '2026-11-24T01:15:00.000Z' });
    await serveApi(page);
    await page.addInitScript(({ language, skin, dir }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', skin);
      if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
    }, { language: look.language, skin: look.skin, dir: look.dir });

    let currentMachines = MACHINES;
    let disconnected = false;
    const org: Org = { company: ME.company, orchestrator: null, agents: { total: 2, working: 2 }, people: [], departments: [] };
    await page.route('**/api/org', route => route.fulfill({ json: org }));
    await page.route('**/api/machines', route =>
      route.fulfill({
        json: {
          machines: currentMachines,
          builtin: BUILTIN,
          priority: true,
          move: null,
          canMove: true,
          copies: { leader: 'rack-02', copies: disconnected ? [] : [{ hostname: 'rack-01', sync: true }], onlySince: null },
        },
      }),
    );
    await page.route('**/api/machines/m-former/disconnect', route => {
      disconnected = true;
      currentMachines = MACHINES.filter(m => m.id !== 'm-former');
      return route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: SUBS } }));
    await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
    await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
    await page.route('**/api/machines/*/connections', route => route.fulfill({ json: STABLE }));

    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.machines, exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });

    /* Pool counts 4 physical machines total (rack-02, rack-01, and two distinct shared-box computers), never duplicating rack-01 or rack-02. */
    const rows = page.locator('tr.rm');
    await expect(rows).toHaveCount(4);
    expect(await rows.evaluateAll(all => all.map(row => row.getAttribute('aria-label')))).toEqual([
      'rack-02',
      'rack-01',
      'shared-box',
      'shared-box',
    ]);

    expect(await brokenHeaderWords(page)).toEqual([]);
    expect(await tableFits(page)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    /* Open rack-01 and verify both roles appear on its single card: replica priority + ready copy + backups AND plans + running work + Disconnect. */
    await page.getByRole('button', { name: t.tables.openCard('rack-01'), exact: true }).click();
    const card = page.getByRole('article', { name: 'rack-01', exact: true });
    await expect(card).toBeVisible();

    const serverBlock = card.getByRole('region', { name: t.cards.serverBlock });
    await expect(serverBlock).toBeVisible();
    await expect(serverBlock.getByText(t.machines.copy.ready, { exact: true })).toBeVisible();
    await expect(serverBlock.getByRole('button', { name: t.machines.move.here, exact: true })).toBeVisible();

    const plansList = card.locator('.blk-side ul.plist > li');
    await expect(plansList).toHaveCount(2);

    const ownerBlock = card.getByRole('region', { name: t.cards.ownerBlock });
    await expect(ownerBlock.getByRole('checkbox', { name: t.machines.lendLabel('rack-01') })).toBeChecked();
    await expect(ownerBlock.getByRole('checkbox', { name: t.machines.keepBackupsLabel('rack-01') })).toBeChecked();
    await expect(ownerBlock.getByRole('button', { name: t.machines.disconnectLabel('rack-01') })).toBeVisible();

    expect(await offences(card, { danger: [t.machines.disconnect], groups: '.mc-blk .entry-actions, .blk-link .entry-actions' })).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await saveShot(page, info, `machines-unified-${lookName(look)}.png`);

    if (look.language === 'en' && look.skin === 'light' && look.width === 1440 && !look.dir) {
      await ownerBlock.getByRole('button', { name: t.machines.disconnectLabel('rack-01') }).click();
      await ownerBlock.getByRole('button', { name: t.machines.yesDisconnect, exact: true }).click();
      await expect.poll(() => disconnected).toBe(true);
      await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.machines, exact: true }).click();
      await expect(rows).toHaveCount(3);
    }
    expect(errors).toEqual([]);
  });
}
