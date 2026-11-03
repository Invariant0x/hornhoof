import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { ru } from '../src/i18n/ru';
import { Shell } from '../src/screens/Shell';
import { schemaLayout, stepPaths } from '../src/screens/schema';
import { RepoSettings } from '../src/ui/RepoSettings';
import { useDepartmentTree } from '../src/tasks';
import { toD } from '../src/ui/wires';
import type { Employee, Me, Org, ProgramView } from '../src/types';
import { CARD, decisions, DEV_ORG, DEV_TREE, REVIEW_TREE, TREE_ORG, ME, mockApi, REQUESTS, ROSTER, TASK_DETAIL, TASKS } from './api-mock';
import { decl, px, rulesFor } from './css';
import { fakeStream } from './fake-stream';

/* The dots that keep running along one way of the department's schema. */
const runningDots = (tone: 'c' | 'a', d: string) =>
  [...document.querySelectorAll(`.dview circle.pt.${tone} animateMotion`)].filter(m => m.getAttribute('path') === d && m.getAttribute('repeatCount') === 'indefinite');

const EVENTS = '/api/agents/orchestrator/events?after=0';
const READY = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const DEV_TASKS = 'GET /api/tasks?status=open&department=d2';
const REPO = { url: 'https://github.com/acme/app.git', branch: 'main', tokenLast4: '1234' };
/* Lena reaches Development by its own line in her access; Kira reaches only Sales. */
const LENA = { id: 'p6', name: 'Lena', email: 'lena@acme.com', title: 'Product lead', status: 'active' as const, isOwner: false, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] } };
const listed = (id: string, name: string): Me => ({ ...ME, person: { ...ME.person, id, name, scopeKind: 'listed', isOwner: false } });

function shell(routes: Record<string, unknown> = {}, org: Org = DEV_ORG, me: Me = ME) {
  const calls = mockApi({
    'GET /api/org': [200, org],
    [`GET ${EVENTS}`]: [200, { events: [], state: READY }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={me} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function flyIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /Development/ }));
  return screen.findByRole('heading', { level: 2, name: 'Development' });
}

/* The department's tasks, or its repository, products and people, in the drawer at the left. */
const drawer = (user: ReturnType<typeof userEvent.setup>, name: 'Department tasks' | 'About the department') => user.click(screen.getByRole('button', { name }));

describe('Department view', () => {
  it('flies into a department and shows its head and members', async () => {
    const user = userEvent.setup();
    shell();
    await flyIn(user);
    const head = screen.getByRole('region', { name: 'Head' });
    expect(within(head).getByRole('button', { name: /Dana/ })).toHaveTextContent('Head of development');
    expect(within(head).getByText('working')).toBeInTheDocument();
    expect(head).toHaveTextContent('1 of 2 agents working, 1 role');
    const members = screen.getByRole('region', { name: 'Members' });
    const bruno = within(members).getByRole('button', { name: /Bruno/ });
    expect(bruno).toHaveTextContent('Claude Sonnet 5.5');
    expect(bruno).toHaveTextContent('Anthropic');
    expect(bruno).toHaveTextContent('free');
    expect(bruno).toHaveTextContent('Waiting for a new task');
    const schema = screen.getByRole('region', { name: 'Department schema' });
    expect(within(schema).getByText('Backend engineer')).toBeInTheDocument();
    expect(within(schema).getByText('1 agent')).toBeInTheDocument();
    expect(within(schema).getByText('Sasha')).toBeInTheDocument();
    await drawer(user, 'About the department');
    expect(within(screen.getByRole('region', { name: 'Products' })).getByText('Mascot')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'People with access' })).getByText('Sasha')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the map' }));
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('keeps the back button separate from the department caption plaque', async () => {
    const user = userEvent.setup();
    shell();
    const title = await flyIn(user);
    const bar = screen.getByRole('navigation', { name: 'Development' });
    const back = within(bar).getByRole('button', { name: 'Back to the map' });
    const plaque = title.closest('.crumb') as HTMLElement;
    expect(within(bar).getAllByRole('button')).toEqual([back]);
    expect(bar).not.toHaveClass('glass');
    expect(back).toHaveClass('hbtn', 'glass', 'ib');
    expect(back).toHaveAttribute('title', 'Back to the map');
    expect(back).toHaveTextContent('');
    expect(plaque).not.toBe(back);
    expect(plaque.tagName).toBe('DIV');
    expect(plaque).toHaveClass('crumb', 'glass');
    expect(plaque).toContainElement(title);
    expect(plaque).toContainElement(within(bar).getByText('CTO'));
    expect(decl('.crumb', 'cursor')).toBeUndefined();
    await user.click(within(bar).getByText('CTO'));
    expect(screen.getByRole('heading', { level: 2, name: 'Development' })).toBeInTheDocument();
    await user.click(back);
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('names an employee once when it is called after its role', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [{ ...dev!.employees[0]!, name: 'Head of development' }] }] });
    await flyIn(user);
    const head = within(screen.getByRole('region', { name: 'Head' })).getByRole('button');
    expect(head.textContent!.match(/Head of development/g)).toHaveLength(1);
  });

  it('lists the deputies who reach the department among the people with access', async () => {
    const user = userEvent.setup();
    const oleg = { id: 'p4', name: 'Oleg', email: 'oleg@acme.com', title: 'Art director', status: 'invited' as const, isOwner: false, deputy: true, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }, { id: 'd9', name: 'Design' }], teams: [] } };
    const away = { ...oleg, id: 'p5', name: 'Lena', access: { whole: false, departments: [{ id: 'd8', name: 'Sales' }, { id: 'd9', name: 'Design' }], teams: [] } };
    shell({}, { ...DEV_ORG, people: [...DEV_ORG.people, oleg, away] });
    await flyIn(user);
    await drawer(user, 'About the department');
    const people = screen.getByRole('region', { name: 'People with access' });
    expect(within(people).getAllByRole('listitem').map(li => li.querySelector('b')!.textContent)).toEqual(['Sasha', 'Oleg']);
  });

  it("opens a person's decisions from their card in the department, which shows the same count as the map", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const sasha = { ...dev!.people[0]!, pendingDecisions: 2 };
    shell({ 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: sasha.id }, { ...REQUESTS[1]!, ownerPersonId: sasha.id }])] }, { ...DEV_ORG, departments: [{ ...dev!, people: [sasha] }] });
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    const card = within(schema).getByRole('button', { name: 'Sasha: 2 decisions wait' });
    expect(card).toHaveClass('attn');
    expect(card).toHaveTextContent('2');
    await user.click(card);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Waiting for you' })).toHaveTextContent('Decisions for Sasha');
    expect(screen.queryByRole('heading', { level: 2, name: 'Development' })).not.toBeInTheDocument();
  });

  it('shows an employee start working while the department is open', async () => {
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const task = { id: 't12', number: 12, title: 'Checkout API', stage: 0, gateCount: 1, bounces: 0 };
    const busy: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => ({ ...e, state: 'working' as const, status: 'working' as const, task })) }] };
    let started = false;
    await act(async () => {
      shell({ 'GET /api/org': () => [200, started ? busy : DEV_ORG] });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Development/ }));
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Development' })).toBeInTheDocument();
    const bruno = within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ });
    expect(bruno).toHaveTextContent('free');
    expect(screen.getByText(/Work goes left to right through the gates/)).toBeInTheDocument();
    started = true;
    await act(async () => {
      stream.send({ type: 'working', working: 2 });
    });
    expect(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ })).toHaveTextContent('BrunoClaudeworkingClaude Sonnet 5.5, default effort, Anthropic#12 Checkout API');
    /* The line at the bottom says what changed last. */
    expect(screen.getByText('Bruno: working, #12 Checkout API')).toBeInTheDocument();
  });

  it("shows how full each agent's context is on its card, and follows it live", async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [{ ...dana!, context: 0.75 }, { ...bruno!, context: null }] }] });
    await flyIn(user);
    const head = screen.getByRole('region', { name: 'Head' });
    expect(within(head).getByTitle('Context 75%')).toHaveClass('bar', 'hi');
    expect(head).toHaveTextContent('Context75%');
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).queryByTitle(/^Context/)).not.toBeInTheDocument();
    stream.send({ type: 'context', agentId: 'b1', used: 0.93 });
    expect(within(members).getByTitle('Context 93%')).toHaveClass('bar', 'max');
    stream.send({ type: 'context', agentId: 'b1', used: 0.2 });
    expect(within(members).getByTitle('Context 20%')).not.toHaveClass('hi');
  });

  it("draws the line from the head to an employee blue while it works on the head's task, from card to card", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const lines = [{ upstreamAgentId: 'b0', downstreamAgentId: 'b1', working: true, workEpoch: 1, returnedEpoch: null, returnedAt: null }];
    shell({}, { ...DEV_ORG, serverNow: new Date().toISOString(), departments: [{ ...dev!, workLines: lines }] });
    await flyIn(user);
    const work = document.querySelector('.wires path[data-work="b1"]');
    /* Dashes run from inside the head's card down the bus and the role's spine into the employee's, with two dots on them. */
    expect(work).toHaveClass('tr', 'live', 'c');
    const d = toD(stepPaths(schemaLayout(dev!, 1)).toMember('b1')!);
    expect(work!.getAttribute('d')).toBe(d);
    expect(runningDots('c', d)).toHaveLength(2);
  });

  it('turns the line yellow over its whole length when the employee gave a result back, for what is left of five minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const [dev] = DEV_ORG.departments;
    const now = Date.now();
    const lines = [{ upstreamAgentId: 'b0', downstreamAgentId: 'b1', working: false, workEpoch: 4, returnedEpoch: 4, returnedAt: new Date(now - 4.5 * 60_000).toISOString() }];
    shell({}, { ...DEV_ORG, serverNow: new Date(now).toISOString(), departments: [{ ...dev!, workLines: lines }] });
    await flyIn(user);
    const work = () => document.querySelector('.wires path[data-work="b1"]');
    /* Amber dashes and dots run back up, from the employee's card to the head's. */
    expect(work()).toHaveClass('tr', 'live', 'a');
    const back = [...stepPaths(schemaLayout(dev!, 1)).toMember('b1')!].reverse();
    expect(work()!.getAttribute('d')).toBe(toD(back));
    expect(runningDots('a', toD(back))).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(work()).toBeNull();
  });

  it('runs a dot once along the way a message between two of its agents took, and leaves no way running', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    shell();
    await flyIn(user);
    vi.useFakeTimers();
    try {
      stream.send({ type: 'pulse', from: { kind: 'agent', id: 'b0', departmentId: dev!.id }, to: { kind: 'agent', id: 'b1', departmentId: dev!.id } });
      /* Another department's agents are not this one's. */
      stream.send({ type: 'pulse', from: { kind: 'agent', id: 'x0', departmentId: 'other' }, to: { kind: 'agent', id: 'x1', departmentId: 'other' } });
      const dots = [...document.querySelectorAll('.dview circle.pt animateMotion')];
      expect(dots.map(m => [m.getAttribute('path'), m.getAttribute('repeatCount')])).toEqual([[toD(stepPaths(schemaLayout(dev!, 1)).toMember('b1')!), '1']]);
      act(() => vi.advanceTimersByTime(10_000));
      expect(document.querySelectorAll('.dview circle.pt, .dview .wires path.live')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when a gate sent work back, without an amber dot that would look like a result given back', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    const qa = { id: 'DEV-QA', title: { en: 'Test engineer', ru: 'Тестировщик' }, description: { en: 'Tests.', ru: 'Тестирует.' }, kind: 'member' as const, gate: 1 };
    const task = { id: 't1', number: 1, title: 'Checkout', stage: 1, gateCount: 1, bounces: 0 };
    const before: Org = {
      ...DEV_ORG,
      departments: [{ ...dev!, roles: [...dev!.roles, qa], employees: [dana!, { ...bruno!, status: 'handed', task }, { ...bruno!, id: 'q1', name: 'Quinn', roleId: 'DEV-QA', status: 'queued', task }] }],
    };
    const after: Org = {
      ...DEV_ORG,
      departments: [{ ...before.departments[0]!, employees: [dana!, { ...bruno!, status: 'working', task: { ...task, stage: 0, bounces: 1 } }, before.departments[0]!.employees[2]!] }],
    };
    let back = false;
    shell({ 'GET /api/org': () => [200, back ? after : before] });
    await flyIn(user);
    back = true;
    stream.send({ type: 'task', id: 't1' });
    expect(await screen.findByText('Bruno: work came back for rework')).toBeInTheDocument();
    expect(document.querySelectorAll('.dview circle.pt.a')).toHaveLength(0);
  });

  it('shows how hard each employee thinks next to its model', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [dana!, { ...bruno!, effort: 'max' }] }] });
    await flyIn(user);
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByRole('button', { name: /Bruno/ })).toHaveTextContent('Claude Sonnet 5.5, max effort, Anthropic');
  });

  it('says default effort for an employee whose level Hornhoof does not know', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [dana!, { ...bruno!, effort: null }] }] });
    await flyIn(user);
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByRole('button', { name: /Bruno/ })).toHaveTextContent('Claude Sonnet 5.5, default effort, Anthropic');
  });

  it('says how often an employee on a timer wakes, when it holds no task', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const [dana, bruno] = dev!.employees;
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [dana!, { ...bruno!, timer: 10 }] }] });
    await flyIn(user);
    const members = screen.getByRole('region', { name: 'Members' });
    expect(within(members).getByRole('button', { name: /Bruno/ })).toHaveTextContent('On a timer, every 10 minutes');
  });

  it('refetches what employees do when their tasks move', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const task = { id: 't12', number: 12, title: 'Checkout API', stage: 1, gateCount: 1, bounces: 0 };
    const waits: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => (e.id === 'b1' ? { ...e, status: 'waiting' as const, task } : e)) }] };
    let asked = false;
    shell({ 'GET /api/org': () => [200, asked ? waits : DEV_ORG] });
    await flyIn(user);
    asked = true;
    stream.send({ type: 'requests' });
    await vi.waitFor(() => expect(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ })).toHaveTextContent('needs a decision'));
  });

  it("keeps an employee's whole name on its chip, and lets the state give way when the row is short", () => {
    /* The name does not shrink below its own width, and takes at most part of the row; the state takes what is left
       and ends in an ellipsis when that is too little. */
    expect(decl('.schip .mn', 'flex')).toMatch(/^\d+ 0 /);
    expect(decl('.schip .mn', 'max-width')).toBeDefined();
    expect(decl('.schip .st', 'flex')).toMatch(/^0 1 /);
    expect(decl('.schip .st', 'min-width')).toBe('0');
    expect(decl('.schip .st', 'overflow')).toBe('hidden');
    expect(decl('.schip .st', 'text-overflow')).toBe('ellipsis');
    expect(decl('.schip .st', 'white-space')).toBe('nowrap');
  });

  it("says what an employee waits for in a few words that fit next to its name, in both languages", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const waits: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => (e.id === 'b1' ? { ...e, status: 'waiting' as const } : e)) }] };
    shell({}, waits);
    await flyIn(user);
    const bruno = within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ });
    expect(bruno.querySelector('.st')).toHaveTextContent(/^needs a decision$/);
    expect(bruno.querySelector('.st')).toHaveAttribute('title', 'needs a decision');
    expect(ru.dept.status.waiting).toBe('ждет решения');
  });

  it('keeps the department actions in the free strip after the zoom while a window, card or task is open', () => {
    /* Windows, cards and tasks end above the strip at the bottom where the zoom and the actions sit, so the actions
       stay there, right after the zoom, at every width a window leaves beside them; on a phone the window covers all. */
    const strip = px(decl('.dv-acts', 'bottom')) + px(decl('.hbtn', 'height'));
    for (const panel of ['.orch', '.acard']) expect(px(decl(panel, 'bottom'))).toBeGreaterThan(strip);
    for (const kind of ['window', 'card', 'task'])
      expect(rulesFor(`.body.with-${kind} .dv-acts`).map(r => [r.media, r.decls.left, r.decls.right, r.decls.bottom])).toEqual([
        ['(min-width: 761px)', decl('.dview .ticker', 'left'), 'auto', undefined],
      ]);
  });

  it('lays out the gates after the work, the way back from them and the report to the head', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const rita = { ...dev!.employees[1]!, id: 'b2', name: 'Rita', roleId: 'DEV-REV', title: { en: 'Code reviewer', ru: 'Ревьюер кода' } };
    const reviewer = { id: 'DEV-REV', title: rita.title, description: { en: 'Reviews every change.', ru: 'Смотрит каждое изменение.' }, kind: 'member' as const, gate: 1 };
    shell({}, { ...DEV_ORG, departments: [{ ...dev!, employees: [...dev!.employees, rita], roles: [...dev!.roles, reviewer] }] });
    await flyIn(user);
    const schema = screen.getByRole('region', { name: 'Department schema' });
    expect(within(schema).getByText('Code reviewer')).toBeInTheDocument();
    expect(within(schema).getByText('last gate')).toBeInTheDocument();
    expect(within(schema).queryByText('Sent back for rework')).not.toBeInTheDocument();
    expect(schema.querySelectorAll('.wires .rl, .wires .rah')).toHaveLength(0);
    expect(within(schema).getByText('Report to the head')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Head' })).toHaveTextContent('1 of 3 agents working, 2 roles, 1 gate');
  });

  it('shows a real rework for the remaining ten minutes, including after reloading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const [dev] = DEV_ORG.departments;
    const reviewer = { ...dev!.roles[1]!, id: 'DEV-REV', kind: 'member' as const, gate: 1 };
    const rita = { ...dev!.employees[1]!, id: 'b2', name: 'Rita', roleId: 'DEV-REV' };
    const at = Date.now();
    const org = { ...DEV_ORG, serverNow: new Date(at).toISOString(), departments: [{ ...dev!, reworkAt: new Date(at - 9 * 60_000).toISOString(), roles: [...dev!.roles, reviewer], employees: [...dev!.employees, rita] }] };
    shell({}, org);
    await flyIn(user);
    expect(screen.getByText('Sent back for rework')).toBeVisible();
    expect(document.querySelectorAll('.dview .wires .rl').length).toBeGreaterThan(0);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.queryByText('Sent back for rework')).not.toBeInTheDocument();
    expect(document.querySelectorAll('.dview .wires .rl, .dview .wires .rah')).toHaveLength(0);
  });

  it('hires through the orchestrator', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/agents/orchestrator/messages': [202, { jobId: 'j9' }] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByRole('complementary', { name: 'Orchestrator' })).toBeInTheDocument();
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/agents/orchestrator/messages')?.body).toEqual({ text: 'Staff the Development department.' }));
    expect(calls.filter(c => c.path === '/api/agents/orchestrator/messages')).toHaveLength(1);
  });

  it('shows the hand-made roster when he cannot answer', async () => {
    const user = userEvent.setup();
    const calls = shell({
      [`GET ${EVENTS}`]: [200, { events: [], state: { ...READY, ready: false, reason: 'no_subscription' } }],
      'GET /api/departments/d2/roster': [200, ROSTER],
    });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: '+ Hire' }));
    expect(await screen.findByText('Hiring for Development')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Head of development/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Hire (2)' })).toBeEnabled();
    expect(screen.queryByText('Company structure')).not.toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/agents/orchestrator/messages')).toBe(false);
  });

  it("opens an employee's window from the department, with its card one click away", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/b1': [200, CARD], 'GET /api/agents/b1/events?after=0': [200, { events: [], state: READY }] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Card' }));
    expect(await screen.findByRole('button', { name: 'Open terminal' })).toBeInTheDocument();
  });

  it("goes from an employee's card back to its window with Open terminal", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/b1': [200, CARD], 'GET /api/agents/b1/events?after=0': [200, { events: [], state: READY }] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    await user.click(await screen.findByRole('button', { name: 'Card' }));
    await user.click(await screen.findByRole('button', { name: 'Open terminal' }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open terminal' })).not.toBeInTheDocument();
  });

  it("opens a head's department notebook from its window", async () => {
    const user = userEvent.setup();
    const DANA_CARD = { ...CARD, id: 'b0', name: 'Dana', kind: 'head' };
    const calls = shell({
      'GET /api/agents/b0': [200, DANA_CARD],
      'GET /api/agents/b0/events?after=0': [200, { events: [], state: READY }],
      'GET /api/departments/d2/notebook': [200, { notes: [{ number: 2, text: 'Review every merge.', by: { kind: 'agent', id: 'b0', name: 'Dana' }, updatedAt: '2026-10-31T02:00:00Z' }] }],
    });
    await flyIn(user);
    await user.click(document.querySelector<HTMLButtonElement>('button.shead')!);
    await user.click(await screen.findByRole('button', { name: 'Notebook' }));
    const list = await screen.findByRole('list', { name: 'Notebook' });
    expect(list).toHaveTextContent('#2Review every merge.Dana');
    expect(screen.getByText(/What the head of this department remembers/)).toBeInTheDocument();
    expect(calls.some(c => c.path === '/api/notebook')).toBe(false);
  });

  it('switches an employee off from its chip without opening it', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'PATCH /api/agents/b1': [200, { ...CARD, on: false }] });
    await flyIn(user);
    const tick = screen.getByRole('checkbox', { name: 'Bruno is on' });
    expect(tick).toBeChecked();
    await user.click(tick);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH' && c.path === '/api/agents/b1')?.body).toEqual({ on: false }));
    expect(tick).not.toBeChecked();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.getByText('Bruno: switched off')).toBeInTheDocument();
  });

  it("switches a whole role off from its frame, so its people get no work", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const boris = { ...dev!.employees[1]!, id: 'b2', name: 'Boris', on: false };
    const two: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: [...dev!.employees, boris] }] };
    const calls = shell({ 'PATCH /api/agents/b1': [200, { ...CARD, on: false }] }, two);
    await flyIn(user);
    const role = screen.getByRole('checkbox', { name: 'Backend engineer takes part in the work' });
    expect(role).toBeChecked();
    await user.click(role);
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PATCH' && c.path === '/api/agents/b1')?.body).toEqual({ on: false }));
    /* Boris was off already. */
    expect(calls.some(c => c.method === 'PATCH' && c.path === '/api/agents/b2')).toBe(false);
    expect(role).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Bruno is on' })).not.toBeChecked();
    expect(screen.getByText('Backend engineer: everyone switched off')).toBeInTheDocument();
  });

  it('switches every one of a role on from its frame', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const boris = { ...dev!.employees[1]!, id: 'b2', name: 'Boris', on: false };
    const off: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: [dev!.employees[0]!, { ...dev!.employees[1]!, on: false }, boris] }] };
    const calls = shell({ 'PATCH /api/agents/b1': [200, CARD], 'PATCH /api/agents/b2': [200, CARD] }, off);
    await flyIn(user);
    const role = screen.getByRole('checkbox', { name: 'Backend engineer takes part in the work' });
    expect(role).not.toBeChecked();
    await user.click(role);
    await vi.waitFor(() => expect(calls.filter(c => c.method === 'PATCH').map(c => [c.path, c.body])).toEqual([
      ['/api/agents/b1', { on: true }],
      ['/api/agents/b2', { on: true }],
    ]));
    expect(role).toBeChecked();
    expect(await screen.findByText('Backend engineer: everyone on')).toBeInTheDocument();
  });

  it('shows an employee that is off as switched off', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const off: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => (e.id === 'b1' ? { ...e, on: false } : e)) }] };
    shell({}, off);
    await flyIn(user);
    expect(screen.getByRole('checkbox', { name: 'Bruno is on' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: /Bruno/ })).toHaveTextContent('Switched off');
  });

  it('marks the head and each employee with the program they work in', async () => {
    const user = userEvent.setup();
    shell({});
    await flyIn(user);
    expect(within(screen.getByRole('button', { name: /Bruno/ })).getByRole('img', { name: 'Claude' })).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Dana/ })).getByRole('img', { name: 'Claude' })).toBeInTheDocument();
  });

  it("lists the department's open tasks and opens one at the side", async () => {
    const user = userEvent.setup();
    shell({ [DEV_TASKS]: [200, { tasks: TASKS }], 'GET /api/tasks/t12': [200, { task: TASK_DETAIL }] });
    await flyIn(user);
    await drawer(user, 'Department tasks');
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    const row = await within(tasks).findByRole('button', { name: /#12 Checkout API/ });
    expect(row).toHaveTextContent('Gate 2 of 3');
    expect(within(tasks).getAllByRole('button', { name: /^#/ }).map(b => b.querySelector('b')!.textContent)).toEqual(['#9', '#12', '#11']);
    await user.click(row);
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
  });

  it("closes a task opened from the department's tasks before them, on separate Escapes", async () => {
    const user = userEvent.setup();
    shell({ [DEV_TASKS]: [200, { tasks: TASKS }], 'GET /api/tasks/t12': [200, { task: TASK_DETAIL }] });
    await flyIn(user);
    await drawer(user, 'Department tasks');
    await user.click(await within(screen.getByRole('region', { name: 'Tasks' })).findByRole('button', { name: /#12 Checkout API/ }));
    await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Tasks' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  it('names an assignee once when it is called after its role', async () => {
    const user = userEvent.setup();
    const head = { id: 'b0', name: 'Head of development', kind: 'head' as const, role: { en: 'Head of development', ru: 'Руководитель разработки' } };
    shell({ [DEV_TASKS]: [200, { tasks: [{ ...TASKS[2]!, assignee: head }] }] });
    await flyIn(user);
    await drawer(user, 'Department tasks');
    const row = await within(screen.getByRole('region', { name: 'Tasks' })).findByRole('button', { name: /#9/ });
    expect(row.textContent!.match(/Head of development/g)).toHaveLength(1);
  });

  it('gives the department a task through its head', async () => {
    const user = userEvent.setup();
    const made = { ...TASK_DETAIL, id: 't14', number: 14, title: 'Refund API' };
    const calls = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'POST /api/tasks': [201, { task: made }], 'GET /api/tasks/t14': [200, { task: made }] });
    await flyIn(user);
    await drawer(user, 'Department tasks');
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    expect(await within(tasks).findByText('No open tasks.')).toBeInTheDocument();
    await user.click(within(tasks).getByRole('button', { name: 'New task' }));
    expect(within(tasks).getByText('Dana, the head, gets it and splits it among the department.')).toBeInTheDocument();
    await user.type(within(tasks).getByLabelText('Title'), 'Refund API');
    await user.type(within(tasks).getByLabelText('In one line'), 'Give the money back.');
    await user.type(within(tasks).getByLabelText('Details'), 'Card payments only.');
    await user.selectOptions(within(tasks).getByLabelText('Product'), 'pd1');
    await user.click(within(tasks).getByRole('button', { name: 'Create task' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'POST' && c.path === '/api/tasks')?.body).toEqual({ title: 'Refund API', brief: 'Give the money back.', body: 'Card payments only.', department: 'd2', product: 'pd1' }),
    );
    expect(await screen.findByRole('complementary', { name: '#14 Refund API' })).toBeInTheDocument();
    expect(within(tasks).queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('says the head gets a new task without naming it twice when it is called after its role', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell({ [DEV_TASKS]: [200, { tasks: [] }] }, { ...DEV_ORG, departments: [{ ...dev!, employees: [{ ...dev!.employees[0]!, name: 'Head of development' }] }] });
    await flyIn(user);
    await drawer(user, 'Department tasks');
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    await user.click(await within(tasks).findByRole('button', { name: 'New task' }));
    expect(within(tasks).getByText('The head gets it and splits it among the department.')).toBeInTheDocument();
  });

  it('asks for a head before the department takes tasks', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell({ [DEV_TASKS]: [200, { tasks: [] }] }, { ...DEV_ORG, departments: [{ ...dev!, employees: [] }] });
    await flyIn(user);
    await drawer(user, 'Department tasks');
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    expect(within(tasks).getByText('Tasks go to the department through its head. Hire one first.')).toBeInTheDocument();
    expect(within(tasks).queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('lets a person whose access lists the department give it tasks', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell({ [DEV_TASKS]: [200, { tasks: [] }] }, { ...DEV_ORG, departments: [{ ...dev!, people: [...dev!.people, LENA] }] }, listed('p6', 'Lena'));
    await flyIn(user);
    await drawer(user, 'Department tasks');
    expect(within(screen.getByRole('region', { name: 'Tasks' })).getByRole('button', { name: 'New task' })).toBeInTheDocument();
    await drawer(user, 'About the department');
    expect(screen.queryByRole('region', { name: 'Repository' })).not.toBeInTheDocument();
  });

  it("keeps a department's tasks from people who do not reach it", async () => {
    const user = userEvent.setup();
    const calls = shell({}, DEV_ORG, listed('p7', 'Kira'));
    await flyIn(user);
    expect(screen.queryByRole('button', { name: 'Department tasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(calls.some(c => c.path.startsWith('/api/tasks?'))).toBe(false);
  });

  it('shows and changes the repository for people who see the whole company', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, branch: 'develop' } }], 'DELETE /api/departments/d2/repository': [204] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: REPO }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repository' });
    expect(repo).toHaveTextContent('https://github.com/acme/app.git');
    expect(repo).toHaveTextContent('Branch main');
    expect(repo).toHaveTextContent('Token ending in 1234');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    expect(within(repo).getByLabelText('Address')).toHaveValue('https://github.com/acme/app.git');
    expect(within(repo).getByLabelText('Token')).toHaveAttribute('type', 'password');
    expect(within(repo).getByLabelText('Token')).toHaveValue('');
    const branch = within(repo).getByLabelText('Branch');
    await user.clear(branch);
    await user.type(branch, 'develop');
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'develop' }));
    expect(within(repo).queryByLabelText('Branch')).not.toBeInTheDocument();
    await user.click(within(repo).getByRole('button', { name: 'Remove' }));
    await user.click(within(repo).getByRole('button', { name: 'Yes, remove' }));
    await vi.waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/api/departments/d2/repository')).toBe(true));
  });

  it('says how much free memory a test run of the repository needs, and changes it', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, testMemoryGb: 8 } }] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: { ...REPO, testMemoryGb: 4 } }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repository' });
    expect(repo).toHaveTextContent('A test run needs a machine with 4 GB of free memory');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    const memory = within(repo).getByLabelText('Free memory for a test run, GB');
    expect(memory).toHaveValue(4);
    await user.clear(memory);
    await user.type(memory, '8');
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', testMemoryGb: 8 }));
  });

  it("suggests a commit author's name in the person's language", async () => {
    const user = userEvent.setup();
    localStorage.setItem('hh-lang', 'ru');
    try {
      render(
        <LanguageProvider>
          <RepoSettings placeId="d2" repository={null} />
        </LanguageProvider>,
      );
      await user.click(screen.getByRole('button', { name: 'Добавить репозиторий' }));
      expect(screen.getByLabelText('Автор коммитов')).toHaveAttribute('placeholder', 'Анна Смирнова');
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it("names who the agents' commits are by once both fields are filled", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const author = { name: 'Ivan Korol', email: 'ivan@acme.dev' };
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, author } }] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: REPO }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repository' });
    expect(repo).not.toHaveTextContent('Commits as');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    await user.type(within(repo).getByLabelText('Commit author'), 'Ivan Korol');
    expect(within(repo).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(within(repo).getByLabelText('Author email'), 'ivan@acme.dev');
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', author }));
  });

  it("shows who the agents' commits are by, and takes the name away when both fields are empty", async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    const calls = shell(
      { [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/d2/repository': [200, { repository: { ...REPO, author: null } }] },
      { ...DEV_ORG, departments: [{ ...dev!, repository: { ...REPO, author: { name: 'Ivan Korol', email: 'ivan@acme.dev' } } }] },
    );
    await flyIn(user);
    await drawer(user, 'About the department');
    const repo = screen.getByRole('region', { name: 'Repository' });
    expect(repo).toHaveTextContent('Commits as Ivan Korol <ivan@acme.dev>');
    await user.click(within(repo).getByRole('button', { name: 'Change' }));
    expect(within(repo).getByLabelText('Commit author')).toHaveValue('Ivan Korol');
    await user.clear(within(repo).getByLabelText('Commit author'));
    await user.clear(within(repo).getByLabelText('Author email'));
    await user.click(within(repo).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ url: 'https://github.com/acme/app.git', branch: 'main', author: null }));
  });

  it("gives a product its own repository with a token", async () => {
    const user = userEvent.setup();
    const calls = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/pd1/repository': [200, { repository: REPO }] });
    await flyIn(user);
    await drawer(user, 'About the department');
    const products = screen.getByRole('region', { name: 'Products' });
    expect(within(screen.getByRole('region', { name: 'Repository' })).getByText('No repository yet. Agents work in empty folders.')).toBeInTheDocument();
    await user.click(within(products).getByRole('button', { name: 'Add repository' }));
    await user.type(within(products).getByLabelText('Address'), 'https://github.com/acme/mascot.git');
    await user.type(within(products).getByLabelText('Token'), 'ghp_mascot5678');
    await user.click(within(products).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(calls.find(c => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/api/departments/pd1/repository', body: { url: 'https://github.com/acme/mascot.git', branch: 'main', token: 'ghp_mascot5678' } }),
    );
  });
});

const TREE_PATH = '/api/departments/d2/tree';
const treeRoute = (tree = DEV_TREE): Record<string, [number, unknown]> => ({ [`GET ${TREE_PATH}`]: [200, { tree }] });

async function showTree(user: ReturnType<typeof userEvent.setup>) {
  await flyIn(user);
  await user.click(screen.getByRole('button', { name: 'Tree' }));
  return screen.findByRole('group', { name: 'Tree of turn 3' });
}

describe('Department work tree', () => {
  it.each([375, 1440])('shows an external event reason and deadline as a calm wait at %ipx', async width => {
    vi.stubGlobal('innerWidth', width);
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const user = userEvent.setup();
    const externalWait = { reason: 'Image build', since: '2026-10-30T14:00:00.000Z', until: '2026-10-30T14:50:00.000Z' };
    const line = { ...DEV_TREE.lines[0]!, mergedAt: null, doneAt: null, externalWait, waitsFor: [],
      segments: [{ kind: 'after' as const, from: externalWait.since, to: null, externalWait }] };
    shell(treeRoute({ ...DEV_TREE, lines: [line] }), TREE_ORG);
    const graph = await showTree(user);
    const label = within(document.querySelector('.tv-labs') as HTMLElement).getByRole('button', { name: /Bruno/ });
    expect(label).toHaveTextContent('waits: Image build, until 14:50');
    expect(label.querySelector('.ast')).not.toHaveClass('alarm');
    await user.click(graph.querySelector('[data-row="b1"]')!);
    const card = screen.getByRole('dialog', { name: /42/ });
    expect(within(card).getByText('waits: Image build, until 14:50', { exact: true })).not.toHaveClass('bad');
  });

  it.each([
    { kind: 'lost', program: { state: 'idle', since: Date.parse(DEV_TREE.turn!.startedAt), tool: null }, text: 'turn end lost since 09:00: waiting for input', red: true },
    { kind: 'alarm', alarm: { reason: 'program_stalled', since: Date.parse(DEV_TREE.turn!.startedAt) }, text: 'program frozen since 09:00', red: true },
    { kind: 'queued', waitsForAgent: { id: 'head', name: 'Hana' }, text: 'waits for Hana since 09:00', red: false },
    { kind: 'unknown', text: 'no data', red: false },
  ] as const)('shows $kind with its cause and time in the task card and keeps its timeline distinct', async state => {
    const user = userEvent.setup();
    const segment = { ...state, from: DEV_TREE.turn!.startedAt, to: null };
    const line = { ...DEV_TREE.lines[0]!, mergedAt: null, doneAt: null, createdAt: segment.from, cutAt: segment.from, segments: [segment] };
    shell(treeRoute({ ...DEV_TREE, lines: [line] }), TREE_ORG);
    const graph = await showTree(user);
    await user.click(graph.querySelector('[data-row="b1"]')!);
    const card = screen.getByRole('dialog', { name: /42/ });
    const status = within(card).getByText(state.text, { exact: true });
    expect(status).toBeInTheDocument();
    expect(status.classList.contains('bad')).toBe(state.red);
    expect(graph.querySelector('.seg')).toHaveClass({ lost: 'ls', alarm: 'al', queued: 'q', unknown: 'u' }[state.kind]!);
  });

  it('shows interrupted time, queued message time and missing data separately in Speed', async () => {
    const user = userEvent.setup();
    const tree = { ...DEV_TREE, time: [{ agent: DEV_TREE.lines[0]!.agent, work: 2400, after: 0, person: 0, stall: 0, lost: 15749, alarm: 0, queued: 29950, unknown: 60 }] };
    shell(treeRoute(tree), TREE_ORG);
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    const speed = screen.getByRole('complementary', { name: 'Speed' });
    await within(speed).findByText('Interrupted', { exact: true });
    expect(within(speed).getByText('Queued', { selector: '.sum dt' })).toBeInTheDocument();
    expect(within(speed).getByText('No data', { selector: '.sum dt' })).toBeInTheDocument();
    expect(speed.querySelector('.sum')).toHaveTextContent('4 h 22 min');
    expect(speed.querySelector('.sum')).toHaveTextContent('8 h 19 min');
  });

  it.each(['develop', undefined])('names the trunk and its card for repository branch %s', async branch => {
    const user = userEvent.setup();
    const departments = TREE_ORG.departments.map(d => ({
      ...d,
      repository: branch ? { ...REPO, branch } : undefined,
    }));
    shell(treeRoute(), { ...TREE_ORG, departments });
    const graph = await showTree(user);
    const name = branch ?? 'main';
    const labels = document.querySelector('.tv-labs') as HTMLElement;
    expect(within(labels).getByRole('button', { name })).toHaveClass('lchip');
    await user.click(within(graph).getByRole('button', { name }));
    const card = screen.getByRole('dialog', { name });
    expect(within(card).getByRole('heading', { level: 4, name })).toBeInTheDocument();
  });

  it.each(['tree', 'speed'])('closes a card opened from %s before Speed on separate Escapes', async source => {
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    const graph = source === 'tree' ? await showTree(user) : null;
    if (!graph) await flyIn(user);
    const button = screen.getByRole('button', { name: 'Speed' });
    await user.click(button);
    const speed = screen.getByRole('complementary', { name: 'Speed' });
    const row = await within(speed).findByRole('button', { name: /Bruno/ });
    await user.click(graph ? graph.querySelector('[data-row="b1"]')! : row);
    expect(await screen.findByRole('dialog', { name: /42/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(speed).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Speed' })).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('places named square icons first, swaps the schema, and keeps focus on Map', async () => {
    const user = userEvent.setup();
    const calls = shell(treeRoute(), TREE_ORG);
    await flyIn(user);
    const tree = screen.getByRole('button', { name: 'Tree' });
    const speed = screen.getByRole('button', { name: 'Speed' });
    expect([...tree.parentElement!.children].slice(0, 3)).toEqual([tree, speed, screen.getByRole('button', { name: 'Department tasks' })]);
    for (const button of [tree, speed]) {
      expect(button).toHaveClass('hbtn', 'glass', 'ib');
      expect(button).toHaveAttribute('title', button.getAttribute('aria-label'));
      expect(button).toHaveTextContent('');
    }
    expect(tree).not.toHaveAttribute('aria-pressed');
    await user.click(tree);
    await screen.findByRole('group', { name: 'Tree of turn 3' });
    expect(screen.queryByRole('region', { name: 'Department schema' })).not.toBeInTheDocument();
    expect(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Map' })).toHaveFocus();
    expect(calls.filter(c => c.path === TREE_PATH)).toHaveLength(1);
    await user.click(tree);
    expect(screen.getByRole('region', { name: 'Department schema' })).toBeInTheDocument();
  });

  it('closes Speed with X, its button and Escape, keeping its open appearance', async () => {
    const user = userEvent.setup();
    shell(treeRoute());
    await flyIn(user);
    const speed = screen.getByRole('button', { name: 'Speed' });
    for (const close of ['x', 'button', 'escape']) {
      await user.click(speed);
      const panel = screen.getByRole('complementary', { name: 'Speed' });
      expect(panel).toHaveClass('dv-drawer', 'spd', 'right');
      expect(within(panel).getByText('Speed', { selector: 'b' })).toBeInTheDocument();
      expect(speed).toHaveClass('on');
      expect(speed).toHaveAttribute('aria-expanded', 'true');
      if (close === 'x') await user.click(within(panel).getByRole('button', { name: 'Close' }));
      if (close === 'button') await user.click(speed);
      if (close === 'escape') await user.keyboard('{Escape}');
      expect(screen.queryByRole('complementary', { name: 'Speed' })).not.toBeInTheDocument();
      expect(speed).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('places Speed on the left while an agent card covers the right', async () => {
    const user = userEvent.setup();
    shell({ ...treeRoute(), 'GET /api/agents/b1/card': [200, CARD] });
    await flyIn(user);
    await user.click(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ }));
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    expect(screen.getByRole('complementary', { name: 'Speed' })).not.toHaveClass('right');
  });

  it.each(['tab', 'back'])('resets the tree and drawer when leaving through %s', async way => {
    const user = userEvent.setup();
    shell({ ...treeRoute(), 'GET /api/tasks?status=open': [200, { tasks: [] }], 'GET /api/turns': [200, { turns: [] }] });
    await showTree(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    if (way === 'back') await user.click(screen.getByRole('button', { name: 'Back to the map' }));
    else {
      await user.click(screen.getByRole('button', { name: 'Tasks' }));
      await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Map' }));
    }
    if (!screen.queryByRole('heading', { level: 2, name: 'Development' })) await flyIn(user);
    expect(screen.getByRole('region', { name: 'Department schema' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Speed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tree' })).toBeInTheDocument();
  });

  it('opens a line card and its task, and closes the card on Escape or outside clicks', async () => {
    const user = userEvent.setup();
    shell({ ...treeRoute(), 'GET /api/tasks/b42': [200, { task: { ...TASK_DETAIL, id: 'b42', number: 42 } }] }, TREE_ORG);
    const tree = await showTree(user);
    await user.click(tree.querySelector('[data-row="b1"]')!);
    let card = screen.getByRole('dialog', { name: /42/ });
    expect(card).toHaveClass('tv-card');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /42/ })).not.toBeInTheDocument();
    await user.click(tree.querySelector('[data-row="b1"]')!);
    await user.click(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Map' }));
    expect(screen.queryByRole('dialog', { name: /42/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tree' }));
    const next = await screen.findByRole('group', { name: 'Tree of turn 3' });
    await user.click(next.querySelector('[data-row="b1"]')!);
    card = screen.getByRole('dialog', { name: /42/ });
    await user.click(within(card).getByRole('button', { name: 'Open the task' }));
    expect(await screen.findByRole('heading', { name: /#42/ })).toBeInTheDocument();
  });

  it('shows whole-turn totals, opens a card from Speed, and lists open idle stretches first', async () => {
    const user = userEvent.setup();
    shell(treeRoute(), TREE_ORG);
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: 'Speed' }));
    const speed = screen.getByRole('complementary', { name: 'Speed' });
    await within(speed).findByRole('button', { name: /Bruno/ });
    expect(speed.querySelectorAll('.sum dd')).toHaveLength(6);
    await user.click(within(speed).getByRole('button', { name: /Bruno/ }));
    await screen.findByRole('group', { name: 'Tree of turn 3' });
    expect(screen.getByRole('dialog', { name: /42/ })).toBeInTheDocument();
    await user.click(within(speed).getByRole('tab', { name: 'Idle' }));
    const idle = [...speed.querySelectorAll('.idle')];
    expect(idle.slice(0, 3).every(e => e.textContent!.includes('still going'))).toBe(true);
    expect(idle[3]).toHaveTextContent('Timur');
  });

  it('runs a dot only with motion enabled, and uses 1.25 minute zoom steps', async () => {
    const user = userEvent.setup();
    shell(treeRoute());
    await showTree(user);
    expect(document.querySelector('.tview animateMotion')).toBeInTheDocument();
    await user.click(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Zoom in' }));
    expect(document.querySelector('.dview .zoom')).toHaveTextContent('125%');
    await user.click(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Show everything' }));
    expect(document.querySelector('.dview .zoom')).toHaveTextContent('100%');
  });

  it('does not run a live dot under reduced motion', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    const user = userEvent.setup();
    shell(treeRoute());
    await showTree(user);
    expect(document.querySelector('.tview animateMotion')).not.toBeInTheDocument();
  });

  it('reloads for this department or its parent, and ignores tasks elsewhere', async () => {
    const stream = fakeStream();
    const user = userEvent.setup();
    const calls = shell(treeRoute());
    await showTree(user);
    const count = () => calls.filter(c => c.path === TREE_PATH).length;
    stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'other' } });
    await act(async () => {});
    expect(count()).toBe(1);
    stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'd2' } });
    await waitFor(() => expect(count()).toBe(2));
    stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'product', parentId: 'd2' } });
    await waitFor(() => expect(count()).toBe(3));
  });

  it('refreshes every minute only while the tree data is on', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const calls = mockApi(treeRoute());
    const { rerender, unmount } = renderHook(({ on }) => useDepartmentTree('d2', on), { initialProps: { on: true } });
    await act(async () => {});
    expect(calls).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(calls).toHaveLength(2);
    rerender({ on: false });
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(calls).toHaveLength(2);
    unmount();
  });

  it('names the buttons and explains a missing turn in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const user = userEvent.setup();
    shell(treeRoute({ ...DEV_TREE, turn: null }));
    await user.click(await screen.findByRole('button', { name: /Разработка/ }));
    await user.click(screen.getByRole('button', { name: 'Дерево' }));
    expect(await screen.findByText('Сейчас нет открытого хода.')).toBeInTheDocument();
    expect(within(document.querySelector('.dview') as HTMLElement).getByRole('button', { name: 'Карта' })).toHaveAttribute('title', 'Карта');
    expect(screen.getByRole('button', { name: 'Скорость' })).toHaveAttribute('title', 'Скорость');
  });

  it('keeps the approved icon, phone sheet and reduced-motion CSS', () => {
    expect(decl('.hbtn.ib', 'width')).toBe('44px');
    expect(decl('.dv-drawer.spd', 'bottom', '(max-width: 760px)')).toBe('0');
    expect(decl('.dv-drawer.spd', 'height', '(max-width: 760px)')).toBe('76%');
    for (const selector of ['.tview .hd-d', '.tview .hd-c.ps', '.tview .ring.br']) {
      expect(decl(selector, 'animation', '(prefers-reduced-motion: reduce)')).toBe('none');
    }
  });
});

it('shows failed unnumbered review verdicts in amber and opens review details', async () => {
  const user = userEvent.setup();
  const review = REVIEW_TREE.review!;
  const tree = { ...REVIEW_TREE, review: { ...review, reviewers: review.reviewers.map((r, i) => i === 0 ? { ...r, verdict: { at: r.verdict!.at, pass: false, findings: null } } : r) } };
  shell(treeRoute(tree), TREE_ORG);
  const graph = await showTree(user);
  const amber = graph.querySelector('.ring.a');
  expect(amber).toBeInTheDocument();
  expect(amber!.parentElement!.querySelector('.ic-ok')).not.toBeInTheDocument();
  await user.click(graph.querySelector('[data-row="b6"]')!);
  expect(screen.getByRole('dialog')).toHaveTextContent('Verdict: changes needed');
  expect(screen.getByRole('dialog')).toHaveTextContent('Checked for');
});

it('measures wrapped actions for the tree floor and hides a ticker under 220 pixels', async () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { callbacks.push(callback); }
    observe() {}
    disconnect() {}
  });
  const user = userEvent.setup();
  shell(treeRoute());
  await flyIn(user);
  const root = document.querySelector('.dview') as HTMLElement;
  const actions = root.querySelector('.dv-acts')!;
  Object.defineProperties(root, { clientWidth: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 700 } });
  Object.defineProperties(actions, { offsetWidth: { configurable: true, value: 543 }, offsetLeft: { configurable: true, value: 641 }, offsetTop: { configurable: true, value: 500 } });
  act(() => callbacks.forEach(fn => fn()));
  expect(root.style.getPropertyValue('--ticker-right')).toBe('575px');
  expect(root.querySelector('.ticker')).toBeInTheDocument();
  Object.defineProperty(root, 'clientWidth', { configurable: true, value: 900 });
  act(() => callbacks.forEach(fn => fn()));
  expect(root.querySelector('.ticker')).not.toBeInTheDocument();
  vi.stubGlobal('innerWidth', 360);
  act(() => callbacks.forEach(fn => fn()));
  expect(root.style.getPropertyValue('--tree-bottom')).toBe('208px');
});

it('keeps a dismissed Speed card closed after live data changes', async () => {
  const user = userEvent.setup(), stream = fakeStream();
  shell(treeRoute(), TREE_ORG);
  await flyIn(user);
  await user.click(screen.getByRole('button', { name: 'Speed' }));
  const speed = screen.getByRole('complementary', { name: 'Speed' });
  await user.click(await within(speed).findByRole('button', { name: /Bruno/ }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  stream.send({ type: 'task', id: 'b42', spot: { departmentId: 'd2' } });
  await act(async () => {});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('places a short card below its point when it fits there', async () => {
  const user = userEvent.setup();
  shell(treeRoute());
  const graph = await showTree(user);
  const hit = graph.querySelector('[data-row="b1"]')!;
  vi.spyOn(hit, 'getBoundingClientRect').mockReturnValue({ x: 200, y: 150, left: 200, right: 500, top: 150, bottom: 200, width: 300, height: 50, toJSON() {} });
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('tv-card') ? 180 : 0; } });
  onTestFinished(() => { Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor); });
  await user.click(hit);
  expect(screen.getByRole('dialog')).toHaveStyle({ top: '208px' });
});

it('shows the task number beside an agent in Speed and keeps an after-task card neutral', async () => {
  const user = userEvent.setup();
  shell(treeRoute(), TREE_ORG);
  await flyIn(user);
  await user.click(screen.getByRole('button', { name: 'Speed' }));
  const speed = screen.getByRole('complementary', { name: 'Speed' });
  const bruno = await within(speed).findByRole('button', { name: /Bruno/ });
  expect(bruno).toHaveTextContent('#42');
  await user.click(within(speed).getByRole('button', { name: /Ostap/ }));
  const card = await screen.findByRole('dialog');
  expect(card).toHaveTextContent('Waits for #49');
  expect(card.querySelector('.tstate')).not.toHaveClass('w');
});

it('anchors a card opened from Speed beside the clicked row', async () => {
  const user = userEvent.setup();
  shell(treeRoute(), TREE_ORG);
  await flyIn(user);
  await user.click(screen.getByRole('button', { name: 'Speed' }));
  const speed = screen.getByRole('complementary', { name: 'Speed' });
  const row = await within(speed).findByRole('button', { name: /Bruno/ });
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ x: 700, y: 280, left: 700, right: 1000, top: 280, bottom: 320, width: 300, height: 40, toJSON() {} });
  await user.click(row);
  expect(await screen.findByRole('dialog')).toHaveStyle({ top: '260px' });
});

describe("what an agent's program does, and the server's alarms about its turn", () => {
  type Live = Pick<Employee, 'program' | 'alarm'> & Partial<Pick<Employee, 'status'>>;
  const ago = (now: number, minutes: number) => now - minutes * 60_000;
  /* The company with Bruno's program and alarm as given, on a server clock at now. */
  function live(now: number, bruno: Live, base: Org = TREE_ORG): Org {
    return { ...base, serverNow: new Date(now).toISOString(), departments: base.departments.map(d => ({ ...d, employees: d.employees.map(e => (e.id === 'b1' ? { ...e, ...bruno } : e)) })) };
  }
  const program = (now: number, state: ProgramView['state'], minutes: number, tool: string | null = null): ProgramView => ({ state, since: ago(now, minutes), tool, screenAt: ago(now, 0), reportedAt: ago(now, 0) });
  const STATES: [string, (now: number) => Live, string, string, boolean][] = [
    ['thinking', now => ({ program: program(now, 'thinking', 12), alarm: null }), 'thinking 12 min', 'думает 12 мин', false],
    ['a tool', now => ({ program: program(now, 'tool', 40, 'Bash'), alarm: null }), 'Bash running 40 min', 'Bash работает 40 мин', false],
    ['asking', now => ({ program: program(now, 'asking', 3), alarm: null }), 'asking', 'спрашивает', false],
    ['waiting for input for 59 s', now => ({ program: program(now, 'idle', 59 / 60), alarm: null }), 'waiting for input', 'ждет ввода', false],
    ['a lost turn end after 61 s of it', now => ({ program: program(now, 'idle', 61 / 60), alarm: null }), 'turn end lost: waiting for input', 'конец хода потерян: ждет ввода', true],
    ['a frozen program', now => ({ program: program(now, 'thinking', 50), alarm: { reason: 'program_stalled', since: ago(now, 34) } }), 'program frozen 34 min', 'программа замерла 34 мин', true],
    ['a silent node', now => ({ program: program(now, 'tool', 45, 'Bash'), alarm: { reason: 'node_silent', since: ago(now, 31) } }), 'node silent 31 min', 'нода молчит 31 мин', true],
  ];
  const stateOf = (where: HTMLElement) => where.querySelector('.ast');
  function heldClock() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  }
  const bruno = () => within(screen.getByRole('region', { name: /^(Members|Сотрудники)$/ })).getByRole('button', { name: /Bruno/ });
  const lane = () => [...document.querySelectorAll<HTMLElement>('.tv-labs .lchip')].find(b => b.textContent!.includes('Bruno'))!;

  describe.each([
    ['en', /Development/, 'Tree'],
    ['ru', /Разработка/, 'Дерево'],
  ] as const)('in %s', (lang, department, tree) => {
    it.each(STATES)('shows %s on the agent on the map and in the tree', async (_, state, en, ru, alarm) => {
      localStorage.setItem('hh-lang', lang);
      onTestFinished(() => localStorage.removeItem('hh-lang'));
      /* The page's steady clock stands still, so 59 and 61 seconds stay what they are while the test runs. */
      vi.useFakeTimers({ toFake: ['performance'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const user = userEvent.setup();
      const now = Date.now();
      shell(treeRoute({ ...DEV_TREE, now: new Date(now).toISOString() }), live(now, state(now)));
      await user.click(await screen.findByRole('button', { name: department }));
      const text = lang === 'en' ? en : ru;
      for (const where of [bruno]) {
        expect(stateOf(where())).toHaveTextContent(text);
        expect(stateOf(where())!.classList.contains('alarm')).toBe(alarm);
      }
      await user.click(screen.getByRole('button', { name: tree }));
      await screen.findByRole('group');
      expect(stateOf(lane())).toHaveTextContent(text);
      expect(stateOf(lane())!.classList.contains('alarm')).toBe(alarm);
      /* Where a phone's label cuts it short, the whole of it is a touch away. */
      expect(stateOf(lane())).toHaveAttribute('title', text);
    });

    it('says in the tree that an agent without a running turn waits for a task, and nothing of it on the schema, which says so already', async () => {
      localStorage.setItem('hh-lang', lang);
      onTestFinished(() => localStorage.removeItem('hh-lang'));
      const user = userEvent.setup();
      const now = Date.now();
      shell(treeRoute({ ...DEV_TREE, now: new Date(now).toISOString() }), live(now, { program: null, alarm: null, status: 'idle' }));
      await user.click(await screen.findByRole('button', { name: department }));
      expect(stateOf(bruno())).toBeNull();
      await user.click(screen.getByRole('button', { name: tree }));
      await screen.findByRole('group');
      expect(stateOf(lane())).toHaveTextContent(lang === 'en' ? 'waiting for a task' : 'ждет задачу');
    });
  });

  it('counts the minutes on without a reload, turns a long wait for input red, and follows the server when it says the company changed', async () => {
    const user = heldClock();
    const stream = fakeStream();
    const now = Date.now();
    let org = live(now, { program: program(now, 'thinking', 12), alarm: null }, DEV_ORG);
    shell({ 'GET /api/org': async () => [200, org] });
    await flyIn(user);
    expect(stateOf(bruno())).toHaveTextContent('thinking 12 min');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(stateOf(bruno())).toHaveTextContent('thinking 13 min');
    /* It waits for input from the minute the held clock just passed. */
    org = live(now, { program: program(now, 'idle', -1), alarm: null }, DEV_ORG);
    stream.send({ type: 'org' });
    await vi.waitFor(() => expect(stateOf(bruno())).toHaveTextContent('waiting for input'));
    expect(stateOf(bruno())).not.toHaveClass('alarm');
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(stateOf(bruno())).toHaveTextContent('turn end lost: waiting for input');
    expect(stateOf(bruno())).toHaveClass('alarm');
    org = live(now, { program: null, alarm: null }, DEV_ORG);
    stream.send({ type: 'working', working: 0 });
    await vi.waitFor(() => expect(stateOf(bruno())).toBeNull());
  });

  it.each([
    ['en', 'Card', 'program frozen 34 min'],
    ['ru', 'Карточка', 'программа замерла 34 мин'],
  ])("shows it on the agent's card opened from the department, in %s", async (lang, card, text) => {
    localStorage.setItem('hh-lang', lang);
    onTestFinished(() => localStorage.removeItem('hh-lang'));
    const user = userEvent.setup();
    const now = Date.now();
    const routes = { 'GET /api/agents/b1': [200, { ...CARD, state: 'working' }], 'GET /api/agents/b1/events?after=0': [200, { events: [], state: READY }] };
    shell(routes, live(now, { program: program(now, 'thinking', 50), alarm: { reason: 'program_stalled', since: ago(now, 34) } }, DEV_ORG));
    await user.click(await screen.findByRole('button', { name: lang === 'en' ? /Development/ : /Разработка/ }));
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    await user.click(await screen.findByRole('button', { name: card }));
    const head = (await screen.findByRole('heading', { level: 3, name: 'Bruno' })).parentElement!;
    expect(stateOf(head)).toHaveTextContent(text);
    expect(stateOf(head)).toHaveClass('alarm');
  });
});
