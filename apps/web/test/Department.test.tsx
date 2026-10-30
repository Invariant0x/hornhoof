import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import type { Me, Org } from '../src/types';
import { CARD, DEV_ORG, ME, mockApi, ROSTER, TASK_DETAIL, TASKS } from './api-mock';
import { fakeStream } from './fake-stream';

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

describe('Department view', () => {
  it('flies into a department and shows its head and members', async () => {
    const user = userEvent.setup();
    shell();
    await flyIn(user);
    const head = screen.getByRole('region', { name: 'Head' });
    expect(within(head).getByRole('button', { name: /Dana/ })).toHaveTextContent('Head of development');
    expect(within(head).getByText('Working')).toBeInTheDocument();
    const members = screen.getByRole('region', { name: 'Members' });
    const bruno = within(members).getByRole('button', { name: /Bruno/ });
    expect(bruno).toHaveTextContent('Backend engineer');
    expect(bruno).toHaveTextContent('Claude Sonnet 5.5');
    expect(bruno).toHaveTextContent('Anthropic');
    expect(within(members).getByText('Sleeping')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Products' })).getByText('Mascot')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'People with access' })).getByText('Sasha')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to the map' }));
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
    const people = screen.getByRole('region', { name: 'People with access' });
    expect(within(people).getAllByRole('listitem').map(li => li.querySelector('b')!.textContent)).toEqual(['Sasha', 'Oleg']);
  });

  it('shows an employee start working while the department is open', async () => {
    const user = userEvent.setup();
    const stream = fakeStream();
    const [dev] = DEV_ORG.departments;
    const busy: Org = { ...DEV_ORG, departments: [{ ...dev!, employees: dev!.employees.map(e => ({ ...e, state: 'working' as const })) }] };
    let started = false;
    shell({ 'GET /api/org': () => [200, started ? busy : DEV_ORG] });
    await flyIn(user);
    const bruno = within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ });
    expect(bruno).toHaveTextContent('Sleeping');
    started = true;
    stream.send({ type: 'working', working: 2 });
    await vi.waitFor(() => expect(within(screen.getByRole('region', { name: 'Members' })).getByRole('button', { name: /Bruno/ })).toHaveTextContent('Working'));
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

  it('opens an employee card from the department', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/agents/b1': [200, CARD] });
    await flyIn(user);
    await user.click(screen.getByRole('button', { name: /Bruno/ }));
    expect(await screen.findByRole('button', { name: 'Open terminal' })).toBeInTheDocument();
  });

  it("lists the department's open tasks and opens one at the side", async () => {
    const user = userEvent.setup();
    shell({ [DEV_TASKS]: [200, { tasks: TASKS }], 'GET /api/tasks/t12': [200, { task: TASK_DETAIL }] });
    await flyIn(user);
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    const row = await within(tasks).findByRole('button', { name: /#12 Checkout API/ });
    expect(row).toHaveTextContent('Gate 2 of 3');
    expect(within(tasks).getAllByRole('button', { name: /^#/ }).map(b => b.querySelector('b')!.textContent)).toEqual(['#9', '#12', '#11']);
    await user.click(row);
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
  });

  it('gives the department a task through its head', async () => {
    const user = userEvent.setup();
    const made = { ...TASK_DETAIL, id: 't14', number: 14, title: 'Refund API' };
    const calls = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'POST /api/tasks': [201, { task: made }], 'GET /api/tasks/t14': [200, { task: made }] });
    await flyIn(user);
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

  it('asks for a head before the department takes tasks', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell({ [DEV_TASKS]: [200, { tasks: [] }] }, { ...DEV_ORG, departments: [{ ...dev!, employees: [] }] });
    await flyIn(user);
    const tasks = screen.getByRole('region', { name: 'Tasks' });
    expect(within(tasks).getByText('Tasks go to the department through its head. Hire one first.')).toBeInTheDocument();
    expect(within(tasks).queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
  });

  it('lets a person whose access lists the department give it tasks', async () => {
    const user = userEvent.setup();
    const [dev] = DEV_ORG.departments;
    shell({ [DEV_TASKS]: [200, { tasks: [] }] }, { ...DEV_ORG, departments: [{ ...dev!, people: [...dev!.people, LENA] }] }, listed('p6', 'Lena'));
    await flyIn(user);
    expect(within(screen.getByRole('region', { name: 'Tasks' })).getByRole('button', { name: 'New task' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Repository' })).not.toBeInTheDocument();
  });

  it("keeps a department's tasks from people who do not reach it", async () => {
    const user = userEvent.setup();
    const calls = shell({}, DEV_ORG, listed('p7', 'Kira'));
    await flyIn(user);
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

  it("gives a product its own repository with a token", async () => {
    const user = userEvent.setup();
    const calls = shell({ [DEV_TASKS]: [200, { tasks: [] }], 'PUT /api/departments/pd1/repository': [200, { repository: REPO }] });
    await flyIn(user);
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
