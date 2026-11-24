import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { Me, Org, ProposalDecision } from '../src/types';
import { CARD, CLOSED_TASKS, decisions, DEV_ORG, FINISHED_TURN, ME, mockApi, REQUESTS, ROSTER, TASK_DETAIL, TASKS, TURN } from './api-mock';
import { fakeStream } from './fake-stream';
import { taskRoute } from './task-route';

const ALL = '/api/tasks?status=all';
const PLANNED = { ...TASKS[1]!, id: 't14', number: 14, title: 'Refund button', brief: '', status: 'open' as const, assignee: null, turn: null };
const SUBTASK = { ...TASKS[1]!, id: 't13', number: 13, title: 'Card form', brief: '', status: 'open' as const, parentId: 't12' };
const CHECKING_CART = { ...TASKS[1]!, status: 'review' as const, assignee: TASKS[0]!.assignee, echelons: taskRoute('review', TASKS[0]!.assignee!.id) };

function shell(routes: Record<string, unknown> = {}, me: Me = ME) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
    'GET /api/requests': [200, decisions(REQUESTS)],
    'GET /api/turns': [200, { turns: [FINISHED_TURN, TURN] }],
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
  return screen.findByRole('heading', { level: 1, name: 'My tasks' });
}

/* A place of the tracker's left panel. */
async function goTo(user: ReturnType<typeof userEvent.setup>, name: RegExp | string) {
  await user.click(within(await screen.findByRole('navigation', { name: /^(Task lists|Списки задач)$/ })).getByRole('button', { name }));
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
    /* From the + beside Tasks, the one way to make something there. */
    await user.click(within(screen.getByRole('navigation', { name: 'Task lists' })).getByRole('button', { name: 'Create' }));
    await user.click(within(screen.getByRole('group', { name: 'Create' })).getByRole('button', { name: 'Write to the orchestrator' }));
    expect(await screen.findByRole('complementary', { name: /Orchestrator/ })).toBeInTheDocument();
  });

  it('asks people with part of the company to write to nobody from here', async () => {
    const user = userEvent.setup();
    shell({}, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    await openTasks(user);
    expect(screen.queryByRole('button', { name: 'Write to the orchestrator' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Create' })).not.toBeInTheDocument();
  });

  it('says what to do when nothing is in progress and there is no turn yet', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/turns': [200, { turns: [] }], [`GET ${ALL}`]: [200, { tasks: [] }] });
    await openTasks(user);
    expect(await screen.findByText('No open tasks to answer for.')).toBeInTheDocument();
    await goTo(user, 'Turns and releases');
    expect(await screen.findByText(/No turns and no tasks yet/)).toBeInTheDocument();
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

  it("leaves a readable approval out of the person's own waits when they cannot approve it", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/requests': [200, decisions([REQUESTS[0]!, { ...REQUESTS[1]!, canAnswer: false }])] }, { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } });
    await openTasks(user);
    const waiting = within(screen.getByRole('region', { name: 'Waiting for you' }));
    expect(waiting.getByRole('article', { name: /#9/ })).toBeInTheDocument();
    expect(waiting.queryByRole('article', { name: /#10/ })).not.toBeInTheDocument();
    expect(waiting.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('fetches the tasks again when one changes', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    let moved = false;
    shell({ [`GET ${ALL}`]: () => [200, { tasks: moved ? [CHECKING_CART] : TASKS }] });
    await openTasks(user);
    await goTo(user, /^Development/);
    moved = true;
    stream.send({ type: 'task', id: 't11' });
    await waitFor(() => expect(within(within(screen.getByRole('region', { name: 'Review: 1' })).getByRole('listitem', { name: /#11/ })).getByRole('img', { name: 'Rita' })).toBeInTheDocument());
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
    await goTo(user, /^Development/);
    hold = true;
    stream.send({ type: 'task', id: 't11' });
    moved = true;
    stream.send({ type: 'task', id: 't11' });
    const reviewed = () => within(screen.getByRole('region', { name: 'Review: 1' })).getByRole('listitem', { name: /#11/ });
    await waitFor(() => expect(within(reviewed()).getByRole('img', { name: 'Rita' })).toBeInTheDocument());
    await act(async () => {
      late();
      /* One turn of the event loop: the older answer's promise chain has no timer in it, so it has run its course. */
      await new Promise(r => setImmediate(r));
    });
    expect(within(reviewed()).getByRole('img', { name: 'Rita' })).toBeInTheDocument();
  });
});

/* The rows of what a search found, best match first. */
const taskRows = (found: HTMLElement) => within(found).getAllByRole('listitem');

describe('task search', () => {
  const archived = { ...PLANNED, id: 'abcdef14-1234-4567-8901-123456789abc', status: 'done', turn: 2 };
  const mention = { ...SUBTASK, title: 'Notes for #14', brief: 'Check 14 payments.' };

  it.each(['14', '#14'])('puts the exact task number first for %s, ahead of word matches', async query => {
    const user = userEvent.setup();
    shell({ [`GET ${ALL}`]: [200, { tasks: [mention, { ...PLANNED, id: 't114', number: 114 }, archived] }] });
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), query);
    const results = screen.getByRole('region', { name: 'Found tasks' });
    const matches = taskRows(results);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toHaveAccessibleName('#14 Refund button');
    expect(matches[0]).toBeVisible();
    expect(matches[1]).toHaveAccessibleName('#13 Notes for #14');
    expect(within(results).queryByRole('listitem', { name: /#114/ })).not.toBeInTheDocument();
  });

  it.each(['abcdef14-1234-4567-8901-123456789abc', 'ABCDEF14'])('finds a task by its id or prefix: %s', async query => {
    const user = userEvent.setup();
    shell({ [`GET ${ALL}`]: [200, { tasks: [...TASKS, archived] }] });
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), query);
    const results = screen.getByRole('region', { name: 'Found tasks' });
    expect(taskRows(results)).toHaveLength(1);
    expect(within(results).getByRole('listitem', { name: /#14 Refund button/ })).toBeVisible();
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
    const results = screen.getByRole('region', { name: 'Found tasks' });
    expect(taskRows(results)).toHaveLength(1);
    expect(within(results).getByRole('listitem', { name: new RegExp(title) })).toBeVisible();
  });

  it('shows no matches without changing the decisions waiting for the person', async () => {
    const user = userEvent.setup();
    shell();
    await openTasks(user);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'Checkout missing');
    expect(screen.getByRole('status')).toHaveTextContent('No tasks found');
    expect(screen.queryByRole('listitem', { name: /#12 Checkout API/ })).not.toBeInTheDocument();
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

describe('the decisions of one person', () => {
  it("open from that person's card on the map under a title with their name, and Me takes the filter off", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 1, p4: 1 })], 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: 'p4' }, REQUESTS[1]!])] });
    await user.click(await screen.findByRole('button', { name: 'Dan: 1 decision waits' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Waits for Dan' })).toBeInTheDocument();
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getAllByRole('article').map(a => a.getAttribute('aria-label'))).toEqual(['#9 Pick a payment provider']);
    /* What waits for other people has its own section, so the title alone names the person, with no way to everyone's
       decisions. */
    expect(waiting).not.toHaveTextContent('Decisions for Dan');
    expect(within(waiting).queryByRole('button', { name: "Show everyone's decisions" })).toBeNull();
    await user.selectOptions(screen.getByRole('combobox', { name: 'View as' }), 'Me, Ivan');
    expect(screen.getByRole('heading', { level: 1, name: 'Waits for me' })).toBeInTheDocument();
    expect(within(waiting).getAllByRole('article')).toHaveLength(1);
    expect(within(waiting).getByRole('button', { expanded: false })).toBeInTheDocument();
  });

  it('say plainly when nothing waits for that person, and give way to all of them when Tasks is opened by hand', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 2 })] });
    await user.click(await screen.findByRole('button', { name: 'Maria: no decisions wait' }));
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(screen.getByRole('heading', { level: 1, name: 'Waits for Maria' })).toBeInTheDocument();
    expect(waiting).toHaveTextContent('Nothing waits for a decision from Maria.');
    await user.click(screen.getByRole('button', { name: 'Map' }));
    await user.click(screen.getByRole('button', { name: /^Tasks/ }));
    expect(await within(await screen.findByRole('region', { name: 'Waiting for you' })).findAllByRole('article')).toHaveLength(2);
    expect(screen.queryByRole('heading', { level: 1, name: 'Waits for Maria' })).not.toBeInTheDocument();
  });

  it("shows the structure card and counts no machine access decision", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/requests': [200, decisions(REQUESTS, { proposals: [STRUCTURE] })] });
    expect(await screen.findByRole('button', { name: 'Tasks, 3 waiting for you' })).toBeInTheDocument();
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('heading', { name: 'Company structure' })).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: 'Create departments (1)' })).toBeInTheDocument();
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
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply' }));
    expect(calls).toContainEqual({ method: 'POST', path: '/api/merges/pick', body: { ids: ['c1'], take: 'here' } });
    /* Settled, the card goes with the count. */
    await waitFor(() => expect(within(waiting).queryByRole('region', { name: /^What came after / })).not.toBeInTheDocument());
  });

  it('show the rest of what waits from a server that knows no machine requests yet', async () => {
    const user = userEvent.setup();
    /* What a server of before answers: one request for the computer under the old key, and none under the new. */
    const older = decisions(REQUESTS, { proposals: [STRUCTURE] });
    shell({ 'GET /api/requests': [200, { ...older, computerAccess: { kind: 'computer_access', id: 'server', view: { available: true, until: null, asked: { reason: 'Old.', at: AT } } } }] });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('heading', { name: 'Company structure' })).toBeInTheDocument();
    expect(within(waiting).queryByRole('region', { name: /asks for access/ })).not.toBeInTheDocument();
  });

  it("show a card to hire into a department under the department's name", async () => {
    const user = userEvent.setup();
    const staff: ProposalDecision = { ...STRUCTURE, id: 'pr2', kind: 'staff', department: { id: 'd2', name: 'development' }, brief: 'Hire a reviewer.', items: [{ role: 'DEV-BE', name: 'Reviewer' }] };
    shell({
      'GET /api/requests': [200, decisions([], { proposals: [staff] })],
      'GET /api/departments/d2/roster': [200, ROSTER],
    });
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('heading', { name: 'Hiring for Development' })).toBeInTheDocument();
    expect(within(waiting).getByText('Hire a reviewer.')).toBeInTheDocument();
  });

  it("show the CEO's own filter with the structure card, and another person's without it", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 2, p4: 1 })], 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: 'p4' }, REQUESTS[1]!], { proposals: [STRUCTURE] })] });
    await user.click(await screen.findByRole('button', { name: 'Ivan: 2 decisions wait' }));
    const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getAllByRole('article').map(a => a.getAttribute('aria-label'))).toEqual(['#10 Payments']);
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

describe('turns as releases', () => {
  const DONE_IN_TURN = { ...TASKS[1]!, id: 't16', number: 16, title: 'Price list', brief: '', status: 'done' as const, turn: 3, parentId: null };
  it.each([
    ['en', 'Tasks', 'Turns and releases', 'A turn is everything that goes into one release of the program.', 'Getting ready: turn 3, the release after v1.2.0', '1 of 5 goals done', 'Closed releases', 'Turn 2: release v1.2.0', 'tasks: 1', 'Open question'],
    ['ru', 'Задачи', 'Ходы и выпуски', 'Ход: все, что войдет в один выпуск программы.', 'Готовится: ход 3, выпуск после v1.2.0', 'Готово 1 из 5 целей', 'Закрытые выпуски', 'Ход 2: выпуск v1.2.0', 'задач: 1', 'Открыть вопрос'],
  ])('gets the next release ready, counted in goals, and folds the closed releases with their tasks (%s)', async (lang, tasks, releases, why, preparing, goalsDone, closedHeading, released, count, open) => {
    localStorage.setItem('hh-lang', lang);
    try {
      const user = userEvent.setup();
      const calls = shell({
        [`GET ${ALL}`]: [200, { tasks: [...TASKS, SUBTASK, PLANNED, DONE_IN_TURN, { ...CLOSED_TASKS[0]!, turn: 2 }] }],
        'GET /api/tasks/t9': [200, { task: { ...TASK_DETAIL, id: 't9', number: 9, title: 'Pick a payment provider', parentId: null } }],
      });
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${tasks}`) }));
      await goTo(user, releases);
      expect(await screen.findByText(new RegExp(`^${why}`))).toBeInTheDocument();
      const next = screen.getByRole('region', { name: preparing });
      expect(within(next).getByRole('progressbar', { name: goalsDone })).toHaveAttribute('aria-valuenow', '1');
      expect(within(next).getByRole('progressbar', { name: goalsDone })).toHaveAttribute('aria-valuemax', '5');
      expect(within(next).getByRole('button', { name: /Price list/ })).toBeInTheDocument();
      expect(within(next).getByRole('button', { name: /Pick a payment provider/ })).toBeInTheDocument();
      /* The line that waits for the person's answer opens its task like the lines with work under them; a line with neither
         opens from its title alone. */
      expect(within(within(next).getByRole('listitem', { name: '#16 Price list' })).queryByRole('button', { name: open })).not.toBeInTheDocument();
      const closed = screen.getByRole('region', { name: closedHeading });
      /* Every closed release starts folded to its line. */
      expect(within(closed).getAllByRole('button').map(fold => fold.getAttribute('aria-expanded'))).toEqual(['false']);
      expect(within(closed).queryAllByRole('listitem')).toHaveLength(0);
      expect(within(closed).queryByRole('button', { name: /Login page/ })).not.toBeInTheDocument();
      await user.click(within(within(next).getByRole('listitem', { name: '#9 Pick a payment provider' })).getByRole('button', { name: open }));
      await waitFor(() => expect(calls.some(call => call.path === '/api/tasks/t9')).toBe(true));
      await user.click(within(closed).getByRole('button', { name: new RegExp(`${released}.*${count}`) }));
      expect(await within(closed).findByRole('button', { name: /Login page/ })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it.each([
    ['en', 'Tasks', 'Turns and releases', 'Every slot of the turn is busy, so these start when a turn opens, in this order.', ['Waiting for the next turn', 'Waiting for the turn after next', 'Waiting 3 turns ahead']],
    ['ru', 'Задачи', 'Ходы и выпуски', 'Все места хода заняты, поэтому эти задачи начнутся, когда откроется ход, в таком порядке.', ['Ждут следующего хода', 'Ждут хода после следующего', 'Ждут хода через 3 хода']],
  ])('shows the queue of a department a batch for each turn ahead, in its order (%s)', async (lang, tasks, releases, why, headings) => {
    localStorage.setItem('hh-lang', lang);
    try {
      const user = userEvent.setup();
      const waiting = (id: string, number: number, ahead: number, position: number) =>
        ({ ...PLANNED, id, number, title: `Queued ${number}`, assignee: null, queue: { ahead, position, openTurn: 3 } });
      shell({ [`GET ${ALL}`]: [200, { tasks: [...TASKS, waiting('q1', 41, 1, 1), waiting('q2', 42, 2, 2), waiting('q3', 43, 3, 3), waiting('q4', 44, 1, 1)].map(t => t) }] });
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${tasks}`) }));
      await goTo(user, releases);
      expect(await screen.findByText(why)).toBeInTheDocument();
      const regions = headings.map(name => screen.getByRole('region', { name }));
      expect(within(regions[0]!).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#41 Queued 41', '#44 Queued 44']);
      expect(within(regions[1]!).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#42 Queued 42']);
      expect(within(regions[2]!).getAllByRole('listitem').map(li => li.getAttribute('aria-label'))).toEqual(['#43 Queued 43']);
      /* The turn getting ready does not count them among its goals. */
      expect(screen.getAllByRole('listitem', { name: '#41 Queued 41' })).toHaveLength(1);
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it.each([
    ['en', 'Turns and releases', 'Show', 'Outside releases', 'Releases', 'Getting ready: turn 3, the release after v1.2.0'],
    ['ru', 'Ходы и выпуски', 'Показать', 'Задачи вне выпуска', 'Выпуски', 'Готовится: ход 3, выпуск после v1.2.0'],
  ])('shows the work outside every release apart, on its own choice (%s)', async (lang, releases, show, outside, back, preparing) => {
    localStorage.setItem('hh-lang', lang);
    try {
      const user = userEvent.setup();
      const sales = { ...PLANNED, id: 't17', number: 17, title: 'Spring mailing', department: { id: 'd3', name: 'Sales' } };
      shell({ [`GET ${ALL}`]: [200, { tasks: [...TASKS, sales] }] });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await goTo(user, releases);
      const choice = await screen.findByRole('group', { name: show });
      expect(screen.getByRole('region', { name: preparing })).toBeInTheDocument();
      expect(screen.queryByRole('article', { name: '#17 Spring mailing' })).not.toBeInTheDocument();
      await user.click(within(choice).getByRole('radio', { name: outside }));
      expect(await screen.findByRole('article', { name: '#17 Spring mailing' })).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: preparing })).not.toBeInTheDocument();
      await user.click(within(choice).getByRole('radio', { name: back }));
      expect(await screen.findByRole('region', { name: preparing })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it.each([
    ['en', 'Tasks', 'Development', 'Waits for a person: 1', 'Not started: 1'],
    ['ru', 'Задачи', 'Разработка', 'Ждет человека: 1', 'Не начата: 1'],
  ])('says in plain words that a task waits for the answer of the person and that one has not started (%s)', async (lang, tasks, development, yours, notStarted) => {
    localStorage.setItem('hh-lang', lang);
    try {
      const user = userEvent.setup();
      shell({});
      await user.click(await screen.findByRole('button', { name: new RegExp(`^${tasks}`) }));
      await goTo(user, new RegExp(`^${development}`));
      expect(within(await screen.findByRole('region', { name: yours })).getByRole('listitem', { name: '#9 Pick a payment provider' })).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: notStarted })).getByRole('listitem', { name: '#14 Refund button' })).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it("lists every department's turns by turn and release, and only the picked department's when one is picked", async () => {
    const user = userEvent.setup();
    const launch = { ...TURN, id: 'u5', number: 5, title: 'Spring launch', goal: 'Tell people.', departmentId: 'd3', messages: [] };
    shell({ 'GET /api/turns': [200, { turns: [FINISHED_TURN, TURN, launch] }] });
    await openTasks(user);
    await goTo(user, 'Turns and releases');
    expect(await screen.findByText(/turn 5/)).toBeInTheDocument();
    expect(screen.getByText(/turn 3/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Department' }), 'Development');
    expect(screen.getByText(/turn 3/)).toBeInTheDocument();
    expect(screen.queryByText(/turn 5/)).not.toBeInTheDocument();
  });

  it('shows the version a turn came out as, and no way to pick how a turn runs, as each is the next release of its department', async () => {
    const user = userEvent.setup();
    shell({});
    await openTasks(user);
    await goTo(user, 'Turns and releases');
    await user.click(await screen.findByRole('button', { name: /Turn 2: release v1\.2\.0/ }));
    expect(await screen.findByRole('button', { name: /Login page/ })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'How the turn runs' })).not.toBeInTheDocument();
    expect(screen.queryByText(/How the turn runs/)).not.toBeInTheDocument();
  });

  it.each([
    ['en', 'Choose: Price page', 'Give to the head of the department: 1', 'Given to the head of the department: #20.'],
    ['ru', 'Выбрать: Price page', 'Отдать главе отдела: 1', 'Отдано главе отдела: #20.'],
  ])('gives the chosen items to the head of the department at once, with no mode to pick (%s)', async (lang, choose, give, given) => {
    localStorage.setItem('hh-lang', lang);
    try {
      const user = userEvent.setup();
      const calls = shell({
        'GET /api/departments/d2/backlog': [200, { items: [{ id: 'i1', departmentId: 'd2', title: 'Price page', text: '', by: { id: 'p1', name: 'Ivan' }, at: '2026-10-30T08:00:00.000Z' }] }],
        'POST /api/departments/d2/backlog/schedule': [200, { tasks: [{ id: 't20', number: 20 }] }],
      });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await goTo(user, lang === 'en' ? 'Turns and releases' : 'Ходы и выпуски');
      await user.selectOptions(screen.getByRole('combobox', { name: lang === 'en' ? 'Department' : 'Отдел' }), lang === 'en' ? 'Development' : 'Разработка');
      await user.click(await screen.findByRole('checkbox', { name: choose }));
      expect(screen.queryByRole('combobox', { name: lang === 'en' ? 'How the next turn runs' : 'Как пойдет следующий ход' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: give }));
      await waitFor(() => expect(calls.find(c => c.method === 'POST' && c.path.endsWith('/schedule'))?.body).toEqual({ ids: ['i1'] }));
      expect(await screen.findByText(given)).toBeInTheDocument();
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });
});

/* Cards Hornhoof keeps for the person: of a version marked in the code with no release recorded, of a turn that is over. */
describe('cards for the person', () => {
  const TAG = {
    id: 'c1', about: 'release_tag', taskId: TASKS[0]!.id, number: TASKS[0]!.number, kind: null, level: null, words: 'Server words.', at: '2026-11-14T10:00:00.000Z',
    turn: { number: 24, version: null }, tag: { version: 'v1.7.0', why: 'unrecorded' },
  };
  const STALE = { ...TAG, id: 'c3', tag: { version: 'v1.7.1', why: 'stale' } };
  const SUMMARY = { ...TAG, id: 'c2', about: 'turn_summary', turn: { number: 23, version: 'v1.6.0' }, tag: null, at: '2026-11-13T10:00:00.000Z' };

  it.each([
    ['en', 'A version was marked without a release', 'Version v1.7.0 was marked in the code, but its release was not recorded and approved beforehand. So the tasks of Turn 24 are not counted as released, and the turn stays open. The head of the department was told.',
      'Version v1.7.1 was marked in the code, but the full check or the approval its release relied on no longer holds.', 'Turn 23 is over', 'Turn 23 came out as version v1.6.0. What went into it is under “Turns and releases”.', 'Open task'],
    ['ru', 'Версия отмечена без записи выпуска', 'Версия v1.7.0 отмечена в коде, но ее выпуск не был записан и одобрен заранее. Поэтому задачи хода 24 не считаются выпущенными, и ход остается открытым. Глава отдела уже знает.',
      'Версия v1.7.1 отмечена в коде, но полная проверка или одобрение, на которых держался ее выпуск, больше не действуют.', 'Ход 23 закончен', 'Ход 23 вышел версией v1.6.0. Что в него вошло, видно в разделе «Ходы и выпуски».', 'Открыть задачу'],
  ])('shows a version marked without a release and a turn that is over in plain words, and opens the task (%s)', async (lang, tagTitle, tagWords, staleWords, summaryTitle, summaryWords, open) => {
    localStorage.setItem('hh-lang', lang);
    try {
      const user = userEvent.setup();
      const calls = shell({ 'GET /api/wait-cards': [200, { cards: [TAG, STALE, SUMMARY], next: null }] });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      const [tag, stale] = await screen.findAllByRole('region', { name: tagTitle });
      expect(tag).toHaveTextContent(tagWords);
      expect(stale).toHaveTextContent(staleWords);
      expect(screen.getByRole('region', { name: summaryTitle })).toHaveTextContent(summaryWords);
      expect(screen.queryByText('Server words.')).not.toBeInTheDocument();
      await user.click(within(tag!).getByRole('button', { name: open }));
      await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'GET', path: `/api/tasks/${TASKS[0]!.id}` })));
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('says the person saw a card, which then goes, and nothing waits for them any more', async () => {
    const user = userEvent.setup();
    let seen = false;
    const calls = shell({
      'GET /api/requests': [200, decisions([])],
      'GET /api/wait-cards': () => [200, { cards: seen ? [] : [TAG], next: null }],
      'POST /api/wait-cards/c1/ack': () => { seen = true; return [200, { ok: true }]; },
    });
    await openTasks(user);
    const card = await screen.findByRole('region', { name: 'A version was marked without a release' });
    expect(screen.queryByText('Nothing waits for you.')).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/api/wait-cards/c1/ack' })));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'A version was marked without a release' })).not.toBeInTheDocument());
  });

  it("keeps the person's own cards out of sight while another person's decisions are shown", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 1, p4: 1 })], 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: 'p4' }, REQUESTS[1]!])], 'GET /api/wait-cards': [200, { cards: [TAG], next: null }] });
    await user.click(await screen.findByRole('button', { name: 'Dan: 1 decision waits' }));
    await screen.findByRole('region', { name: 'Waiting for you' });
    expect(screen.getByRole('heading', { level: 1, name: 'Waits for Dan' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'A version was marked without a release' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'View as' }), 'Me, Ivan');
    await user.click(await within(screen.getByRole('region', { name: 'Waiting for you' })).findByRole('button', { name: /Version .* was marked/, expanded: false }));
    expect(await screen.findByRole('region', { name: 'A version was marked without a release' })).toBeInTheDocument();
  });

  it('shows GitHub rate limit cards in Failures with and without a reset time', async () => {
    const user = userEvent.setup();
    const resetAt = Date.UTC(2030, 0, 1, 23, 45);
    shell({
      'GET /api/requests': [200, {
        ...decisions([]),
        githubLimits: [
          { repository: 'acme/shop', resetAt },
          { repository: 'acme/docs', resetAt: null },
        ],
      }],
    });
    await openTasks(user);
    await goTo(user, /^Failures/);
    const timed = await screen.findByRole('region', { name: 'GitHub request limit reached for acme/shop' });
    expect(within(timed).getByText('Try the blocked action again after 23:45 UTC.')).toBeInTheDocument();
    const untimed = await screen.findByRole('region', { name: 'GitHub request limit reached for acme/docs' });
    expect(within(untimed).getByText('GitHub gave no reset time. Try the action again later.')).toBeInTheDocument();
  });
});
