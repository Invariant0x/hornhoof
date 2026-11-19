import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { taskRoute } from '../test/task-route';
import type { AgentCardView, Briefing, Decisions, EventView, Me, Org, TaskDetail, TaskLine, TurnView, WaitingRequest } from '../src/types';
import { AGENT_HIDDEN } from './api';
import { bigCompany } from './big-company-api';

type ProbeReport = {
  emptyRootFrames: number;
  greyBodyFrames: number;
  schemaMounts: number;
  windowMounts: number;
  terminalMounts: number;
  unhandledRejections: string[];
};

type WindowWithProbe = Window & {
  __hhLive(message: unknown): void;
  __hhProbe(): ProbeReport;
};

const AT = '2026-11-14T13:45:00.000Z';

const MAX_ME: Me = {
  person: {
    id: 'p-max',
    companyId: 'c1',
    name: 'Max',
    email: 'max@northwind.example',
    title: 'CMO',
    status: 'active',
    scopeKind: 'listed',
    isOwner: false,
  },
  company: { id: 'c1', name: 'Northwind' },
  canDecideCompany: false,
};

function installStreamAndProbe() {
  const streams: EventTarget[] = [];
  class FakeEventSource extends EventTarget {
    static readonly CLOSED = 2;
    readyState = 1;
    constructor() {
      super();
      streams.push(this);
    }
    close() {
      this.readyState = 2;
    }
  }
  Object.assign(window, { EventSource: FakeEventSource });

  let rootHadChildren = false;
  let emptyRootFrames = 0;
  let greyBodyFrames = 0;
  let schemaMounts = 0;
  let windowMounts = 0;
  let terminalMounts = 0;
  const seenSchemas = new WeakSet<Element>();
  const seenWindows = new WeakSet<Element>();
  const seenTerminals = new WeakSet<Element>();
  const unhandledRejections: string[] = [];

  window.addEventListener('unhandledrejection', event => {
    event.preventDefault();
    unhandledRejections.push(String(event.reason));
  });

  const sample = () => {
    const root = document.getElementById('root');
    if (root) {
      if (root.childElementCount > 0) rootHadChildren = true;
      else if (rootHadChildren) emptyRootFrames++;
    }
    const body = document.querySelector('main.body');
    if (body && !body.querySelector('.dcanvas, .map, .tasks, .alert, .unavail')) {
      greyBodyFrames++;
    }
    for (const el of document.querySelectorAll('.dcanvas[role="region"]')) {
      if (!seenSchemas.has(el)) {
        seenSchemas.add(el);
        schemaMounts++;
      }
    }
    for (const el of document.querySelectorAll('aside.orch')) {
      if (!seenWindows.has(el)) {
        seenWindows.add(el);
        windowMounts++;
      }
    }
    for (const el of document.querySelectorAll('.t-xterm')) {
      if (!seenTerminals.has(el)) {
        seenTerminals.add(el);
        terminalMounts++;
      }
    }
  };

  const observer = new MutationObserver(sample);
  observer.observe(document, { childList: true, subtree: true });

  const host = window as unknown as WindowWithProbe;
  host.__hhLive = message => {
    const payload = JSON.stringify(message);
    for (const s of streams) s.dispatchEvent(new MessageEvent('message', { data: payload }));
  };
  host.__hhProbe = () => {
    sample();
    return { emptyRootFrames, greyBodyFrames, schemaMounts, windowMounts, terminalMounts, unhandledRejections: [...unhandledRejections] };
  };
}

const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const readProbe = (page: Page) => page.evaluate(() => (window as unknown as WindowWithProbe).__hhProbe());

const emitLive = (page: Page, message: unknown) =>
  page.evaluate(m => (window as unknown as WindowWithProbe).__hhLive(m), message);

const emitLiveBatch = (page: Page, messages: unknown[]) =>
  page.evaluate(ms => {
    const host = window as unknown as WindowWithProbe;
    for (const m of ms) host.__hhLive(m);
  }, messages);

function buildNorthwindFixture() {
  const base = bigCompany();
  const ownDeptId = base.departments[0]!.id;
  const headBase = base.departments[0]!.employees[0]!;
  const foreignHeadId = base.departments[1]!.employees[0]!.id;
  const allAgentIds = base.departments.flatMap(d => d.employees.map(e => e.id));

  const taskLine: TaskLine = {
    echelons: taskRoute('development', headBase.id),
    id: 't-head',
    number: 859,
    title: 'Q4 Launch Plan',
    brief: 'Decide Q4 enterprise vs self-serve rollout.',
    status: 'waiting',
    department: { id: ownDeptId, name: 'Department 1' },
    product: base.departments[0]!.products[0] ?? null,
    assignee: { id: headBase.id, name: headBase.name, kind: 'head', role: headBase.title },
    turn: 12,
    parentId: null,
    waitsFor: [],
    createdAt: AT,
    updatedAt: AT,
  };

  const orgFor = (answered: boolean): Org => ({
    ...base,
    company: MAX_ME.company,
    orchestrator: base.orchestrator ? { ...base.orchestrator, opens: false } : null,
    people: [],
    departments: base.departments.map((d, index) => {
      const own = index === 0;
      return {
        ...d,
        ownerPersonId: own ? MAX_ME.person.id : null,
        people: own
          ? [{
            id: MAX_ME.person.id,
            name: MAX_ME.person.name,
            email: MAX_ME.person.email,
            title: MAX_ME.person.title,
            status: 'active',
            isOwner: false,
            access: { whole: false, departments: [{ id: ownDeptId, name: d.name ?? 'Department 1' }], teams: [] },
            pendingDecisions: answered ? 0 : 1,
          }]
          : d.people,
        employees: d.employees.map((e, empIdx) => ({
          ...e,
          opens: own,
          ...(own && empIdx === 0
            ? {
              status: answered ? 'working' : 'waiting',
              state: 'working',
              task: { id: taskLine.id, number: taskLine.number, title: taskLine.title, echelons: taskLine.echelons },
            }
            : {}),
        })),
      };
    }),
  });

  const headCard: AgentCardView = {
    id: headBase.id,
    currentTask: { id: taskLine.id, number: taskLine.number, title: taskLine.title },
    kind: 'head',
    name: headBase.name,
    role: { id: headBase.roleId ?? 'r0-head', title: headBase.title ?? { en: 'Head', ru: 'Глава' }, description: { en: '', ru: '' } },
    department: { id: ownDeptId, name: 'Department 1' },
    product: null,
    team: null,
    teams: [],
    model: 'claude-opus-5-5',
    effort: null,
    subscription: null,
    machine: null,
    state: 'working',
    retry: null,
    failure: null,
    skills: [],
    parts: [],
    raw: '',
    runsOn: [],
    changes: [],
    interrupted: [],
    timer: null,
    canEdit: true,
    canRemove: false,
  };

  const openQuestion: WaitingRequest = {
    id: 'r-max',
    kind: 'question',
    text: 'Should Q4 launch target enterprise or self-serve first?',
    commit: null,
    commitUrl: null,
    images: [],
    options: [],
    link: null,
    explained: null,
    explaining: false,
    at: AT,
    agent: { id: headBase.id, name: headBase.name },
    task: { id: taskLine.id, number: taskLine.number, title: taskLine.title, department: { id: ownDeptId, name: 'Department 1' } },
    ownerPersonId: MAX_ME.person.id,
    canAnswer: true,
  };

  const turn: TurnView = {
    id: 'u-12',
    number: 12,
    title: 'Q4 Launch',
    goal: 'Ship Q4 launch plan.',
    status: 'open',
    version: null,
    commit: null,
    baseVersion: null,
    departmentId: ownDeptId,
    releases: true,
    messages: [],
    taskId: taskLine.id,
    startedAt: AT,
    openedAt: AT,
    closedAt: null,
    tasks: { total: 4, done: 1 },
  };

  return { ownDeptId, headId: headBase.id, headName: headBase.name, foreignHeadId, allAgentIds, taskLine, orgFor, headCard, openQuestion, turn };
}

test('non-CEO department owner answers head in question card, chat and terminal on a 120-agent company without blink or grey screen', async ({ page }, info) => {
  const fx = buildNorthwindFixture();
  const errors: string[] = [];
  const terminalInputs: string[] = [];
  let wsConnections = 0;
  let activeSocket: WebSocketRoute | null = null;
  let answered = false;
  let cutOffRequestsOnce = false;
  let cutOffCardOnce = false;
  let transientCard503Once = false;
  let releaseFirstOrg!: () => void;
  const firstOrgGate = new Promise<void>(resolve => {
    releaseFirstOrg = resolve;
  });
  let firstOrgPending = true;

  const events: EventView[] = [
    { seq: 1, kind: 'text', data: { text: 'Max, should Q4 launch target enterprise or self-serve first?' }, jobId: 'j1', person: null, at: AT },
  ];
  const agentState = { ready: true, reason: null, busy: true, runningJobId: 'j1', queued: 0, terminal: true, canType: true, turnRefused: null };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(installStreamAndProbe);
  page.on('pageerror', err => errors.push(err.message));

  await page.routeWebSocket(`**/api/agents/${fx.headId}/terminal*`, ws => {
    wsConnections++;
    activeSocket = ws;
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === 'input' && frame.data) {
        terminalInputs.push(frame.data);
        if (frame.data.includes('\r')) {
          ws.send(JSON.stringify({ type: 'data', data: '\r\nSTATUS-OK\r\n> ' }));
        }
      }
    });
    ws.send(JSON.stringify({ type: 'ready', write: true, message: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'TERMINAL-READY\r\n> ' }));
  });

  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const empty200 = () => ({ status: 200, contentType: 'application/json', body: '' });

  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname + url.search;
    const method = req.method();

    if (path === '/api/stream') return;
    if (path === '/api/setup') return route.fulfill(json({ needed: false }));
    if (path === '/api/me') return route.fulfill(json(MAX_ME));
    if (path === '/api/org') {
      if (firstOrgPending) await firstOrgGate;
      return route.fulfill(json(fx.orgFor(answered)));
    }
    if (path === '/api/requests') {
      if (cutOffRequestsOnce) {
        cutOffRequestsOnce = false;
        return route.fulfill(empty200());
      }
      const reqs = answered ? [] : [fx.openQuestion];
      const dec: Decisions = {
        requests: reqs,
        proposals: [],
        counts: {
          byPerson: answered ? {} : { [MAX_ME.person.id]: 1 },
          byAgent: answered ? {} : { [fx.headId]: 1 },
          total: reqs.length,
        },
      };
      return route.fulfill(json(dec));
    }
    if (method === 'POST' && path === '/api/requests/r-max') {
      answered = true;
      return route.fulfill(json({ ok: true }));
    }
    if (path === '/api/turns') return route.fulfill(json({ turns: [fx.turn] }));
    if (path === '/api/task-departments') {
      return route.fulfill(json({ whole: false, departments: [{ id: fx.ownDeptId, name: 'Department 1', templateKey: null }] }));
    }
    if (path.startsWith(`/api/tasks?`) && path.includes(`department=${fx.ownDeptId}`)) {
      return route.fulfill(json({ tasks: [{ ...fx.taskLine, status: answered ? 'working' : 'waiting' }] }));
    }
    if (path === `/api/tasks/${fx.taskLine.id}`) {
      const detail: TaskDetail = {
        echelonFindings: emptyEchelonFindings(),
        ...fx.taskLine,
        status: answered ? 'working' : 'waiting',
        body: 'Decide Q4 rollout segment for Northwind.',
        parent: null,
        after: [],
        executor: fx.taskLine.assignee,
        createdBy: { kind: 'person', id: MAX_ME.person.id, name: MAX_ME.person.name },
        subtasks: [],
        log: [{ kind: 'created', text: fx.taskLine.brief, data: {}, by: { kind: 'person', id: MAX_ME.person.id, name: MAX_ME.person.name }, at: AT }],
        requests: [{
          id: 'r-max',
          kind: 'question',
          text: fx.openQuestion.text,
          commit: null,
          status: answered ? 'answered' : 'open',
          answer: answered ? 'Enterprise first, then self-serve in November' : null,
          at: AT,
          agent: fx.taskLine.assignee,
        }],
      };
      return route.fulfill(json({ task: detail }));
    }
    if (path === `/api/agents/${fx.headId}`) {
      if (cutOffCardOnce) {
        cutOffCardOnce = false;
        return route.fulfill(empty200());
      }
      if (transientCard503Once) {
        transientCard503Once = false;
        return route.fulfill(json({ error: { code: 'unavailable', message: 'Temporary overload.' } }, 503));
      }
      return route.fulfill(json(fx.headCard));
    }
    if (path.startsWith(`/api/agents/${fx.headId}/events`)) {
      const after = Number(url.searchParams.get('after') ?? 0);
      return route.fulfill(json({ events: events.filter(e => e.seq > after), state: agentState }));
    }
    if (method === 'POST' && path === `/api/agents/${fx.headId}/messages`) {
      const body = JSON.parse(req.postData() ?? '{}') as { text?: string };
      events.push({
        seq: events.length + 1,
        kind: 'message',
        data: { text: body.text ?? '' },
        jobId: 'j1',
        person: { id: MAX_ME.person.id, name: MAX_ME.person.name },
        at: AT,
      });
      return route.fulfill(json({ queued: false }));
    }
    if (path === `/api/departments/${fx.ownDeptId}/notes`) return route.fulfill(json({ notes: [] }));
    if (path === `/api/departments/${fx.ownDeptId}/backlog`) return route.fulfill(json({ items: [] }));
    if (path === `/api/departments/${fx.ownDeptId}/work-mode`) {
      return route.fulfill(json({ departmentId: fx.ownDeptId, workMode: 'turns', canChangeWorkMode: true }));
    }
    if (path === `/api/departments/${fx.ownDeptId}/branches`) return route.fulfill(json({ branches: [], problem: null }));
    if (path === `/api/departments/${fx.ownDeptId}/briefing`) {
      return route.fulfill(json({ briefing: { text: '', repositories: [], connected: null, updatedAt: null, by: null } satisfies Briefing }));
    }
    if (path.startsWith('/api/agents/') || path.startsWith('/api/departments/') || path === '/api/settings' || path === '/api/improvements' || path === '/api/updates') {
      return route.fulfill(json(AGENT_HIDDEN, 403));
    }
    if (path === '/api/map/layout') return route.fulfill(json({ blocks: {} }));
    return route.fulfill(json({ error: { code: 'not_found', message: 'Not found.' } }, 404));
  });

  /* 1. Navigate directly to Max's department while /api/org is still in flight: no blank grey body. */
  await page.goto(`/departments/${fx.ownDeptId}`);
  await page.locator('main.body').waitFor({ state: 'attached' });
  await nextFrames(page);
  const initialProbe = await readProbe(page);
  expect(initialProbe.emptyRootFrames).toBe(0);
  expect(initialProbe.greyBodyFrames).toBe(0);
  await expect(page.locator('main.body .dview[aria-busy="true"] .dcanvas')).toBeVisible();

  firstOrgPending = false;
  releaseFirstOrg();
  const schema = page.getByRole('region', { name: 'Department schema' });
  await expect(schema).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Department 1' })).toBeVisible();
  /* Hold the visible department SVG clock on virtual time, as motion.spec.ts does. */
  await schema.locator('svg.wires').evaluate(el => (el as SVGSVGElement).pauseAnimations?.());

  /* Foreign routes return 403 to a single-department non-CEO without crashing the page. */
  const foreignStatus = await page.evaluate(async id => (await fetch(`/api/agents/${id}`)).status, fx.foreignHeadId);
  expect(foreignStatus).toBe(403);

  /* 2. Open the department head's AgentWindow and its Task side panel with the open ask_person card. */
  await page.locator('button.shead').click();
  const windowBox = page.locator('aside.orch');
  await expect(windowBox).toBeVisible();
  const chatInput = windowBox.locator(`#input-${fx.headId}`);
  await expect(chatInput).toBeVisible();

  await windowBox.getByRole('button', { name: 'Task' }).click();
  await expect(windowBox.locator('.req-question .req-text')).toHaveText(fx.openQuestion.text);

  /* 3. Type in the ask_person card while 120-agent SSE events, cut-off 200s and a transient 503 hit. */
  const answerInput = windowBox.getByRole('textbox', { name: 'Your answer' });
  await answerInput.focus();
  await answerInput.fill('Enterprise first, then self-serve in November');

  cutOffRequestsOnce = true;
  cutOffCardOnce = true;
  await emitLiveBatch(
    page,
    fx.allAgentIds.slice(0, 24).map(id => ({ type: 'context', agentId: id, used: 0.58 })),
  );
  await emitLive(page, { type: 'requests' });
  await emitLive(page, { type: 'task' });
  transientCard503Once = true;
  await emitLive(page, { type: 'working', working: 64 });
  await nextFrames(page);

  await expect(answerInput).toHaveValue('Enterprise first, then self-serve in November');
  expect(await answerInput.evaluate(el => document.activeElement === el)).toBe(true);

  const answeredResponse = page.waitForResponse(
    res => res.url().endsWith('/api/requests/r-max') && res.request().method() === 'POST',
  );
  await windowBox.getByRole('button', { name: 'Send answer' }).click();
  await answeredResponse;
  await emitLive(page, { type: 'requests' });
  await emitLive(page, { type: 'task' });
  await emitLive(page, { type: 'org' });
  await expect(windowBox.locator('.req-question')).toHaveCount(0);
  /* The task card names its state on the pill under its title. */
  await expect(windowBox.locator('.tp-state .tr-status-pill')).toHaveText('In work');

  /* 4. Type and send a message in Chat under live SSE events without losing focus or remounting. */
  await chatInput.focus();
  await page.keyboard.type('Confirmed: focus on enterprise accounts');
  await emitLiveBatch(
    page,
    fx.allAgentIds.slice(24, 40).map(id => ({ type: 'context', agentId: id, used: 0.66 })),
  );
  const replySeq = events.length + 1;
  const headAck: EventView = { seq: replySeq, kind: 'text', data: { text: 'Received, aligning the team on enterprise.' }, jobId: 'j1', person: null, at: AT };
  events.push(headAck);
  await emitLive(page, { type: 'agent_event', agentId: fx.headId, event: headAck });
  await nextFrames(page);

  expect(await chatInput.evaluate(el => document.activeElement === el)).toBe(true);
  await expect(chatInput).toHaveValue('Confirmed: focus on enterprise accounts');
  await page.keyboard.press('Enter');
  await expect(windowBox.locator('.t-log.chat')).toContainText('Confirmed: focus on enterprise accounts');

  /* 5. Switch to Terminal and type keys under SSE + terminal output + transient 503 without WS reconnect or blur. */
  await windowBox.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(windowBox.locator('.xterm-rows')).toContainText('TERMINAL-READY');
  const wsConnectionsAfterOpen = wsConnections;
  const socketAfterOpen = activeSocket;
  expect(wsConnectionsAfterOpen).toBeGreaterThanOrEqual(1);
  expect(wsConnectionsAfterOpen).toBeLessThanOrEqual(2);
  const termInput = windowBox.locator('.xterm-helper-textarea');
  await termInput.focus();
  expect(await termInput.evaluate(el => document.activeElement === el)).toBe(true);

  await page.keyboard.type('status');
  cutOffCardOnce = true;
  await emitLive(page, { type: 'task' });
  transientCard503Once = true;
  await emitLive(page, { type: 'working', working: 70 });
  await emitLiveBatch(
    page,
    fx.allAgentIds.slice(40, 60).map(id => ({ type: 'context', agentId: id, used: 0.71 })),
  );
  activeSocket!.send(JSON.stringify({ type: 'data', data: '' }));
  await page.keyboard.press('Enter');

  await expect.poll(() => terminalInputs.join('')).toBe('status\r');
  await expect(windowBox.locator('.xterm-rows')).toContainText('STATUS-OK');
  expect(await termInput.evaluate(el => document.activeElement === el)).toBe(true);

  await nextFrames(page);
  const finalProbe = await readProbe(page);
  await page.screenshot({ path: info.outputPath(`${info.project.name}-final.png`) });

  expect(wsConnections).toBe(wsConnectionsAfterOpen);
  expect(activeSocket).toBe(socketAfterOpen);
  expect(finalProbe).toEqual({
    emptyRootFrames: 0,
    greyBodyFrames: 0,
    schemaMounts: 1,
    windowMounts: 1,
    terminalMounts: 1,
    unhandledRejections: [],
  });
  expect(errors).toEqual([]);
});
