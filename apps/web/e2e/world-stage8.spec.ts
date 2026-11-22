/* Stage 8 E2E verification:
   1) Side-by-side layout invariance across Cyberpunk (dark), Light, and Ancient Egypt
      at matching viewports (1440x900 EN/RU and 375x812 RU narrow screen):
      logo top-left (same dome+dot mark), 5 centered tabs with counters & no new tabs,
      user avatar top-right + dropdown menu, notification banner under tabs,
      zoom bottom-left, orchestrator bar bottom-center, version bottom-right.
   2) Live clicks on all 6 world entity types (house/resident + quick chat, granary/subscription,
      machine hub, pyramid/goal with subgoals, statue, palace/orchestrator).
   3) On-map Department Mode: highlights department houses & residents in banner color,
      dims rest of city, overlays work-path lines (handoff, checker, head_guide, one_shot),
      opens department side card with people/tasks/pipeline/manage tabs, restores city on close. */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Org } from '../src/types';
import { createHornhoofLiveFixture } from '../src/world/live-sync';
import { taskRoute } from '../test/task-route';
import { ME, serveApi } from './api';

const OUT_DIR = process.env.HH_OUT || join(process.cwd(), 'e2e', 'results', 'stage8-out');

function exportShot(srcPath: string, filename: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(srcPath, join(OUT_DIR, filename));
}

const VERSION = { version: '0.40.2', commit: '9d62eaa2e' };
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
type Rect = { x: number; y: number; width: number; height: number; right: number; bottom: number };

const DEV_ID = 'dept-dev';

function buildWorldFixtureWithExtras() {
  const base = createHornhoofLiveFixture();
  return {
    ...base,
    subscriptions: base.subscriptions.map((s, idx) =>
      idx === 0 ? { ...s, resetsAt: '2026-11-22T18:30:00.000Z' } : s,
    ),
    goals: base.goals.map((g, idx) =>
      idx === 0
        ? {
            ...g,
            childGoalsTotal: 3,
            childGoalsReached: 2,
            childGoals: [
              { id: 'subg-1', number: 201, title: 'Isometric world engine', status: 'reached' as const },
              { id: 'subg-2', number: 202, title: 'Live residents and construction', status: 'reached' as const },
              { id: 'subg-3', number: 203, title: 'Themed UI and Department Mode', status: 'active' as const },
            ],
          }
        : g,
    ),
  };
}

function buildMatchingOrg(worldState: ReturnType<typeof buildWorldFixtureWithExtras>): Org {
  return {
    company: ME.company,
    orchestrator: {
      id: 'a1',
      name: 'Orchestrator',
      model: 'claude-opus-5-5',
      effort: 'high',
      subscription: {
        id: worldState.subscriptions[0]!.id,
        provider: 'claude',
        kind: 'personal',
        label: worldState.subscriptions[0]!.label,
        status: 'ready',
        online: true,
        last4: null,
        owner: { id: ME.person.id, name: ME.person.name },
        place: { kind: 'company', id: null, name: ME.company.name },
        machines: [],
        limits: null,
        budget: null,
        isOrchestrator: true,
        accounts: [],
        tier: 'Max',
        accountsDiffer: false,
        signedInOnce: true,
        leaseMachine: null,
      },
      context: 42,
      program: null,
      alarm: null,
      retry: null,
      failure: null,
      planned: true,
    },
    agents: { total: worldState.agents.length, working: worldState.agents.filter(a => a.liveState === 'working').length },
    people: [],
    departments: worldState.departments.slice(0, 3).map(d => ({
      id: d.id,
      name: d.name,
      templateKey: d.templateKey as Org['departments'][number]['templateKey'],
      roleCode: d.roleCode,
      about: '',
      agents: {
        total: worldState.agents.filter(a => a.departmentId === d.id).length,
        working: worldState.agents.filter(a => a.departmentId === d.id && a.liveState === 'working').length,
      },
      products: [],
      teams: [],
      people: [],
      employees: worldState.agents
        .filter(a => a.departmentId === d.id)
        .slice(0, 6)
        .map(a => ({
          id: a.id,
          name: a.name,
          roleId: a.roleKey,
          turnkey: a.isTurnkey,
          title: { en: a.roleKey ?? 'Developer', ru: a.roleKey ?? 'Разработчик' },
          kind: a.kind === 'head' ? 'head' : 'worker',
          model: a.model ?? 'claude-opus-5-5',
          modelName: a.model ?? 'claude-opus-5-5',
          provider: a.provider,
          effort: 'high',
          state: a.liveState === 'working' ? 'working' : 'sleeping',
          status: a.liveState === 'working' ? 'working' : 'idle',
          on: true,
          timer: null,
          task: a.currentTask ? { echelons: taskRoute(), id: a.currentTask.id, number: a.currentTask.number, title: a.currentTask.title } : null,
          context: 0.35,
          program: null,
          alarm: null,
          retry: null,
          failure: null,
        })),
      roles: [],
      pipelines: [
        {
          id: `pipe-${d.id}`,
          department: { id: d.id, name: d.name },
          name: 'Delivery pipeline',
          why: '',
          archived: false,
          version: 1,
          stages: [
            { id: 'st-dev', parentId: null, name: 'Development', ownerRole: 'DEV-ENG', owner: null, position: 0 },
            { id: 'st-rev', parentId: null, name: 'Review', ownerRole: 'DEV-REV', owner: null, position: 1, oneShot: { fanOut: 2, judge: true } },
            { id: 'st-test', parentId: null, name: 'Tests', ownerRole: 'DEV-TEST', owner: null, position: 2 },
          ],
        },
      ],
      calls: [],
    })),
  };
}

type ChromeBox = {
  brand: Rect | null;
  logoParts: { dome: number; base: number; dot: number };
  tabs: Rect;
  tabLabels: string[];
  avatar: Rect;
  banner: Rect | null;
  zoom: Rect;
  ticker: Rect;
  version: Rect;
  overflow: boolean;
};

async function openProductMap(
  page: Page,
  opts: { width: number; height: number; lang: 'en' | 'ru'; theme: 'cyberpunk' | 'light' | 'egypt'; showBanner?: boolean },
): Promise<void> {
  const worldState = buildWorldFixtureWithExtras();
  const org = buildMatchingOrg(worldState);
  await page.setViewportSize({ width: opts.width, height: opts.height });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang: opts.lang, theme: opts.theme });
  await serveApi(page);
  await page.route('**/api/me', route =>
    route.fulfill({ json: { ...ME, company: { ...ME.company, theme: opts.theme } } }),
  );
  await page.route('**/api/org', route => route.fulfill({ json: { ...org, company: { ...ME.company, theme: opts.theme } } }));
  await page.route('**/api/world/state', route => route.fulfill({ json: worldState }));
  await page.route('**/api/version', route => route.fulfill({ json: VERSION }));
  await page.route('**/api/requests', route =>
    route.fulfill({
      json: {
        requests: [],
        proposals: [],
        machineAccess: [],
        counts: { byPerson: {}, byAgent: {}, total: 2 },
      },
    }),
  );
  if (opts.showBanner) {
    await page.route('**/api/backups/recovery', route =>
      route.fulfill({ json: { recoveryNeeded: true, linkChanged: false } }),
    );
  }
  await page.route('**/api/agents/*/events*', route =>
    route.fulfill({
      json: {
        events: [
          {
            seq: 1,
            kind: 'text',
            at: '2026-11-22T10:00:00.000Z',
            data: { text: opts.lang === 'ru' ? 'Да, повелитель, слушаю вас.' : 'Yes, my lord, at your service.' },
          },
        ],
        state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 },
      },
    }),
  );
  await page.route('**/api/agents/*', route => {
    if (route.request().url().includes('/events') || route.request().url().includes('/messages')) {
      return route.fallback();
    }
    return route.fulfill({
      json: {
        id: 'agent-1',
        kind: 'worker',
        name: 'Tank',
        role: null,
        department: { id: DEV_ID, name: 'Development' },
        product: null,
        team: null,
        teams: [],
        model: 'claude-opus-5-5',
        effort: 'high',
        subscription: null,
        machine: null,
        state: 'ready',
        currentTask: null,
        program: null,
        alarm: null,
        retry: null,
        failure: null,
        skills: [],
        parts: [],
        raw: '',
        runsOn: [],
        changes: [
          { field: 'Accepted task #1803', personName: 'Ivan', actingAgent: null, byOrchestrator: false, at: '2026-11-22T09:00:00.000Z' },
        ],
        interrupted: [],
        canEdit: true,
        canRemove: true,
        timer: null,
      },
    });
  });

  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', opts.theme);
  if (opts.theme === 'egypt') {
    await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
    await page.waitForFunction(() => {
      const h = (window as unknown as { __WORLD_PRODUCT__?: { getBuildings: () => unknown[] } }).__WORLD_PRODUCT__;
      return Boolean(h && h.getBuildings().length > 0);
    });
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_PRODUCT__: { flushVisibleBakes: () => void } }).__WORLD_PRODUCT__;
      h.flushVisibleBakes();
    });
  } else {
    await expect(page.locator('.map .dept')).toHaveCount(3);
  }
  await expect(page.locator('.map-version')).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function measureChrome(page: Page): Promise<ChromeBox> {
  return page.evaluate(() => {
    const rectOf = (el: Element | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tabs > button')];
    return {
      brand: rectOf(document.querySelector('.tb-brand')),
      logoParts: {
        dome: document.querySelectorAll('.tb-brand svg .mk-dome').length,
        base: document.querySelectorAll('.tb-brand svg .mk-base').length,
        dot: document.querySelectorAll('.tb-brand svg .mk-dot').length,
      },
      tabs: rectOf(document.querySelector('.tabs'))!,
      tabLabels: tabs.map(btn => (btn.getAttribute('aria-label') || btn.textContent || '').trim()),
      avatar: rectOf(document.querySelector('.tb-right .avatar'))!,
      banner: rectOf(document.querySelector('.banner')),
      zoom: rectOf(document.querySelector('.map > .zoom'))!,
      ticker: rectOf(document.querySelector('.map > .ticker'))!,
      version: rectOf(document.querySelector('.map-version'))!,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

function expectClose(actual: number, expected: number, tol: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: got ${actual}, expected ${expected} (+/-${tol})`).toBeLessThanOrEqual(tol);
}

test.describe('Stage 8 themed map chrome, 6 entity side cards, and on-map Department Mode', () => {
  test('Cyberpunk, Light, and Ancient Egypt place every chrome element identically across languages and viewports', async ({ browser }, info: TestInfo) => {
    test.setTimeout(120_000);
    const cases: Array<{ width: number; height: number; lang: 'en' | 'ru'; themes: Array<'cyberpunk' | 'light' | 'egypt'>; showBanner?: boolean }> = [
      { width: 1440, height: 900, lang: 'en', themes: ['cyberpunk', 'light', 'egypt'], showBanner: true },
      { width: 1440, height: 900, lang: 'ru', themes: ['cyberpunk', 'egypt'], showBanner: false },
      { width: 375, height: 812, lang: 'ru', themes: ['cyberpunk', 'egypt'], showBanner: false },
    ];

    for (const c of cases) {
      const words = MESSAGES[c.lang];
      const measured = new Map<string, ChromeBox>();
      for (const theme of c.themes) {
        const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height } });
        const page = await ctx.newPage();
        try {
          await openProductMap(page, { width: c.width, height: c.height, lang: c.lang, theme, showBanner: c.showBanner });
          const box = await measureChrome(page);
          measured.set(theme, box);

          expect(box.overflow, `${theme} ${c.lang} ${c.width} no horizontal overflow`).toBe(false);
          expect(box.logoParts, `${theme} exact dome+dot logo`).toEqual({ dome: 1, base: 1, dot: 1 });
          expect(box.tabLabels).toHaveLength(5);
          expect(box.tabLabels[0]).toBe(words.shell.tabs.map);
          expect(box.tabLabels[1]).toContain('2');
          expect(box.tabLabels[2]).toBe(words.shell.tabs.people);
          expect(box.tabLabels[3]).toBe(words.shell.tabs.subscriptions);
          expect(box.tabLabels[4]).toBe(words.shell.tabs.machines);
          expect(box.tabLabels.includes(words.settings.menu)).toBe(false);

          const shotName = `stage8-${theme}-${c.lang}-${c.width}.png`;
          const shotPath = info.outputPath(shotName);
          await page.screenshot({ path: shotPath, animations: 'disabled' });
          exportShot(shotPath, shotName);

          /* Avatar menu keeps Settings inside in every theme. */
          await page.locator('.tb-right .avatar').click();
          await expect(page.locator('.account-menu').getByRole('button', { name: words.settings.menu, exact: true })).toBeVisible();
        } finally {
          await ctx.close();
        }
      }

      const base = measured.get('cyberpunk')!;
      const tickerTol = c.width === 375 ? 4 : 2;
      for (const other of c.themes.filter(t => t !== 'cyberpunk')) {
        const cur = measured.get(other)!;
        const tag = `${c.width} ${c.lang} ${other} vs cyberpunk`;
        if (base.brand && cur.brand) {
          expectClose(cur.brand.x, base.brand.x, 1, `${tag} brand.x`);
          expectClose(cur.brand.y, base.brand.y, 1, `${tag} brand.y`);
          expectClose(cur.brand.width, base.brand.width, 1, `${tag} brand.w`);
          expectClose(cur.brand.height, base.brand.height, 1, `${tag} brand.h`);
        }
        expectClose(cur.tabs.y, base.tabs.y, 2, `${tag} tabs.y`);
        expectClose(cur.tabs.height, base.tabs.height, 2, `${tag} tabs.h`);
        if (c.width === 1440) {
          expectClose(cur.tabs.x + cur.tabs.width / 2, base.tabs.x + base.tabs.width / 2, 2, `${tag} tabs.centerX`);
        }
        expectClose(cur.avatar.x, base.avatar.x, 1, `${tag} avatar.x`);
        expectClose(cur.avatar.y, base.avatar.y, 1, `${tag} avatar.y`);
        if (base.banner && cur.banner) {
          expectClose(cur.banner.y, base.banner.y, 2, `${tag} banner.y`);
        }
        expectClose(cur.zoom.x, base.zoom.x, 2, `${tag} zoom.x`);
        expectClose(cur.zoom.y, base.zoom.y, 2, `${tag} zoom.y`);
        expectClose(cur.zoom.height, base.zoom.height, 2, `${tag} zoom.h`);
        expectClose(cur.ticker.bottom, base.ticker.bottom, 2, `${tag} ticker.bottom`);
        expectClose(cur.ticker.x + cur.ticker.width / 2, base.ticker.x + base.ticker.width / 2, 2, `${tag} ticker.centerX`);
        expectClose(cur.version.bottom, base.version.bottom, tickerTol, `${tag} version.bottom`);
        expectClose(cur.version.right, base.version.right, 2, `${tag} version.right`);
      }
    }
  });

  test('clicking all 6 world objects opens their side cards and Department Mode highlights the department on the city map', async ({ page }, info: TestInfo) => {
    test.setTimeout(90_000);
    await openProductMap(page, { width: 1440, height: 900, lang: 'ru', theme: 'egypt' });

    type DebugHandle = {
      selectBuildingByKind: (kind: string, index?: number) => { id: string; label: string; kind: string } | null;
      selectResidentByRoleClass: (roleClass?: string) => { id: string; agentId: string; name: string } | null;
      getDepartmentFocus: () => {
        departmentId: string;
        bannerColor: string;
        highlightedBuildings: number;
        highlightedResidents: number;
        linksCount: number;
        linkKinds: string[];
      } | null;
      clearSelection: () => void;
      flushVisibleBakes: () => void;
    };

    const card = page.getByTestId('world-side-card');

    /* 1. Department building -> Department Mode directly on city map (no separate department screen!). */
    const pickedDept = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.selectBuildingByKind('department', 0));
    expect(pickedDept).not.toBeNull();
    await expect(card).toHaveAttribute('data-card-kind', 'department');
    await expect(page.getByTestId('world-dept-workpaths')).toBeVisible();
    await expect(page.locator('.dview')).toHaveCount(0);

    const focus = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.getDepartmentFocus());
    expect(focus).not.toBeNull();
    expect(focus!.highlightedBuildings).toBeGreaterThanOrEqual(2);
    expect(focus!.highlightedResidents).toBeGreaterThanOrEqual(1);
    expect(focus!.linksCount).toBeGreaterThanOrEqual(2);
    expect(focus!.linkKinds).toContain('handoff');

    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const deptPath = info.outputPath('stage8-egypt-department-mode.png');
    await page.screenshot({ path: deptPath, animations: 'disabled' });
    exportShot(deptPath, 'stage8-egypt-department-mode.png');

    /* Closing the department card restores normal city cleanly (focus === null). */
    await card.getByRole('button', { name: 'Закрыть' }).click();
    await expect(card).toHaveCount(0);
    const clearedFocus = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.getDepartmentFocus());
    expect(clearedFocus).toBeNull();

    /* 2. Resident / House -> Employee card with level, task, history & simple quick chat. */
    const pickedRes = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.selectResidentByRoleClass('executor'));
    expect(pickedRes).not.toBeNull();
    await expect(card).toHaveAttribute('data-card-kind', 'agent');
    await expect(page.getByTestId('world-card-level')).toContainText('Lv');
    await expect(page.getByTestId('world-agent-quick-chat')).toBeVisible();
    await expect(page.getByTestId('world-agent-quick-chat')).toContainText('Да, повелитель');
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const resPath = info.outputPath('stage8-egypt-click-resident.png');
    await page.screenshot({ path: resPath, animations: 'disabled' });
    exportShot(resPath, 'stage8-egypt-click-resident.png');

    /* 3. Granary / Well -> Subscription card with remaining limit, reset time & agents list. */
    const pickedSub = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.selectBuildingByKind('supply', 0));
    expect(pickedSub).not.toBeNull();
    await expect(card).toHaveAttribute('data-card-kind', 'subscription');
    await expect(page.getByTestId('world-sub-remaining')).toContainText('%');
    await expect(page.getByTestId('world-sub-reset')).toBeVisible();
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const subPath = info.outputPath('stage8-egypt-click-subscription.png');
    await page.screenshot({ path: subPath, animations: 'disabled' });
    exportShot(subPath, 'stage8-egypt-click-subscription.png');

    /* 4. Machine Hub -> Machine card with online status, load & hosted agents. */
    const pickedMachine = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.selectBuildingByKind('district_hub', 0));
    expect(pickedMachine).not.toBeNull();
    await expect(card).toHaveAttribute('data-card-kind', 'machine');
    await expect(page.getByTestId('world-machine-load')).toContainText('%');

    /* 5. Pyramid -> Goal card with progress & subgoals. */
    const pickedGoal = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.selectBuildingByKind('monument', 0));
    expect(pickedGoal).not.toBeNull();
    await expect(card).toHaveAttribute('data-card-kind', 'goal');
    await expect(page.getByTestId('world-goal-progress')).toContainText('%');
    await expect(card).toContainText('Isometric world engine');
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const goalPath = info.outputPath('stage8-egypt-click-pyramid.png');
    await page.screenshot({ path: goalPath, animations: 'disabled' });
    exportShot(goalPath, 'stage8-egypt-click-pyramid.png');

    /* 6. Statue -> Department completed tasks card. */
    const pickedStatue = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.selectBuildingByKind('statue', 0));
    expect(pickedStatue).not.toBeNull();
    await expect(card).toHaveAttribute('data-card-kind', 'statue');
    await expect(page.getByTestId('world-statue-tasks')).toContainText('Выполнено задач');

    /* 7. Palace -> Orchestrator card with quick chat & open orchestrator button. */
    const pickedOrch = await page.evaluate(() => (window as unknown as { __WORLD_PRODUCT__: DebugHandle }).__WORLD_PRODUCT__.selectBuildingByKind('residence', 0));
    expect(pickedOrch).not.toBeNull();
    await expect(card).toHaveAttribute('data-card-kind', 'orchestrator');
    await expect(page.getByTestId('world-agent-quick-chat')).toBeVisible();
  });
});
