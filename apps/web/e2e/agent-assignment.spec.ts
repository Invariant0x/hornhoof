import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import type { AgentCardView, Employee, Org, Part } from '../src/types';
import { ME, serveApi, streamEndedByPage } from './api';

const EMPLOYEE_NAME = 'Avery';
const EMPLOYEE_ID = 'assignment-worker';
const DEPARTMENT_ID = 'assignment-department';
const ROLE_TITLE = { en: 'Engineer', ru: 'Инженер' };
const SKILL_TITLE = { en: 'Test the change', ru: 'Проверить изменение' };
const ROLE_IDENTITY = 'You are the engineer for service behavior and data boundaries.';
const LEGACY_ASSIGNMENT = '\nMaintain the billing service.  \n\nKeep its audit history.\n';
const LONG_REFERENCE = `https://example.invalid/assignments/${'long-reference-'.repeat(20)}`;
const SAVED_ASSIGNMENT = `\nMaintain billing and refunds.  \n\nKeep customer data safe.\n${LONG_REFERENCE}\n`;
const RAW_ASSIGNMENT = '\nMaintain billing without changing prices.  \n\nKeep payment retries safe.\n';
const FINAL_ASSIGNMENT = `${RAW_ASSIGNMENT}${LONG_REFERENCE}\n`;
const DEFAULT_SKILL = 'Write a failing check, make the change and keep the evidence.';
const EDITED_SKILL = 'Keep the failing case and verify the changed behavior.';
const RTL_LANGUAGES = /^(?:ar|he|fa|ur|ps|sd|ug|yi)(?:-|$)/;

type FixtureState = {
  assignment: string;
  skill: string;
  canEdit: boolean;
  patches: unknown[];
  resets: number;
  apiRequests: { method: string; path: string }[];
};
type LocaleSample = { id: Language; characters: number; strings: string[] };
type Geometry = { surface: string; locale: Language; measurements: unknown };

const EMPLOYEE: Employee = {
  id: EMPLOYEE_ID, name: EMPLOYEE_NAME, roleId: 'DEV-ENG', title: ROLE_TITLE, kind: 'worker', model: '', modelName: null,
  provider: 'codex', effort: null, state: 'sleeping', status: 'idle', on: true, timer: null, task: null,
  context: null, program: null, alarm: null, retry: null, failure: null,
};
const ORG: Org = {
  company: ME.company, orchestrator: null, agents: { total: 1, working: 0 }, people: [],
  departments: [{
    id: DEPARTMENT_ID, name: 'Assignment checks', templateKey: null, roleCode: 'DEV', about: '', agents: { total: 1, working: 0 },
    products: [], teams: [], people: [], employees: [EMPLOYEE],
    roles: [{ id: 'DEV-ENG', title: ROLE_TITLE, description: ROLE_TITLE, kind: 'member', gate: null }],
  }],
};

function cardOf(state: FixtureState): AgentCardView {
  const parts: Part[] = [
    { kind: 'header', id: null, title: null, text: `You are ${EMPLOYEE_NAME}, an engineer in the Development department at Acme.`, overridden: false, templateChanged: false },
    { kind: 'base', id: 'DEV-ENG', title: ROLE_TITLE, text: ROLE_IDENTITY, overridden: false, templateChanged: false },
    { kind: 'assignment', id: null, title: { en: 'Assignment', ru: 'Назначение' }, text: `<!-- hh:assignment -->\n## Assignment\n\n${state.assignment}\n<!-- /hh:assignment -->`, overridden: true, templateChanged: false },
    { kind: 'skill', id: 'dev-tdd', title: SKILL_TITLE, text: `<!-- hh:skill dev-tdd -->\n## Test the change\n\n${state.skill}\n<!-- /hh:skill -->`, overridden: state.skill !== DEFAULT_SKILL, templateChanged: false },
  ];
  const raw = parts.map(part => part.text).join('\n\n');
  return {
    id: EMPLOYEE_ID, name: EMPLOYEE_NAME, kind: 'worker', currentTask: null,
    role: { id: 'DEV-ENG', title: ROLE_TITLE, description: ROLE_TITLE }, department: { id: DEPARTMENT_ID, name: 'Assignment checks' },
    product: null, team: null, teams: [], model: '', effort: null, subscription: null, machine: null,
    state: 'sleeping', program: null, alarm: null, retry: null, failure: null,
    skills: [{ id: 'dev-tdd', title: SKILL_TITLE, description: SKILL_TITLE, on: true, locked: false, overridden: state.skill !== DEFAULT_SKILL, templateChanged: false }],
    parts, raw, instructions: { length: raw.length, max: 200_000 }, runsOn: [], changes: [], interrupted: [], canEdit: state.canEdit, canRemove: state.canEdit, timer: null,
  };
}

async function messagesFor(locale: Language): Promise<Messages> {
  const dictionary = await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>;
  const messages = dictionary[locale];
  if (!messages) throw new Error(`No dictionary export for shipped locale ${locale}`);
  return messages;
}

async function mountFixture(page: Page, state: FixtureState, errors: string[]): Promise<void> {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  /* Only a request that leaves the app's origin comes to the test, and is refused. The app's own modules go straight to
     its server: each of the hundreds of them a page loads took a trip through the test, which made one load take seconds
     on a busy machine and the test's six loads outrun its time. */
  const outside = new RegExp(`^(?!${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/)`);
  await page.route(outside, route => {
    const url = new URL(route.request().url());
    errors.push(`Unexpected external request: ${url.origin}${url.pathname}`);
    return route.abort('blockedbyclient');
  });
  await serveApi(page);
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    state.apiRequests.push({ method: request.method(), path: url.pathname + url.search });
    if (url.pathname === `/api/agents/${EMPLOYEE_ID}`) {
      if (request.method() === 'GET') return route.fulfill({ json: cardOf(state) });
      if (request.method() === 'PATCH') {
        const body: unknown = request.postDataJSON();
        state.patches.push(body);
        if (!state.canEdit) return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Read-only fixture.' } } });
        if (!body || typeof body !== 'object' || Object.keys(body).some(key => key !== 'base' && key !== 'skillText')) {
          return route.fulfill({ status: 422, json: { error: { code: 'invalid', message: 'Unexpected card field.' } } });
        }
        const edit = body as { base?: string; skillText?: Record<string, string> };
        if (edit.base !== undefined) state.assignment = edit.base;
        if (edit.skillText?.['dev-tdd'] !== undefined) state.skill = edit.skillText['dev-tdd'];
        return route.fulfill({ json: cardOf(state) });
      }
    }
    if (url.pathname === `/api/agents/${EMPLOYEE_ID}/reset` && request.method() === 'POST') {
      if (!state.canEdit) return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Read-only fixture.' } } });
      state.resets++;
      state.skill = DEFAULT_SKILL;
      return route.fulfill({ json: cardOf(state) });
    }
    if (url.pathname === `/api/agents/${EMPLOYEE_ID}/events`) {
      return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false } } });
    }
    const fixtures: Record<string, unknown> = {
      '/api/org': ORG,
      '/api/version': { version: '0.8.1', commit: 'assignment-browser-fixture' },
      '/api/updates': { current: { version: '0.8.1', commit: 'assignment-browser-fixture' }, available: false, latest: null, updater: { status: null, waiting: null } },
      [`/api/tasks?status=open&department=${DEPARTMENT_ID}`]: { tasks: [] },
      '/api/subscriptions': { subscriptions: [] },
      '/api/machines': { machines: [] },
      '/api/people': { people: [] },
    };
    const path = url.pathname + url.search;
    return path in fixtures ? route.fulfill({ json: fixtures[path] }) : route.fallback();
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on('requestfailed', request => {
    if (!streamEndedByPage(request)) errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'Unknown failure'}`);
  });
}

async function openCard(page: Page, locale: Language, words: Messages): Promise<Locator> {
  await page.goto(`/departments/${DEPARTMENT_ID}?assignment-locale=${locale}`);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await page.getByRole('region', { name: words.dept.members, exact: true }).getByRole('button', { name: new RegExp(EMPLOYEE_NAME) }).click();
  await page.getByRole('button', { name: words.window.card, exact: true }).click();
  const card = page.getByRole('complementary', { name: words.window.cardOf(EMPLOYEE_NAME), exact: true });
  await expect(card.getByRole('textbox', { name: words.agent.assignment, exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return card;
}

async function renderedStrings(card: Locator): Promise<string[]> {
  return card.evaluate(element => {
    const strings: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      const text = walker.currentNode.textContent?.trim();
      if (!parent || !text || parent.closest('textarea, [aria-hidden="true"]')) continue;
      const style = getComputedStyle(parent);
      if (style.visibility !== 'hidden' && style.display !== 'none' && parent.getClientRects().length) strings.push(text);
    }
    return strings;
  });
}

async function chooseLocales(page: Page, state: FixtureState): Promise<{ ranked: LocaleSample[]; selected: Language[]; rtl: Language[] }> {
  const ranked: LocaleSample[] = [];
  for (const { id } of LANGUAGES) {
    const words = await messagesFor(id);
    state.assignment = LEGACY_ASSIGNMENT;
    state.skill = DEFAULT_SKILL;
    state.canEdit = true;
    const card = await openCard(page, id, words);
    const strings = await renderedStrings(card);
    await card.getByRole('textbox', { name: words.agent.assignment, exact: true }).fill(SAVED_ASSIGNMENT);
    strings.push(...await renderedStrings(card));
    await card.getByRole('button', { name: words.common.cancel, exact: true }).click();
    await card.getByRole('button', { name: words.agent.reset, exact: true }).click();
    await expect(card.getByText(words.agent.resetAsk(EMPLOYEE_NAME), { exact: true })).toBeVisible();
    strings.push(...await renderedStrings(card));
    ranked.push({ id, strings, characters: strings.reduce((sum, text) => sum + text.length, 0) });
  }
  ranked.sort((a, b) => a.characters - b.characters || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!ranked.length) throw new Error('No shipped locales registered');
  const rtl = LANGUAGES.map(locale => locale.id).filter(id => RTL_LANGUAGES.test(id));
  return { ranked, selected: [...new Set([ranked[0]!.id, ranked.at(-1)!.id, ...rtl.slice(0, 1)])], rtl };
}

async function geometryOf(page: Page, card: Locator): Promise<unknown> {
  const measurements = await card.evaluate(element => {
    const panel = element as HTMLElement;
    const body = panel.querySelector<HTMLElement>('.ac-body')!;
    const rect = panel.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth },
      panel: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      body: { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth },
      controls: [...panel.querySelectorAll<HTMLElement>('textarea, button, select')].map(control => {
        const box = control.getBoundingClientRect();
        const style = getComputedStyle(control);
        return { label: control.getAttribute('aria-label') || control.id || control.textContent || control.tagName, x: box.x, right: box.right, width: box.width, height: box.height, clientWidth: control.clientWidth, scrollWidth: control.scrollWidth, fontSize: style.fontSize, lineHeight: style.lineHeight, padding: style.padding, borderWidth: style.borderWidth };
      }),
    };
  });
  expect(measurements.viewport.scrollWidth).toBeLessThanOrEqual(measurements.viewport.width);
  expect(measurements.panel.x).toBeGreaterThanOrEqual(0);
  expect(measurements.panel.right).toBeLessThanOrEqual(measurements.viewport.width + 1);
  expect(measurements.panel.y).toBeGreaterThanOrEqual(0);
  expect(measurements.panel.bottom).toBeLessThanOrEqual(measurements.viewport.height + 1);
  expect(measurements.body.scrollWidth).toBeLessThanOrEqual(measurements.body.clientWidth);
  for (const control of measurements.controls) {
    expect(control.width, control.label ?? '').toBeGreaterThan(0);
    expect(control.x, control.label ?? '').toBeGreaterThanOrEqual(measurements.panel.x);
    expect(control.right, control.label ?? '').toBeLessThanOrEqual(measurements.panel.right);
    if (control.label?.includes('assignment-text')) expect(control.scrollWidth).toBeLessThanOrEqual(control.clientWidth);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return measurements;
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

const freshState = (): FixtureState => ({ assignment: LEGACY_ASSIGNMENT, skill: DEFAULT_SKILL, canEdit: true, patches: [], resets: 0, apiRequests: [] });

async function openFixture(page: Page, width: number, theme: string, state: FixtureState, errors: string[]): Promise<void> {
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ theme }) => {
    const locale = new URL(location.href).searchParams.get('assignment-locale');
    if (locale) localStorage.setItem('hh-lang', locale);
    localStorage.setItem('hh-theme', theme);
  }, { theme });
  await mountFixture(page, state, errors);
}

/* The ranking of the shipped locales, the flow of each locale and its read-only view are tests of their own: the ranking
   loads the card once per locale and the others once, so none outruns its time on a busy machine or as locales are added.
   Every shipped locale has its flow and its read-only view, which covers the shortest, the longest and the first
   right-to-left one the ranking names. */
for (const width of [375, 1280]) {
  for (const theme of ['light', 'cyberpunk'] as const) {
    test(`shipped locales ranked by the assignment card at ${width}px in ${theme}`, async ({ page }, info) => {
      const state = freshState();
      const errors: string[] = [];
      await openFixture(page, width, theme, state, errors);
      const locales = await chooseLocales(page, state);
      await info.attach('shipped-locale-ranking', { body: JSON.stringify({ ...locales, rtlStatus: locales.rtl.length ? 'CHECKED' : 'NOT_AVAILABLE' }, null, 2), contentType: 'application/json' });
      expect(locales.ranked.map(sample => sample.id).sort()).toEqual(LANGUAGES.map(language => language.id).sort());
      expect(errors).toEqual([]);
    });

    for (const { id: locale } of LANGUAGES) {
      test(`assignment card flow and geometry at ${width}px in ${theme}, ${locale}`, async ({ page, browser }, info) => {
        const state = freshState();
        const errors: string[] = [];
        const geometry: Geometry[] = [];
        await openFixture(page, width, theme, state, errors);
        await test.step(`${locale}: save, raw round-trip and reset`, async () => {
          const words = await messagesFor(locale);
          state.assignment = LEGACY_ASSIGNMENT;
          state.skill = DEFAULT_SKILL;
          state.canEdit = true;
          const card = await openCard(page, locale, words);
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          const assignment = card.getByRole('textbox', { name: words.agent.assignment, exact: true });
          const identity = card.getByRole('textbox', { name: ROLE_TITLE[locale], exact: true });
          const section = card.getByRole('region', { name: words.agent.assignment, exact: true });
          await expect(assignment).toHaveValue(LEGACY_ASSIGNMENT);
          await expect(identity).toHaveValue(ROLE_IDENTITY);
          await expect(identity).toHaveAttribute('readonly');
          await expect(section.getByRole('checkbox')).toHaveCount(0);
          await expect(card.getByRole('region', { name: words.agent.prompt, exact: true }).getByRole('textbox', { name: words.agent.assignment, exact: true })).toHaveCount(0);

          await assignment.fill(SAVED_ASSIGNMENT);
          await assignment.focus();
          await assignment.press('ControlOrMeta+Home');
          await expect(assignment).toBeFocused();
          await expect(assignment).toHaveCSS('overflow-wrap', 'anywhere');
          geometry.push({ surface: 'assignment-edit', locale, measurements: await geometryOf(page, card) });
          await shot(page, info, `assignment-edit-${locale}-${theme}-${width}`);
          await card.getByRole('button', { name: words.common.save, exact: true }).click();
          await expect.poll(() => state.patches.at(-1)).toEqual({ base: SAVED_ASSIGNMENT });
          await expect(card.getByRole('status')).toHaveText(words.agent.applies);
          await expect(assignment).toHaveValue(SAVED_ASSIGNMENT);

          await card.getByRole('button', { name: words.agent.raw, exact: true }).click();
          const raw = card.getByRole('textbox', { name: words.agent.raw, exact: true });
          const savedRaw = await raw.inputValue();
          const patchCount = state.patches.length;
          await raw.fill(savedRaw.replace(ROLE_IDENTITY, 'You are the head of another department.'));
          await card.getByRole('button', { name: words.common.save, exact: true }).click();
          await expect(card.getByRole('alert')).toHaveText(words.agent.rawBroken);
          expect(state.patches).toHaveLength(patchCount);
          await shot(page, info, `assignment-immutable-role-${locale}-${theme}-${width}`);

          await raw.fill(savedRaw.replace(SAVED_ASSIGNMENT, RAW_ASSIGNMENT).replace(DEFAULT_SKILL, EDITED_SKILL));
          await card.getByRole('button', { name: words.agent.bySkill, exact: true }).click();
          await expect(assignment).toHaveValue(RAW_ASSIGNMENT);
          await expect(identity).toHaveValue(ROLE_IDENTITY);
          await expect(card.getByRole('textbox', { name: SKILL_TITLE[locale], exact: true })).toHaveValue(EDITED_SKILL);
          await card.getByRole('button', { name: words.agent.raw, exact: true }).click();
          await assignment.fill(FINAL_ASSIGNMENT);
          await expect(raw).toHaveValue(savedRaw.replace(SAVED_ASSIGNMENT, FINAL_ASSIGNMENT).replace(DEFAULT_SKILL, EDITED_SKILL));
          await card.getByRole('button', { name: words.common.save, exact: true }).click();
          await expect.poll(() => state.patches.at(-1)).toEqual({ base: FINAL_ASSIGNMENT, skillText: { 'dev-tdd': EDITED_SKILL } });
          await expect(card.getByRole('status')).toHaveText(words.agent.applies);
          await card.getByRole('button', { name: words.agent.bySkill, exact: true }).click();

          const resets = state.resets;
          await card.getByRole('button', { name: words.agent.reset, exact: true }).click();
          await expect(card.getByText(words.agent.resetAsk(EMPLOYEE_NAME), { exact: true })).toBeVisible();
          await card.getByRole('button', { name: words.agent.yesReset, exact: true }).click();
          await expect.poll(() => state.resets).toBe(resets + 1);
          await expect(assignment).toHaveValue(FINAL_ASSIGNMENT);
          await expect(identity).toHaveValue(ROLE_IDENTITY);
          await expect(card.getByRole('textbox', { name: SKILL_TITLE[locale], exact: true })).toHaveValue(DEFAULT_SKILL);
          geometry.push({ surface: 'assignment-reset', locale, measurements: await geometryOf(page, card) });
          await assignment.scrollIntoViewIfNeeded();
          await shot(page, info, `assignment-reset-${locale}-${theme}-${width}`);
        });

        await info.attach('assignment-fixture-observations', { body: JSON.stringify({ provenance: 'playwright-route-fixture', engine: info.project.use.browserName, browserVersion: browser.version(), width, theme, locale, patches: state.patches, resets: state.resets, apiRequests: state.apiRequests, geometry, errors }, null, 2), contentType: 'application/json' });
        expect(errors).toEqual([]);
      });

      test(`read-only assignment card at ${width}px in ${theme}, ${locale}`, async ({ page, browser }, info) => {
        /* What the flow above leaves: its last saved assignment and the skill reset to the role's own. */
        const state: FixtureState = { ...freshState(), assignment: FINAL_ASSIGNMENT, canEdit: false };
        const errors: string[] = [];
        const geometry: Geometry[] = [];
        await openFixture(page, width, theme, state, errors);
        await test.step(`${locale}: read-only`, async () => {
          const words = await messagesFor(locale);
          const readonlyCard = await openCard(page, locale, words);
          const readonlyAssignment = readonlyCard.getByRole('textbox', { name: words.agent.assignment, exact: true });
          await expect(readonlyAssignment).toHaveValue(FINAL_ASSIGNMENT);
          await expect(readonlyAssignment).toHaveAttribute('readonly');
          const readonlyPatchCount = state.patches.length;
          await readonlyAssignment.focus();
          await page.keyboard.type(' forbidden edit');
          await expect(readonlyAssignment).toHaveValue(FINAL_ASSIGNMENT);
          expect(state.patches).toHaveLength(readonlyPatchCount);
          await expect(readonlyCard.getByRole('button', { name: words.agent.reset, exact: true })).toHaveCount(0);
          await expect(readonlyCard.getByRole('button', { name: words.common.save, exact: true })).toHaveCount(0);
          await readonlyCard.getByRole('button', { name: words.agent.raw, exact: true }).click();
          await expect(readonlyCard.getByRole('textbox', { name: words.agent.raw, exact: true })).toHaveAttribute('readonly');
          geometry.push({ surface: 'assignment-readonly', locale, measurements: await geometryOf(page, readonlyCard) });
          await readonlyCard.getByRole('textbox', { name: words.agent.assignment, exact: true }).scrollIntoViewIfNeeded();
          await shot(page, info, `assignment-readonly-${locale}-${theme}-${width}`);
        });

        await info.attach('assignment-fixture-observations', { body: JSON.stringify({ provenance: 'playwright-route-fixture', engine: info.project.use.browserName, browserVersion: browser.version(), width, theme, locale, patches: state.patches, resets: state.resets, apiRequests: state.apiRequests, geometry, errors }, null, 2), contentType: 'application/json' });
        expect(errors).toEqual([]);
      });
    }
  }
}

/* The checks above count every failed request as an error of the card, except the page ending its own stream. Here the
   page ends a stream the fixture holds, at a moment the test chooses, and a stream the server refuses must still count. */
test('the page ending its stream is no error of the card, a refused stream is', async ({ page }) => {
  const state = freshState();
  const errors: string[] = [];
  const isStream = (url: string) => new URL(url).pathname === '/api/stream';
  const held = () => state.apiRequests.filter(request => request.path === '/api/stream').length;
  await openFixture(page, 1280, 'light', state, errors);
  await openCard(page, 'en', await messagesFor('en'));

  const before = held();
  const opening = page.waitForRequest(request => isStream(request.url()));
  await page.evaluate(() => { Object.assign(window, { ownStream: new EventSource('/api/stream') }); });
  const own = await opening;
  await expect.poll(held).toBe(before + 1);
  const ended = page.waitForEvent('requestfailed', request => request === own);
  await page.evaluate(() => (window as unknown as { ownStream: EventSource }).ownStream.close());
  await ended;
  expect(errors).toEqual([]);

  await page.route('**/api/stream', route => route.abort('connectionrefused'));
  const refusing = page.waitForEvent('requestfailed', request => isStream(request.url()));
  await page.evaluate(() => { Object.assign(window, { refusedStream: new EventSource('/api/stream') }); });
  const refused = await refusing;
  await page.evaluate(() => (window as unknown as { refusedStream: EventSource }).refusedStream.close());
  expect(errors).toContain(`GET ${refused.url()}: ${refused.failure()?.errorText ?? 'Unknown failure'}`);
});
