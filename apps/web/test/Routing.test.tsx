import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { Shell } from '../src/screens/Shell';
import { CARD, DEV_ORG, MACHINES, ME, mockApi, PEOPLE, signedOut, SUBS, TASK_DETAIL, TASKS } from './api-mock';
import { openTaskAction } from './open-task';

function fixture(extra: Parameters<typeof mockApi>[0] = {}) {
  return mockApi({
    'GET /api/setup': [200, { needed: false }], 'GET /api/me': [200, ME],
    'GET /api/org': [200, DEV_ORG], 'GET /api/people': [200, { people: PEOPLE }],
    'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines: MACHINES }],
    'GET /api/tasks?status=all': [200, { tasks: TASKS }], 'GET /api/turns': [200, { turns: [] }],
    'GET /api/requests': [200, { requests: [], proposals: [], machineAccess: [], counts: { byPerson: {}, byAgent: {}, total: 0 } }],
    'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
    'GET /api/link': [200, { link: null, domain: 'example.test' }],
    'GET /api/nodes/commands': [200, { commands: [] }],
    'GET /api/improvements': [200, { improvements: [] }],
    'GET /api/updates': [200, { current: { version: '0.6.1', commit: 'routes', migrations: 57 }, latest: null, available: false, versions: [], error: null, checkedAt: null, updater: { present: false, status: null, waiting: null } }],
    ...extra,
  });
}
const tab = (name: string) => within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name });

describe('shareable workspace', () => {
  it('changes the address for every main tab', async () => {
    fixture();
    render(<Shell me={ME} onSignOut={() => {}} />);
    const user = userEvent.setup();
    for (const [name, path] of [['Tasks', '/tasks'], ['People', '/people'], ['Subscriptions & API', '/subscriptions'], ['Machines', '/machines'], ['Map', '/']]) {
      await user.click(tab(name!));
      expect(location.pathname).toBe(path);
    }
  });

  it.each([
    ['/tasks', 'heading', 'My tasks'],
    ['/people', 'heading', 'People'],
    ['/subscriptions', 'heading', 'Subscriptions & API'],
    ['/machines', 'heading', 'Machines'],
    ['/improvements', 'heading', 'Improvements'],
    ['/versions', 'dialog', 'Versions'],
    ['/tasks/t12', 'complementary', '#12 Checkout API'],
    ['/people/p2', 'heading', 'Edit Maria'],
    ['/machines/m1', 'article', 'dev-laptop'],
    ['/departments/d2', 'heading', 'Development'],
    ['/about', 'dialog', 'About Hornhoof'],
    ['/settings', 'dialog', 'Settings'],
    ['/settings/integrations', 'dialog', 'Settings'],
    ['/settings/company', 'dialog', 'Settings'],
  ])('opens %s directly', async (path, role, name) => {
    fixture();
    history.replaceState(null, '', path!);
    render(<App />);
    expect(await screen.findByRole(role!, { name })).toBeInTheDocument();
    expect(location.pathname).toBe(path);
  });

  it('follows popstate without remounting the shell', async () => {
    fixture();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await act(async () => {
      history.replaceState(null, '', '/people');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(await screen.findByRole('heading', { name: 'People' })).toBeInTheDocument();
    expect(tab('People')).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the department in the tracker under its task through close, history and related tasks', async () => {
    fixture({
      'GET /api/tasks/t10': [200, { task: { ...TASK_DETAIL, id: 't10', number: 10, title: 'Payments', parent: null } }],
    });
    history.replaceState(null, '', '/departments/d2');
    render(<Shell me={ME} onSignOut={() => {}} />);
    const user = userEvent.setup();
    await screen.findByRole('heading', { level: 2, name: 'Development' });
    await user.click(screen.getByRole('button', { name: 'Department tasks' }));
    expect(location.pathname + location.search).toBe('/tasks?department=d2');
    const department = await screen.findByRole('heading', { level: 1, name: 'Development / List' });
    const row = await within(await screen.findByRole('region', { name: 'List' })).findByRole('listitem', { name: '#12 Checkout API' });
    await user.click(within(row).getByRole('button', { name: 'Checkout API' }));
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    expect(location.pathname).toBe('/tasks/t12');
    expect(department).toBeVisible();
    await openTaskAction(user, panel, 'Comment');
    const comment = within(panel).getByRole('textbox', { name: 'Comment' });
    await user.type(comment, 'Keep this task draft');
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'About' }));
    await screen.findByRole('dialog', { name: 'About Hornhoof' });
    expect(department).toBeVisible();
    expect(panel).toBeVisible();
    await user.keyboard('{Escape}');
    expect(location.pathname).toBe('/tasks/t12');
    expect(comment).toHaveValue('Keep this task draft');
    await user.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(location.pathname + location.search).toBe('/tasks?department=d2');
    expect(department).toBeVisible();
    await act(async () => {
      const popped = new Promise<void>(resolve => globalThis.window.addEventListener('popstate', () => resolve(), { once: true }));
      history.back();
      await popped;
    });
    expect(location.pathname).toBe('/tasks/t12');
    expect(department).toBeVisible();
    const reopened = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await user.click(within(within(reopened).getByRole('navigation', { name: 'Where it belongs' })).getByRole('button', { name: '#10 Payments' }));
    const parent = await screen.findByRole('complementary', { name: '#10 Payments' });
    expect(department).toBeVisible();
    await user.click(within(parent).getByRole('button', { name: 'Close' }));
    expect(location.pathname + location.search).toBe('/tasks?department=d2');
  });

  it('closes a directly shared task to its task list', async () => {
    fixture();
    history.replaceState(null, '', '/tasks/t12');
    render(<Shell me={ME} onSignOut={() => {}} />);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    expect(await screen.findByRole('heading', { level: 1, name: 'My tasks' })).toBeVisible();
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Close' }));
    expect(location.pathname).toBe('/tasks');
  });

  it('keeps the selected person and title draft mounted beneath an account dialog', async () => {
    fixture();
    history.replaceState(null, '', '/people/p2');
    render(<Shell me={ME} onSignOut={() => {}} />);
    const user = userEvent.setup();
    const title = await screen.findByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Unsaved person title');
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'About' }));
    await screen.findByRole('dialog', { name: 'About Hornhoof' });
    expect(location.pathname).toBe('/about');
    expect(tab('People')).toHaveAttribute('aria-current', 'page');
    /* About has a Title of its own, for writing to Hornhoof developers; the person's stays first, beneath it. */
    expect(screen.getAllByLabelText('Title')[0]).toBe(title);
    expect(title).toHaveValue('Unsaved person title');
    await user.keyboard('{Escape}');
    expect(location.pathname).toBe('/people/p2');
    expect(screen.getByLabelText('Title')).toBe(title);
    expect(title).toHaveValue('Unsaved person title');
  });

  it('retains the local deep link after login and ignores an external return parameter', async () => {
    let signedIn = false;
    fixture({ 'GET /api/me': () => signedIn ? [200, ME] : [401, signedOut], 'POST /api/auth/login': () => { signedIn = true; return [200, { person: ME.person }]; } });
    history.replaceState(null, '', '/tasks/t12?next=https://outside.example');
    render(<App />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('complementary', { name: '#12 Checkout API' })).toBeInTheDocument();
    expect(location.pathname).toBe('/tasks/t12');
    expect(location.host).toBe('localhost:3000');
  });

  it.each(['/missing', '/departments/foreign', '/people/foreign', '/machines/foreign', '/tasks/foreign'])('shows an unavailable page for %s', async path => {
    fixture({ 'GET /api/tasks/foreign': [403, { error: { code: 'forbidden' } }] });
    history.replaceState(null, '', path);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(screen.queryByText('Foreign secret')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go to the map' }));
    await waitFor(() => expect(location.pathname).toBe('/'));
  });

  it('opens a person card without giving a restricted viewer editing controls', async () => {
    const me = { ...ME, person: { ...ME.person, isOwner: false, scopeKind: 'listed' as const } };
    fixture({ 'GET /api/me': [200, me] });
    history.replaceState(null, '', '/people/p2');
    render(<App />);
    await screen.findByRole('heading', { name: 'People' });
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(await screen.findByRole('heading', { name: 'Maria' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shares the selected person and machine and clears their addresses when closed', async () => {
    fixture();
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(tab('People'));
    await user.click(await screen.findByRole('button', { name: 'Edit Maria' }));
    expect(location.pathname).toBe('/people/p2');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(location.pathname).toBe('/people');
    await user.click(tab('Machines'));
    await user.click(await screen.findByRole('button', { name: 'Open the card of dev-laptop' }));
    expect(location.pathname).toBe('/machines/m1');
    await user.click(screen.getByRole('button', { name: 'Open the card of dev-laptop' }));
    expect(location.pathname).toBe('/machines');
  });

  it('minimizes the current agent when history opens a task, keeping its window mounted', async () => {
    fixture({
      'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
      'GET /api/agents/orchestrator/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    history.replaceState(null, '', '/');
    render(<Shell me={ME} onSignOut={() => {}} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Open the orchestrator' }));
    const window = await screen.findByRole('complementary', { name: 'Orchestrator' });
    await act(async () => {
      history.replaceState(null, '', '/tasks/t12');
      globalThis.window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('complementary', { name: '#12 Checkout API' });
    expect(window).toBeInTheDocument();
    expect(window).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore Orchestrator' })).toBeVisible();
  });

  it.each(['versions', 'improvements'])('blocks a restricted viewer from %s without showing the map behind it', async kind => {
    fixture();
    history.replaceState(null, '', `/${kind}`);
    render(<Shell me={{ ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } }} onSignOut={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open the orchestrator/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['/', '/api/org'], ['/tasks', '/api/tasks?status=all'], ['/subscriptions', '/api/subscriptions'],
    ['/people', '/api/people'], ['/machines', '/api/machines'], ['/improvements', '/api/improvements'],
    ['/versions', '/api/updates'],
  ])('offers the map when %s is denied by its API', async (path, api) => {
    fixture({ [`GET ${api}`]: [403, { error: { code: 'forbidden' } }] });
    history.replaceState(null, '', path!);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Insufficient permissions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to the map' })).toBeInTheDocument();
  });

  it('shows the history-selected machine even when the current search excludes it', async () => {
    fixture();
    history.replaceState(null, '', '/machines/m1');
    render(<Shell me={ME} onSignOut={() => {}} />);
    const user = userEvent.setup();
    await screen.findByRole('article', { name: 'dev-laptop' });
    await user.click(screen.getByRole('button', { name: 'Open the card of build-box' }));
    await user.type(screen.getByRole('searchbox'), 'build-box');
    await act(async () => {
      const popped = new Promise<void>(resolve => globalThis.window.addEventListener('popstate', () => resolve(), { once: true }));
      history.back();
      await popped;
    });
    expect(location.pathname).toBe('/machines/m1');
    expect(screen.getByRole('article', { name: 'dev-laptop' })).toBeVisible();
  });

  it('closes a revisited account dialog to the section stored in that history entry', async () => {
    fixture();
    const user = userEvent.setup();
    render(<Shell me={ME} onSignOut={() => {}} />);
    await user.click(tab('People'));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'About' }));
    await screen.findByRole('dialog', { name: 'About Hornhoof' });
    await user.keyboard('{Escape}');
    await user.click(tab('Machines'));
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('dialog', { name: 'Settings' });
    await user.keyboard('{Escape}');
    await act(async () => {
      const popped = new Promise<void>(resolve => globalThis.window.addEventListener('popstate', () => resolve(), { once: true }));
      history.go(-4);
      await popped;
    });
    expect(location.pathname).toBe('/about');
    await screen.findByRole('dialog', { name: 'About Hornhoof' });
    await user.keyboard('{Escape}');
    expect(location.pathname).toBe('/people');
  });
});
