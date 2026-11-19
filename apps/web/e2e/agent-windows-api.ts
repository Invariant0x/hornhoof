import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { expect, type Locator, type Page, type Route } from '@playwright/test';
import type { AgentCardView, Employee, Org } from '../src/types';
import { CARD, SUB } from './agent-window-api';
import { box, chooseTerminal, ME, serveApi, TASKS, writeToOrchestrator } from './api';
import type { Settings } from './computer-strip-api';

/* A company with the orchestrator and a few employees, each with a window of its own: a terminal, a card and a task. */

const ROLE = { en: 'Developer', ru: 'Разработчик' };
const NAMES = ['Bruno', 'Clara', 'Dana', 'Egor'];

const WORDS = {
  en: {
    orchestrator: 'Orchestrator', tabs: ['Map', 'Tasks', 'People', 'Subscriptions & API', 'Machines'], members: 'Members', tasks: 'Tasks',
    minimize: 'Minimize', close: 'Close', log: 'Chat', terminal: 'Terminal', card: 'Card', task: 'Task', full: 'Full screen', size: 'Restore size',
    openTerminalOf: (name: string) => `Open ${name}'s terminal`, restore: (name: string) => `Restore ${name}`, closeStrip: (name: string) => `Close ${name}`, role: ROLE.en, working: 'Working', sleeping: 'Sleeping', cardOf: (name: string) => `Card: ${name}`,
  },
  ru: {
    orchestrator: 'Оркестратор', tabs: ['Карта', 'Задачи', 'Люди', 'Подписки и API', 'Машины'], members: 'Сотрудники', tasks: 'Задачи',
    minimize: 'Свернуть', close: 'Закрыть', log: 'Чат', terminal: 'Терминал', card: 'Карточка', task: 'Задача', full: 'На весь экран', size: 'Обычный размер',
    openTerminalOf: (name: string) => `Открыть терминал: ${name}`, restore: (name: string) => `Развернуть: ${name}`, closeStrip: (name: string) => `Закрыть: ${name}`, role: ROLE.ru, working: 'Работает', sleeping: 'Спит', cardOf: (name: string) => `Карточка: ${name}`,
  },
};

const idOf = (name: string) => name.toLowerCase();
/* Each one's task is on the next one, so a task's panel opens another agent from inside a window. */
const taskOf = (name: string) => `t-${idOf(name)}`;
const next = (name: string) => NAMES[(NAMES.indexOf(name) + 1) % NAMES.length]!;
const ref = (name: string) => ({ id: idOf(name), name, kind: 'worker' as const, role: ROLE });

const employee = (name: string): Employee => ({
  id: idOf(name), name, roleId: 'DEV-ENG', title: ROLE, kind: 'worker', model: '', modelName: null, provider: 'codex', effort: null,
  state: 'sleeping', status: 'idle', on: true, timer: null, task: null, context: null, program: null, alarm: null, retry: null, failure: null,
});

const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: NAMES.length, working: 0 },
  people: [],
  departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'DEV', about: '', agents: { total: NAMES.length, working: 0 }, products: [], teams: [], people: [], employees: NAMES.map(employee), roles: [{ id: 'DEV-ENG', title: ROLE, description: ROLE, kind: 'member', gate: null }] }],
};

const cardOf = (name: string): AgentCardView => ({ ...CARD, id: idOf(name), name, state: name === 'Bruno' ? 'working' : 'sleeping', currentTask: { id: taskOf(name), number: NAMES.indexOf(name) + 1, title: `Work of ${name}` } });
const ORCHESTRATOR_CARD: AgentCardView = { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null, state: 'sleeping', currentTask: null };

const detailOf = (name: string) => ({
  ...TASKS[0]!, id: taskOf(name), number: NAMES.indexOf(name) + 1, title: `Work of ${name}`, assignee: ref(next(name)), executor: ref(next(name)),
  echelonFindings: emptyEchelonFindings(), body: 'What this agent works on.', parent: null, after: [], createdBy: null, subtasks: [], requests: [], log: [],
});

/* What Dana asks on Clara's task: its line in the task's panel opens Dana's window. */
const REQUEST = {
  id: 'r1', kind: 'question', text: 'Which card form?', commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false, ownerPersonId: ME.person.id, canAnswer: true,
  task: { id: taskOf('Clara'), number: 2, title: 'Work of Clara', department: { id: 'd2', name: 'Development' }, product: null },
  agent: { id: idOf('Dana'), name: 'Dana' }, at: '2026-11-04T00:00:00.000Z',
};

/* busy: whose work Escape can stop. held: whose card and conversation have not come yet. */
type Live = { connections: Record<string, number>; stops: string[]; busy: Set<string>; held: Set<string>; pictures: string[]; keys: Record<string, string[]> };

async function agentResponse(route: Route, live: Live, agent: RegExpExecArray, wait: (id: string) => Promise<void>): Promise<void> {
  const [, id, part] = agent as unknown as [string, string, string | undefined];
  const card = id === 'orchestrator' ? ORCHESTRATOR_CARD : NAMES.map(cardOf).find(c => c.id === id);
  if (!card) return route.fallback();
  if (part === '/stop') { live.stops.push(id); return route.fulfill({ json: {} }); }
  await wait(id);
  if (part === '/events') return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: live.busy.has(id), runningJobId: live.busy.has(id) ? 'j1' : null, queued: 0, terminal: true, canType: true } } });
  return route.fulfill({ json: card });
}

async function serveTerminal(page: Page, live: Live): Promise<void> {
  await page.routeWebSocket('**/api/agents/*/terminal*', ws => {
    const id = /agents\/([^/]+)\/terminal/.exec(ws.url())![1]!;
    live.connections[id] = (live.connections[id] ?? 0) + 1;
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === 'input') (live.keys[id] ??= []).push(frame.data!);
    });
    ws.send(JSON.stringify({ type: 'ready', write: true, message: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: `${id} is at work.\r\n> ` }));
  });
}

function heldResponses(live: Live) {
  const held = new Map<string, (() => void)[]>();
  const release = (id: string) => { for (const go of held.get(id) ?? []) go(); held.delete(id); };
  const wait = (id: string) => live.held.has(id) ? new Promise<void>(go => held.set(id, [...(held.get(id) ?? []), go])) : Promise.resolve();
  return { release, wait };
}

async function serve(page: Page, live: Live): Promise<void> {
  await serveApi(page);
  const { release, wait } = heldResponses(live);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const picture = /^\/api\/agents\/([^/]+)\/pictures$/.exec(path);
    if (picture) {
      live.pictures.push(picture[1]!);
      return route.fulfill({ json: { id: 'pic1', name: url.searchParams.get('name') } });
    }
    const agent = /^\/api\/agents\/([^/]+)(\/events|\/stop)?$/.exec(path);
    if (agent) return agentResponse(route, live, agent, wait);
    const task = NAMES.find(name => path === `/api/tasks/${taskOf(name)}`);
    if (task) return route.fulfill({ json: { task: detailOf(task) } });
    const answers: Record<string, unknown> = {
      '/api/org': ORG,
      '/api/requests': { requests: [REQUEST], proposals: [], machineAccess: [], counts: { byPerson: {}, byAgent: {}, total: 0 } },
      '/api/agents/orchestrator/start': { started: false },
      '/api/machines/access': { views: [] },
      '/api/nodes/commands': { commands: [] },
      '/api/version': { version: '0.5.0', commit: 'b77ce08' },
      '/api/updates': { current: { version: '0.5.0', commit: 'b77ce08' }, available: false, latest: null, updater: { status: null, waiting: null } },
      '/api/subscriptions': { subscriptions: [{ ...SUB, agents: [] }] },
      '/api/machines': { machines: [] },
      '/api/people': { people: [] },
      '/api/notebook': { notes: [] },
      '/api/departments/d2/notebook': { notes: [] },
    };
    if (path in answers) return route.fulfill({ json: answers[path] });
    if (path.endsWith('/structure')) return route.fulfill({ json: { departments: [] } });
    return route.fallback();
  });
  await serveTerminal(page, live);
  releases.set(page, release);
}

const releases = new WeakMap<Page, (id: string) => void>();

export const overlaps = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export async function openCompany(page: Page, { lang, theme, width }: Settings, state: { busy?: string[]; held?: string[] } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  await chooseTerminal(page);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`); });
  const live: Live = { connections: {}, stops: [], busy: new Set(state.busy), held: new Set(state.held), pictures: [], keys: {} };
  await serve(page, live);
  await page.goto('/');
  const words = WORDS[lang];
  const nav = page.getByRole('navigation');
  const tab = (name: string) => nav.getByRole('button', { name, exact: true });
  /* What the window and the strip are called: the role comes from the card. */
  const titled = (name: string) => (name === words.orchestrator ? name : `${name}, ${words.role}`);
  const windowOf = (name: string): Locator => page.getByRole('complementary', { name: titled(name), exact: true });
  const stripOf = (name: string): Locator => page.getByRole('button', { name: words.restore(titled(name)), exact: true });
  const anyStrip = page.getByRole('button', { name: new RegExp(`^${words.restore('')}`) });
  const bar = (name: string) => windowOf(name).locator(':scope > .t-bar');
  const barButton = (name: string, label: string) => bar(name).getByRole('button', { name: label, exact: true });
  return {
    words, errors, live, tab, windowOf, stripOf, anyStrip, bar, barButton,
    release: (id: string) => { live.held.delete(id); releases.get(page)!(id); },
    closeStrip: (name: string) => page.getByRole('button', { name: words.closeStrip(titled(name)), exact: true }),
    openOrchestrator: async () => {
      await tab(words.tasks).click();
      await writeToOrchestrator(page, lang);
      await expect(windowOf(words.orchestrator)).toBeVisible();
    },
    openEmployee: async (name: string) => {
      await tab(words.tabs[0]!).click();
      if (!(await page.locator('.dview').count())) await page.getByRole('button', { name: /^Development/ }).click();
      await page.getByRole('region', { name: words.members }).getByRole('button', { name: new RegExp(name) }).click();
      await expect(windowOf(name)).toBeVisible();
    },
    minimize: async (name: string) => {
      await barButton(name, words.minimize).click();
      await expect(windowOf(name)).toBeHidden();
    },
  };
}

/* A picture from the clipboard, pasted with the focus nowhere in particular. */
export const pastePicture = (page: Page, name: string) =>
  page.evaluate(async name => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const blob = await new Promise<Blob>(done => canvas.toBlob(made => done(made!), 'image/png'));
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([blob], name, { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, name);

/* The strips stand on the screen and clear of each other, and big enough for a finger. */
export async function expectStripsApart(page: Page, strips: Locator[]) {
  const rects = await Promise.all(strips.map(box));
  for (const [i, rect] of rects.entries()) {
    expect(rect.height).toBeGreaterThanOrEqual(32);
    expect(rect.width).toBeGreaterThanOrEqual(24);
    for (const other of rects.slice(i + 1)) expect(overlaps(rect, other)).toBe(false);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return rects;
}
