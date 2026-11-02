import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { ComputerAccessDecision, Me, Org, ProposalDecision } from '../src/types';
import { CLOSED_TASKS, decisions, DEV_ORG, FINISHED_TURN, ME, mockApi, PLANNED_TURN, REQUESTS, TASKS, TURN } from './api-mock';
import { fakeStream } from './fake-stream';

const ALL = '/api/tasks?status=all';
const PLANNED = { ...TASKS[1]!, id: 't14', number: 14, title: 'Refund button', brief: '', status: 'planned' as const, assignee: null, turn: 4 };
const SUBTASK = { ...TASKS[1]!, id: 't13', number: 13, title: 'Card form', brief: '', status: 'open' as const, parentId: 't12' };

function shell(routes: Record<string, unknown> = {}, me: Me = ME) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
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

  it('shows the running turn with its title, main point, progress and tasks, and nothing to start or close', async () => {
    const user = userEvent.setup();
    shell();
    await openTasks(user);
    const turn = screen.getByRole('region', { name: 'Turn 3' });
    expect(turn).toHaveTextContent('Running');
    expect(within(turn).getByRole('heading', { name: 'Payments' })).toBeInTheDocument();
    expect(turn).toHaveTextContent('Take card payments in the shop.');
    expect(turn).toHaveTextContent('2 of 5 tasks done');
    expect(within(turn).getByRole('button', { name: /#12/ })).toHaveTextContent('In review');
    for (const name of ['Start turn', 'Close turn']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    /* The only fields are the answers to what agents ask. */
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    for (const box of screen.queryAllByRole('textbox')) expect(waiting).toContainElement(box);
  });

  it("shows the words a turn came from on click", async () => {
    const user = userEvent.setup();
    shell();
    await openTasks(user);
    const turn = screen.getByRole('region', { name: 'Turn 3' });
    const words = within(turn).getByText('The words it came from');
    expect(within(turn).getByText(/Stripe is fine/)).not.toBeVisible();
    await user.click(words);
    expect(within(turn).getByText(/Stripe is fine/)).toBeVisible();
    expect(turn).toHaveTextContent('Ivan');
  });

  it('nests a task under the one it serves', async () => {
    const user = userEvent.setup();
    shell();
    await openTasks(user);
    const parent = screen.getByRole('button', { name: /#12/ }).closest('li')!;
    expect(within(parent as HTMLElement).getByRole('button', { name: /#13/ })).toHaveTextContent('Card form');
  });

  it('lists the planned turns after the running one, and folds the finished ones away', async () => {
    const user = userEvent.setup();
    shell();
    await openTasks(user);
    const next = screen.getByRole('region', { name: 'Planned next' });
    const planned = within(next).getByRole('region', { name: 'Turn 4' });
    expect(planned).toHaveTextContent('Refunds');
    expect(planned).toHaveTextContent('1 task waiting for this turn');
    expect(within(planned).getByRole('button', { name: /#14/ })).toHaveTextContent('Planned');
    const finished = screen.getByRole('region', { name: 'Finished turns' });
    expect(finished).toHaveTextContent('Login');
    expect(within(finished).getByRole('button', { name: /#8/ })).not.toBeVisible();
  });

  it('keeps open tasks outside turns in view and folds the closed ones away', async () => {
    const user = userEvent.setup();
    shell({ [`GET ${ALL}`]: [200, { tasks: [{ ...TASKS[1]!, turn: null }, { ...CLOSED_TASKS[0]!, turn: null }] }] });
    await openTasks(user);
    expect(within(screen.getByRole('region', { name: 'Outside turns' })).getByRole('button', { name: /#11/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /#8/ })).not.toBeVisible();
    await user.click(screen.getByText('Closed outside turns: 1'));
    expect(screen.getByRole('button', { name: /#8/ })).toBeVisible();
  });

  it('opens the orchestrator to write to him, for people who see the whole company', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/orchestrator/events?after=0': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }] });
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
    expect(await screen.findByText(/No turns yet/)).toBeInTheDocument();
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
    expect(within(asked).getByRole('img', { name: 'Picture 1' })).toHaveAttribute('src', '/api/attachments/p0');
    expect(within(asked).getByRole('img', { name: 'Round' })).toHaveAttribute('src', '/api/attachments/p1');
    expect(within(asked).getByRole('link', { name: 'See the work' })).toHaveAttribute('href', 'https://preview.example.com/logo');
    /* A pick is made here only: words to the agent answer a question, not a choice. */
    expect(screen.getByRole('region', { name: 'Waiting for you' })).not.toHaveTextContent(/window or terminal/);
    await user.click(within(asked).getByRole('button', { name: /Square/ }));
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
    expect(approval).toHaveTextContent('Someone who sees the whole company approves it.');
    expect(within(approval).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(approval).queryByRole('button', { name: 'Decline' })).not.toBeInTheDocument();
  });

  it('filters the tasks by department', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'GET /api/tasks?status=all&department=d2': [200, { tasks: TASKS.slice(0, 1) }] });
    await openTasks(user);
    const review = screen.getByRole('button', { name: /#12/ });
    expect(review).toHaveTextContent('Checkout API');
    expect(review).toHaveTextContent('Gate 2 of 3');
    expect(review).toHaveTextContent('Tom');
    expect(review).toHaveTextContent('Development');
    await user.selectOptions(screen.getByLabelText('Department'), 'd2');
    await waitFor(() => expect(screen.queryByRole('button', { name: /#11/ })).not.toBeInTheDocument());
    expect(calls.some(c => c.path === '/api/tasks?status=all&department=d2')).toBe(true);
  });

  it('fetches the tasks again when one changes', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    let moved = false;
    shell({ [`GET ${ALL}`]: () => [200, { tasks: moved ? [{ ...TASKS[1]!, status: 'review', stage: 1, gateCount: 3 }] : TASKS }] });
    await openTasks(user);
    moved = true;
    stream.send({ type: 'task', id: 't11' });
    await waitFor(() => expect(screen.getByRole('button', { name: /#11/ })).toHaveTextContent('Gate 1 of 3'));
    expect(screen.getByRole('button', { name: /#11/ })).toHaveTextContent('In review');
  });

  it('keeps the newest list when an older answer comes after it', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    let moved = false;
    let hold = false;
    let late = () => {};
    shell({
      [`GET ${ALL}`]: () => {
        const reply: [number, unknown] = [200, { tasks: moved ? [{ ...TASKS[1]!, status: 'review', stage: 1, gateCount: 3 }] : TASKS }];
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
    await waitFor(() => expect(screen.getByRole('button', { name: /#11/ })).toHaveTextContent('Gate 1 of 3'));
    await act(async () => {
      late();
      await new Promise(r => setTimeout(r, 50));
    });
    expect(screen.getByRole('button', { name: /#11/ })).toHaveTextContent('Gate 1 of 3');
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
const COMPUTER: ComputerAccessDecision = { kind: 'computer_access', id: 'server', agent: { id: 'a1', name: 'Orchestrator' }, ownerPersonId: 'p1', canAnswer: true, at: AT, view: { available: true, until: null, asked: { reason: 'Inspect disk space.', at: AT }, machine: null } };

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
      'GET /api/requests': () => [200, decisions(REQUESTS, { proposals: [STRUCTURE], computerAccess: asked ? COMPUTER : null })],
      'POST /api/computer/open': () => {
        asked = false;
        return [200, { available: true, until: '2099-11-03T12:00:00.000Z', asked: null, machine: null }];
      },
    });
    expect(await screen.findByRole('button', { name: 'Tasks, 4 waiting for you' })).toBeInTheDocument();
    await openTasks(user);
    const waiting = screen.getByRole('region', { name: 'Waiting for you' });
    expect(within(waiting).getByRole('heading', { name: 'Company structure' })).toBeInTheDocument();
    expect(within(waiting).getByRole('button', { name: 'Create departments (1)' })).toBeInTheDocument();
    const computer = within(waiting).getByRole('region', { name: "The orchestrator asks for access to the server's computer" });
    expect(computer).toHaveTextContent('Inspect disk space.');
    await user.click(within(computer).getByRole('button', { name: 'Open access for a day' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/computer/open')).toBe(true);
    expect(await screen.findByRole('button', { name: 'Tasks, 3 waiting for you' })).toBeInTheDocument();
    expect(within(waiting).queryByRole('region', { name: /asks for access/ })).not.toBeInTheDocument();
  });

  it("show the CEO's own filter with the computer, and another person's without it", async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/org': [200, counted({ p1: 3, p4: 1 })], 'GET /api/requests': [200, decisions([{ ...REQUESTS[0]!, ownerPersonId: 'p4' }, REQUESTS[1]!], { proposals: [STRUCTURE], computerAccess: COMPUTER })] });
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

