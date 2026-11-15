import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { ComputerAccessDecision, Me, Org, ProposalDecision } from '../src/types';
import { accessView, CARD, CLOSED_TASKS, decisions, DEV_ORG, FINISHED_TURN, ME, mockApi, PLANNED_TURN, REQUESTS, ROSTER, TASKS, TURN } from './api-mock';
import { fakeStream } from './fake-stream';
import { taskRoute } from './task-route';

const ALL = '/api/tasks?status=all&department=d2';
const PLANNED = { ...TASKS[1]!, id: 't14', number: 14, title: 'Refund button', brief: '', status: 'planned' as const, assignee: null, turn: 4 };
const SUBTASK = { ...TASKS[1]!, id: 't13', number: 13, title: 'Card form', brief: '', status: 'open' as const, parentId: 't12' };
const CHECKING_CART = { ...TASKS[1]!, status: 'review' as const, assignee: TASKS[0]!.assignee, echelons: taskRoute('review', TASKS[0]!.assignee!.id) };

function shell(routes: Record<string, unknown> = {}, me: Me = ME) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
    'GET /api/requests': [200, decisions(REQUESTS)],
    'GET /api/turns': [200, { turns: [FINISHED_TURN, TURN, PLANNED_TURN] }],
    [`GET ${ALL}`]: [200, { tasks: [...TASKS, SUBTASK, PLANNED, { ...CLOSED_TASKS[0]!, turn: 2 }] }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={me} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function openTasks(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
  return screen.findByRole('heading', { level: 1, name: 'Tasks' });
}

describe('the tracker', () => {
  it('counts what waits for people in the navigation', async () => {
    shell();
    expect(await screen.findByRole('button', { name: 'Tasks, 2 waiting for you' })).toBeInTheDocument();
  });

  it('opens the orchestrator to write to him, for people who see the whole company', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/orchestrator/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }] });
    await openTasks(user);
    await user.click(screen.getByRole('button', { name: 'Write to the orchestrator' }));
    expect(await screen.findByRole('complementary', { name: /Orchestrator/ })).toBeInTheDocument();
  });

  it('asks people with part of the company to write to nobody from here', async () => {
    const user = userEvent.setup();
    shell({}, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    await openTasks(user);
    expect(screen.queryByRole('button', { name: 'Write to the orchestrator' })).not.toBeInTheDocument();
  });

  it('says what to do when there is no turn yet', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/turns': [200, { turns: [] }], [`GET ${ALL}`]: [200, { tasks: [] }] });
    await openTasks(user);
    expect(await screen.findByText(/No turns in this department yet/)).toBeInTheDocument();
  });

  it('answers a question and takes it off the list', async () => {
    const user = userEvent.setup();
    let answered = false;
    const calls = shell({
      'GET /api/requests': () => [200, decisions(answered ? REQUESTS.slice(1) : REQUESTS)],
      'POST /api/requests/r1': () => {
        answered = true;
        return [200, { request: { id: 'r1', status: 'answered' } }];
      },
    });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    const question = within(waiting).getByRole('article', { name: /#9/ });
    /* Until the orchestrator puts it into plain words, the agent's own words stand. */
    expect(question).toHaveTextContent('Stripe or Adyen?');
    expect(question).toHaveTextContent('Dana');
    expect(within(question).queryByText('In more detail')).toBeNull();
    await user.type(within(question).getByLabelText('Your answer'), 'Stripe');
    await user.click(within(question).getByRole('button', { name: 'Send answer' }));
    expect(calls.find(c => c.path === '/api/requests/r1')?.body).toEqual({ answer: 'Stripe' });
    await waitFor(() => expect(within(waiting).queryByRole('article', { name: /#9/ })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Tasks, 1 waiting for you' })).toBeInTheDocument();
  });

  it('says the orchestrator is putting a question into plain words while it is on it', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, explaining: true }, REQUESTS[1]])] });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('article', { name: /#9/ })).toHaveTextContent('The orchestrator is writing this up in plain words.');
    expect(within(waiting).getByRole('article', { name: /#10/ })).not.toHaveTextContent('plain words');
  });

  it('offers the ways an agent gives to pick from, with their pictures and a link to the work, and sends the pick', async () => {
    const user = userEvent.setup();
    const choice = {
      ...REQUESTS[0]!,
      id: 'r4',
      kind: 'choice' as const,
      text: 'Which logo?',
      images: ['p0'],
      options: [
        { label: 'Round', image: 'p1' },
        { label: 'Square', image: null },
      ],
      link: 'https://preview.example.com/logo',
      task: { ...REQUESTS[0]!.task, id: 't11', number: 11, title: 'Logo' },
    };
    const calls = shell({ 'GET /api/requests': [200, decisions([choice])], 'POST /api/requests/r4': [200, { request: { id: 'r4', status: 'answered' } }] });
    await openTasks(user);
    const asked = within(screen.getByRole('region', { name: 'Waiting for you' })).getByRole('article', { name: /#11/ });
    const materials = within(asked).getByRole('region', { name: 'Materials' });
    const options = within(asked).getAllByRole('listitem');
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent('Round');
    expect(options[1]).toHaveTextContent('Square');
    const commonPicture = within(materials).getByRole('button', { name: 'Open material: Picture 1 (Image)' });
    const optionPicture = within(options[0]!).getByRole('button', { name: 'Open material: Picture 1 (Image)' });
    for (const [opener, source] of [[commonPicture, '/api/attachments/p0'], [optionPicture, '/api/attachments/p1']] as const) {
      await user.click(opener);
      const viewer = await screen.findByRole('dialog', { name: 'Picture 1' });
      expect(within(viewer).getByRole('img', { name: 'Picture 1' })).toHaveAttribute('src', source);
      await user.click(within(viewer).getByRole('button', { name: 'Close' }));
    }
    await user.click(within(materials).getByRole('button', { name: 'Open material: See the work (Link)' }));
    const linkViewer = await screen.findByRole('dialog', { name: 'See the work' });
    expect(within(linkViewer).getByRole('link', { name: 'Open link' })).toHaveAttribute('href', 'https://preview.example.com/logo');
    await user.click(within(linkViewer).getByRole('button', { name: 'Close' }));
    expect(calls.filter(c => c.path === '/api/requests/r4')).toHaveLength(0);
    /* A pick is made here only: words to the agent answer a question, not a choice. */
    expect(screen.getByRole('region', { name: 'Waiting for you' })).not.toHaveTextContent(/window or terminal/);
    await user.click(within(options[1]!).getByRole('button', { name: 'Choose option 2' }));
    expect(calls.filter(c => c.path === '/api/requests/r4')).toHaveLength(1);
    expect(calls.find(c => c.path === '/api/requests/r4')?.body).toEqual({ pick: 1 });
  });

  it('shows the exact commit an approval is for, with Approve and Decline', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/requests/r2': [200, { request: { id: 'r2', status: 'approved' } }] });
    await openTasks(user);
    const approval = within(screen.getByRole('region', { name: 'Waiting for you' })).getByRole('article', { name: /#10/ });
    expect(approval).toHaveTextContent('a'.repeat(40));
    expect(within(approval).getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    await user.click(within(approval).getByRole('button', { name: 'Approve' }));
    expect(calls.find(c => c.path === '/api/requests/r2')?.body).toEqual({ approve: true });
  });

  it('shows a commit waiting for approval to people with part of the company, without letting them approve it', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/requests': [200, decisions([REQUESTS[0]!, { ...REQUESTS[1]!, canAnswer: false }])] }, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    await openTasks(user);
    const approval = within(screen.getByRole('region', { name: 'Waiting for you' })).getByRole('article', { name: /#10/ });
    expect(approval).toHaveTextContent('a'.repeat(40));
    expect(approval).toHaveTextContent('Decided by the CEO or the CEO delegate.');
    expect(within(approval).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(approval).queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
  });

  it('fetches the tasks again when one changes', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    let moved = false;
    shell({ [`GET ${ALL}`]: () => [200, { tasks: moved ? [CHECKING_CART] : TASKS }] });
    await openTasks(user);
    moved = true;
    stream.send({ type: 'task', id: 't11' });
    await waitFor(() => expect(screen.getByRole('row', { name: /#11/ })).toHaveTextContent('Rita'));
    expect(screen.getByRole('row', { name: /#11/ })).toHaveTextContent('In review');
    expect(screen.getByRole('row', { name: /#11/ })).toHaveTextContent('Review');
  });

  it('keeps the newest list when an older answer comes after it', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    let moved = false;
    let hold = false;
    let late = () => {};
    shell({
      [`GET ${ALL}`]: () => {
        const reply: [number, unknown] = [200, { tasks: moved ? [CHECKING_CART] : TASKS }];
        if (!hold) return reply;
        hold = false;
        return new Promise(resolve => (late = () => resolve(reply)));
      },
    });
    await openTasks(user);
    hold = true;
    stream.send({ type: 'task', id: 't11' });
    moved = true;
    stream.send({ type: 'task', id: 't11' });
    await waitFor(() => expect(screen.getByRole('row', { name: /#11/ })).toHaveTextContent('Rita'));
    await act(async () => {
      late();
      /* One turn of the event loop: the older answer's promise chain has no timer in it, so it has run its course. */
      await new Promise(r => setImmediate(r));
    });
    expect(screen.getByRole('row', { name: /#11/ })).toHaveTextContent('Rita');
    expect(screen.getByRole('row', { name: /#11/ })).toHaveTextContent('Review');
  });
});

/* The rows of tasks in a table, without its heads. */
const taskRows = (table: HTMLElement) => within(table).getAllByRole('row').filter(row => row.classList.contains('rm'));

describe('task search', () => {
  const archived = { ...PLANNED, id: 'abcdef14-1234-4567-8901-123456789abc', status: 'done', turn: 2 };
  const mention = { ...SUBTASK, title: 'Notes for #14', brief: 'Check 14 payments.' };

  it.each(['14', '#14'])('puts the exact task number first for %s, ahead of word matches', async query => {
    const user = userEvent.setup();
    shell({ [`GET ${ALL}`]: [200, { tasks: [mention, { ...PLANNED, id: 't114', number: 114 }, archived] }] });
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), query);
    const results = screen.getByRole('table', { name: 'Search results' });
    const matches = taskRows(results);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toHaveTextContent('#14 Refund button');
    expect(matches[0]).toBeVisible();
    expect(matches[1]).toHaveTextContent('#13 Notes for #14');
    expect(within(results).queryByRole('row', { name: /#114/ })).not.toBeInTheDocument();
  });

  it.each(['abcdef14-1234-4567-8901-123456789abc', 'ABCDEF14'])('finds a task by its id or prefix: %s', async query => {
    const user = userEvent.setup();
    shell({ [`GET ${ALL}`]: [200, { tasks: [...TASKS, archived] }] });
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), query);
    const results = screen.getByRole('table', { name: 'Search results' });
    expect(taskRows(results)).toHaveLength(1);
    expect(within(results).getByRole('row', { name: /#14 Refund button/ })).toBeVisible();
  });

  it('does not use id prefixes shorter than eight characters', async () => {
    const user = userEvent.setup();
    shell({ [`GET ${ALL}`]: [200, { tasks: [archived] }] });
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'abcdef1');
    expect(screen.getByRole('status')).toHaveTextContent('No tasks found');
  });

  it.each([
    ['  CHECKOUT   payments  ', 'Checkout API'],
    ['ОпЛаТа карта', 'Оплата заказа'],
  ])('requires every word across the title and brief, ignoring case: %s', async (query, title) => {
    const user = userEvent.setup();
    const russian = { ...PLANNED, title: 'Оплата заказа', brief: 'Банковская карта', status: 'cancelled' };
    shell({ [`GET ${ALL}`]: [200, { tasks: [...TASKS, russian] }] });
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), query);
    const results = screen.getByRole('table', { name: 'Search results' });
    expect(taskRows(results)).toHaveLength(1);
    expect(within(results).getByRole('row', { name: new RegExp(title) })).toBeVisible();
  });

  it('shows no matches without changing the decisions waiting for the person', async () => {
    const user = userEvent.setup();
    shell();
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'Checkout missing');
    expect(screen.getByRole('status')).toHaveTextContent('No tasks found');
    expect(screen.queryByRole('row', { name: /#12 Checkout API/ })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Waiting for you' })).toHaveTextContent('Stripe or Adyen?');
  });

});

/* Development with Dan as its only person; Ivan, the CEO, and Maria, a deputy, sit next to the hub. */
const DAN = { id: 'p4', name: 'Dan', email: 'dan@acme.com', title: '', status: 'active' as const, isOwner: false, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] } };
const counted = (counts: Record<string, number>): Org => ({
  ...DEV_ORG,
  people: DEV_ORG.people.map(p => ({ ...p, pendingDecisions: counts[p.id] ?? 0 })),
  departments: [{ ...DEV_ORG.departments[0]!, people: [{ ...DAN, pendingDecisions: counts.p4 ?? 0 }] }],
});
const AT = '2026-11-02T12:00:00.000Z';
const STRUCTURE: ProposalDecision = { id: 'pr1', kind: 'structure', agent: { id: 'a1', name: 'Orchestrator' }, department: null, brief: 'Add Support.', items: [{ template: 'support', checked: true, note: 'Answers customers.' }], at: AT, ownerPersonId: 'p1', canAnswer: true };
const SERVER_ACCESS = accessView('the company server', { asked: { reason: 'Inspect disk space.', at: AT }, machine: { id: 'm-server', hostname: '', role: 'data', data: true } });
const COMPUTER: ComputerAccessDecision = { kind: 'computer_access', id: 'm-server', agent: { id: 'a1', name: 'Orchestrator' }, ownerPersonId: 'p1', canAnswer: true, at: AT, view: SERVER_ACCESS };

describe('the decisions of one person', () => {
  it("open from that person's card on the map, with a filter one can see and take off", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 1, p4: 1 })], 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: 'p4' }, REQUESTS[1]!])] });
    await user.click(await screen.findByRole('button', { name: 'Dan: 1 decision waits' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Tasks' })).toBeInTheDocument();
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByText('Decisions for Dan')).toBeInTheDocument();
    expect(within(waiting).getAllByRole('article').map(a => a.getAttribute('aria-label'))).toEqual(['#9 Pick a payment provider']);
    await user.click(within(waiting).getByRole('button', { name: "Show everyone's decisions" }));
    expect(within(waiting).getAllByRole('article')).toHaveLength(2);
    expect(within(waiting).queryByText('Decisions for Dan')).not.toBeInTheDocument();
  });

  it('say plainly when nothing waits for that person, and give way to all of them when Tasks is opened by hand', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 2 })] });
    await user.click(await screen.findByRole('button', { name: 'Maria: no decisions wait' }));
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(waiting).toHaveTextContent('Decisions for Maria');
    expect(waiting).toHaveTextContent('Nothing waits for a decision from Maria.');
    await user.click(screen.getByRole('button', { name: 'Map' }));
    await user.click(screen.getByRole('button', { name: /^Tasks/ }));
    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(screen.queryByText('Decisions for Maria')).not.toBeInTheDocument();
  });

  it("include the orchestrator's card and his request for the computer, counted in the navigation and answered with their own buttons", async () => {
    const user = userEvent.setup();
    let asked = true;
    const calls = shell({
      'GET /api/requests': () => [200, decisions(REQUESTS, { proposals: [STRUCTURE], machineAccess: asked ? [COMPUTER] : [] })],
      'POST /api/machines/m-server/access/open': () => {
        asked = false;
        return [200, { ...SERVER_ACCESS, until: '2099-11-03T12:00:00.000Z', asked: null }];
      },
    });
    expect(await screen.findByRole('button', { name: 'Tasks, 4 waiting for you' })).toBeInTheDocument();
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('heading', { name: 'Company structure' })).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: 'Create departments (1)' })).toBeInTheDocument();
    const computer = within(waiting).getByRole('region', { name: "The orchestrator asks for access to the server's computer" });
    expect(computer).toHaveTextContent('Inspect disk space.');
    /* What opening gives stands under the request: here the company's data, on a system the server did not name. */
    expect(computer).toHaveTextContent("Open access lets the orchestrator change anything on the server's computer, the company's data included.");
    await user.click(within(computer).getByRole('button', { name: "Open access to the server's computer for a day" }));
    expect(calls).toContainEqual({ method: 'POST', path: '/api/machines/m-server/access/open', body: {} });
    expect(await screen.findByRole('button', { name: 'Tasks, 3 waiting for you' })).toBeInTheDocument();
    expect(within(waiting).queryByRole('region', { name: /asks for access/ })).not.toBeInTheDocument();
  });

  it("show the CEO's merge card", async () => {
    const user = userEvent.setup();
    let open = 1;
    const calls = shell({
      'GET /api/requests': () => [200, decisions([], { merges: open ? [{ id: 'm1', label: 'the database from before the restore of 10 Nov 08:00 UTC', after: '2026-11-10T08:00:00.000Z', open, ownerPersonId: 'p1' }] : [] })],
      'GET /api/merges/m1/conflicts': () => [200, { conflicts: open ? [{
        id: 'c1', merge: 'm1', label: 'x', table: 'people', topic: 'people', what: 'Maria (maria@acme.test)', kind: 'differs', cols: ['name'],
        here: { name: '"Maria Here"' }, there: { name: '"Maria There"' }, at: null, task: null, whose: 'ceo', picked: null,
      }] : [] }],
      'POST /api/merges/pick': () => {
        open = 0;
        return [200, { settled: 1, here: 1, there: 0, refused: [], tasks: [] }];
      },
    });
    expect(await screen.findByRole('button', { name: 'Tasks, 1 waiting for you' })).toBeInTheDocument();
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    const card = await within(waiting).findByRole('region', { name: /^What came after / });
    expect(card).toHaveTextContent('1 change about people, access, plans, machines or protected records needs you.');
    await user.click(await within(card).findByRole('button', { name: 'Keep here' }));
    expect(calls).toContainEqual({ method: 'POST', path: '/api/merges/pick', body: { ids: ['c1'], take: 'here' } });
    /* Settled, the card goes with the count. */
    await waitFor(() => expect(within(waiting).queryByRole('region', { name: /^What came after / })).not.toBeInTheDocument());
  });

  it('show the rest of what waits from a server that knows no machine requests yet', async () => {
    const user = userEvent.setup();
    /* What a server of before answers: one request for the computer under the old key, and none under the new. */
    const { machineAccess: _none, ...older } = decisions(REQUESTS, { proposals: [STRUCTURE] });
    void _none;
    shell({ 'GET /api/requests': [200, { ...older, computerAccess: { kind: 'computer_access', id: 'server', view: { available: true, until: null, asked: { reason: 'Old.', at: AT } } } }] });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('heading', { name: 'Company structure' })).toBeInTheDocument();
    expect(within(waiting).queryByRole('region', { name: /asks for access/ })).not.toBeInTheDocument();
  });

  it('show a card for each machine the orchestrator asks for, and answer each on its own machine', async () => {
    const user = userEvent.setup();
    const mac = accessView('office-pc', { asked: { reason: 'Clean Docker images.', at: AT }, machine: { os: 'darwin' } });
    const calls = shell({
      'GET /api/requests': [200, decisions([], { machineAccess: [COMPUTER, { ...COMPUTER, id: 'm-office-pc', view: mac }] })],
      'POST /api/machines/m-office-pc/access/decline': [200, { ...mac, asked: null }],
    });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('region', { name: "The orchestrator asks for access to the server's computer" })).toHaveTextContent('Inspect disk space.');
    const second = within(waiting).getByRole('region', { name: 'The orchestrator asks for access to office-pc' });
    expect(second).toHaveTextContent('Clean Docker images.');
    expect(second).toHaveTextContent("On a Mac this reaches Docker's Linux system, not macOS itself.");
    await user.click(within(second).getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(calls).toContainEqual({ method: 'POST', path: '/api/machines/m-office-pc/access/decline', body: undefined }));
    expect(calls.some(call => call.path.startsWith('/api/machines/m-server/access'))).toBe(false);
  });

  it("show a card to hire into a department under the department's name, and say why the computer could not be opened", async () => {
    const user = userEvent.setup();
    const staff: ProposalDecision = { ...STRUCTURE, id: 'pr2', kind: 'staff', department: { id: 'd2', name: 'development' }, brief: 'Hire a reviewer.', items: [{ role: 'DEV-BE', name: 'Reviewer' }] };
    shell({
      'GET /api/requests': [200, decisions([], { proposals: [staff], machineAccess: [COMPUTER] })],
      'GET /api/departments/d2/roster': [200, ROSTER],
      'POST /api/machines/m-server/access/open': [409, { error: { code: 'conflict', message: "Hornhoof cannot reach the server's computer now: its core has not answered for a minute.", reason: 'machine_unreachable' } }],
    });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('heading', { name: 'Hiring for Development' })).toBeInTheDocument();
    expect(within(waiting).getByText('Hire a reviewer.')).toBeInTheDocument();
    await user.click(within(waiting).getByRole('button', { name: "Open access to the server's computer for a day" }));
    expect(await within(waiting).findByRole('alert')).toHaveTextContent('Hornhoof cannot reach this machine now: its core has not answered for a minute.');
  });

  it("show the CEO's own filter with the computer, and another person's without it", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 3, p4: 1 })], 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: 'p4' }, REQUESTS[1]!], { proposals: [STRUCTURE], machineAccess: [COMPUTER] })] });
    await user.click(await screen.findByRole('button', { name: 'Ivan: 3 decisions wait' }));
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getAllByRole('article').map(a => a.getAttribute('aria-label'))).toEqual(['#10 Payments']);
    expect(within(waiting).getByRole('region', { name: /asks for access/ })).toBeInTheDocument();
    expect(within(waiting).getByRole('heading', { name: 'Company structure' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Map' }));
    await user.click(await screen.findByRole('button', { name: 'Dan: 1 decision waits' }));
    const his = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(within(his).queryByRole('region', { name: /asks for access/ })).not.toBeInTheDocument();
    expect(within(his).queryByRole('heading', { name: 'Company structure' })).not.toBeInTheDocument();
  });

  it('fetch again when who decides may have moved, or the request for the computer changed', async () => {
    const stream = fakeStream();
    let total = 1;
    shell({ 'GET /api/requests': () => [200, decisions(REQUESTS.slice(0, total))] });
    expect(await screen.findByRole('button', { name: 'Tasks, 1 waiting for you' })).toBeInTheDocument();
    total = 2;
    stream.send({ type: 'org' });
    expect(await screen.findByRole('button', { name: 'Tasks, 2 waiting for you' })).toBeInTheDocument();
    total = 0;
    stream.send({ type: 'computer' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument());
  });
});

describe('decisions read failure', () => {
  it('keeps the shown requests and retries the failed read', async () => {
    const user = userEvent.setup();
    let broken = false;
    const stream = fakeStream();
    const calls = shell({
      'GET /api/requests': () => (broken ? [503, { error: { code: 'unavailable', message: 'Hornhoof is busy.' } }] : [200, decisions(REQUESTS)]),
    });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('article', { name: /#9/ })).toBeInTheDocument();
    broken = true;
    stream.send({ type: 'requests' });
    await expect.poll(() => calls.filter(c => c.path === '/api/requests').length).toBeGreaterThanOrEqual(2);
    expect(await within(waiting).findByRole('alert')).toHaveTextContent('Hornhoof is busy.');
    expect(within(waiting).getByRole('article', { name: /#9/ })).toBeInTheDocument();
    broken = false;
    await user.click(within(waiting).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(waiting).queryByRole('alert')).not.toBeInTheDocument());
    expect(within(waiting).getByRole('article', { name: /#9/ })).toBeInTheDocument();
    expect(calls.filter(c => c.path === '/api/requests').length).toBeGreaterThanOrEqual(3);
  });
});

describe('how a turn runs', () => {
  it("lists in a department's table its own turns and those its tasks are in, not another department's", async () => {
    const user = userEvent.setup();
    const launch = { ...TURN, id: 'u5', number: 5, title: 'Spring launch', goal: 'Tell people.', departmentId: 'd3', messages: [] };
    const offers = { ...PLANNED_TURN, id: 'u6', number: 6, title: 'Spring offers', goal: 'Special prices.', departmentId: 'd3' };
    shell({ 'GET /api/turns': [200, { turns: [FINISHED_TURN, TURN, PLANNED_TURN, launch, offers] }] });
    await openTasks(user);
    expect(await screen.findByText('Refunds')).toBeInTheDocument();
    expect(screen.queryByText('Spring launch')).not.toBeInTheDocument();
    expect(screen.queryByText('Spring offers')).not.toBeInTheDocument();
  });

  it('shows how each turn runs, and lets a person the server lets change it only while the turn is planned', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'PATCH /api/turns/4': [200, { turn: { ...PLANNED_TURN, mode: 'turnkey' } }] });
    await openTasks(user);
    const modes = await screen.findAllByRole('combobox', { name: 'How the turn runs' });
    expect(modes).toHaveLength(1);
    expect(modes[0]).toHaveValue('echelons');
    expect(screen.getAllByText('How the turn runs: in stages').length).toBeGreaterThanOrEqual(2);
    await user.selectOptions(modes[0]!, 'turnkey');
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')).toMatchObject({ path: '/api/turns/4', body: { mode: 'turnkey' } }));
  });

  it('shows a person who may not change it how each turn runs, without a way to change it', async () => {
    const user = userEvent.setup();
    shell({
      'GET /api/task-departments': [200, { whole: false, departments: [{ id: 'd2', name: 'Development', templateKey: 'development' }] }],
      'GET /api/turns': [200, { turns: [FINISHED_TURN, TURN, PLANNED_TURN].map(turn => ({ ...turn, canChangeMode: false })) }],
    });
    await openTasks(user);
    expect(await screen.findAllByText('How the turn runs: in stages')).not.toHaveLength(0);
    expect(screen.queryByRole('combobox', { name: 'How the turn runs' })).not.toBeInTheDocument();
  });

  it('lets the owner of the department, who sees only part of the company, change how its planned turn runs', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/task-departments': [200, { whole: false, departments: [{ id: 'd2', name: 'Development', templateKey: 'development' }] }] });
    await openTasks(user);
    expect(await screen.findAllByRole('combobox', { name: 'How the turn runs' })).toHaveLength(1);
  });

  it.each([
    ['en', 'Choose: Price page', 'How the next turn runs', 'Turnkey, one employee alone', 'Put into the next turn: 1'],
    ['ru', 'Выбрать: Price page', 'Как пойдет следующий ход', 'Под ключ, один сотрудник', 'Поставить в следующий ход: 1'],
  ])('puts the chosen items into the next turn in the mode the person picks (%s)', async (lang, choose, mode, turnkey, put) => {
    localStorage.setItem('hh-lang', lang);
    try {
      const user = userEvent.setup();
      const calls = shell({
        'GET /api/departments/d2/backlog': [200, { items: [{ id: 'i1', departmentId: 'd2', title: 'Price page', text: '', by: { id: 'p1', name: 'Ivan' }, at: '2026-10-30T08:00:00.000Z' }] }],
        'POST /api/departments/d2/backlog/schedule': [200, { turn: { number: 5 }, tasks: [{ id: 't20', number: 20 }] }],
      });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await user.click(await screen.findByRole('checkbox', { name: choose }));
      await user.selectOptions(screen.getByRole('combobox', { name: mode }), turnkey);
      await user.click(screen.getByRole('button', { name: put }));
      await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path.endsWith('/schedule'))?.body).toEqual({ ids: ['i1'], mode: 'turnkey' }));
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });
});
