import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import type { Me } from '../src/types';
import { CARD, decisions, DEV_ORG, ME, mockApi, REQUESTS, signedOut, TASKS, TURN } from './api-mock';
import { fakeStream } from './fake-stream';

const MARIA: Me = { ...ME, person: { ...ME.person, id: 'p2', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', isOwner: false } };

type Reply = [number, unknown?];

/* Whether each drawing from now on still had a department of the one before. */
function drawingsFromNow(container: HTMLElement) {
  const oldCompany: boolean[] = [];
  const observer = new MutationObserver(() => {
    oldCompany.push(!!screen.queryByRole('button', { name: /^Development/ }));
  });
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  return { oldCompany, stop: () => observer.disconnect() };
}

/* What the Tasks screen asks for, with a question #9 that both people may answer. */
const TRACKER: Record<string, Reply> = {
  'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
  'GET /api/requests': [200, decisions(REQUESTS)],
  'GET /api/turns': [200, { turns: [TURN] }],
  'GET /api/tasks?status=all': [200, { tasks: TASKS }],
};

async function answerField(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
  const waiting = await screen.findByRole('region', { name: 'Waiting for you' });
  return within(await within(waiting).findByRole('article', { name: /#9/ })).getByLabelText('Your answer');
}

/* Lets the answers for the one before come now, late, and runs their promise chains, which have no timer in them. */
const answerLate = (late: ((reply: Reply) => void)[]) => act(async () => {
  for (const answer of late.splice(0)) answer([200, DEV_ORG]);
  await new Promise(r => setImmediate(r));
});

describe('App', () => {
  it('opens setup when no company exists', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: true }] });
    render(<App />);
    expect(await screen.findByText('Set up your company')).toBeInTheDocument();
  });

  it('opens log in when there is no session', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [401, signedOut] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
  });

  it('opens the invite screen on an invite link without checking the session', async () => {
    window.history.replaceState(null, '', '/invite/abc123');
    const calls = mockApi({ 'GET /api/invites/abc123': [200, { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true, departments: [], teams: [] } }] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: /^Join/ })).toBeInTheDocument();
    expect(calls.map(c => c.path)).not.toContain('/api/me');
  });

  it('offers work as soon as a person with limited access accepts their invitation', async () => {
    window.history.replaceState(null, '', '/invite/abc123');
    const me: Me = { ...MARIA, person: { ...MARIA.person, scopeKind: 'listed' } };
    mockApi({
      'GET /api/invites/abc123': [200, { companyName: 'Acme', name: 'Maria', email: me.person.email, title: '', access: { whole: false, departments: [], teams: [] } }],
      'POST /api/invites/abc123/accept': [200, { person: me.person }],
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': [200, me],
      'GET /api/orchestrator/first-contact': [200, { offers: ['fixProject', 'checkSetup', 'telegram', 'assistant'] }],
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Choose a password'), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Talk to the orchestrator' });
    expect(await within(dialog).findByRole('button', { name: 'Set up my personal assistant' })).toBeInTheDocument();
  });

  it('shows the version and build in a corner on every screen, login too', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [401, signedOut], 'GET /api/version': [200, { version: '0.4.0', commit: 'abc1234def', migrations: 5 }] });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(await screen.findByText('0.4.0 (abc1234)')).toHaveClass('version-mark');
  });

  it('opens the workspace once the person logs in', async () => {
    let signedIn = false;
    mockApi({
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': () => (signedIn ? [200, ME] : [401, signedOut]),
      'POST /api/auth/login': () => ((signedIn = true), [200, { person: ME.person }]),
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Email'), 'ivan@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it('shows the next person who logs in on the tab nothing of the company the one before saw, nor its late answer', async () => {
    const stream = fakeStream();
    let person: Me | null = ME;
    let held = false;
    const late: ((reply: Reply) => void)[] = [];
    mockApi({
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': () => (person ? [200, person] : [401, signedOut]),
      'POST /api/auth/logout': () => ((person = null), [204]),
      'POST /api/auth/login': () => ((person = MARIA), [200, { person: MARIA.person }]),
      /* Maria's company is still on its way; Ivan's answer, once held, comes only when the test lets it. */
      'GET /api/org': () => (person === MARIA ? new Promise<Reply>(() => {}) : held ? new Promise<Reply>(answer => late.push(answer)) : [200, DEV_ORG]),
    });
    const user = userEvent.setup();
    const { container } = render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByRole('button', { name: /^Development/ })).toBeInTheDocument();
    held = true;
    stream.send({ type: 'org' });
    expect(late.length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await user.type(await screen.findByLabelText('Email'), 'maria@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    /* Nothing of the company is on the log in screen, so every drawing from here on is Maria's. */
    const drawings = drawingsFromNow(container);
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account' })).toHaveTextContent('M'));
    await answerLate(late);
    drawings.stop();
    expect(drawings.oldCompany.length).toBeGreaterThan(0);
    expect(drawings.oldCompany).not.toContain(true);
    expect(container.querySelector('.map[aria-busy]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Development/ })).not.toBeInTheDocument();
  });

  it('shows another person who comes on the tab without a log in screen nothing of the company the one before saw, nor its late answer', async () => {
    const stream = fakeStream();
    let left = false;
    let held = false;
    let mariaIsHere: ((reply: Reply) => void) | null = null;
    const late: ((reply: Reply) => void)[] = [];
    mockApi({
      'GET /api/setup': [200, { needed: false }],
      /* Another tab signs Maria in before this one hears who is here once Ivan left. */
      'GET /api/me': () => (left ? new Promise<Reply>(answer => (mariaIsHere = answer)) : [200, ME]),
      'POST /api/auth/logout': () => ((left = true), [204]),
      'GET /api/org': () => (left ? new Promise<Reply>(() => {}) : held ? new Promise<Reply>(answer => late.push(answer)) : [200, DEV_ORG]),
    });
    const user = userEvent.setup();
    const { container } = render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByRole('button', { name: /^Development/ })).toBeInTheDocument();
    held = true;
    stream.send({ type: 'org' });
    expect(late.length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(mariaIsHere).not.toBeNull());
    const drawings = drawingsFromNow(container);
    await act(async () => {
      mariaIsHere!([200, MARIA]);
      await new Promise(r => setImmediate(r));
    });
    await answerLate(late);
    drawings.stop();
    expect(screen.queryByRole('button', { name: /^Development/ })).not.toBeInTheDocument();
    expect(container.querySelector('.map[aria-busy]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account' })).toHaveTextContent('M');
    expect(drawings.oldCompany.length).toBeGreaterThan(0);
    expect(drawings.oldCompany).not.toContain(true);
  });

  it('shows the next person who logs in on the tab no answer the one before typed and did not send', async () => {
    fakeStream();
    let person: Me | null = ME;
    mockApi({
      ...TRACKER,
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': () => (person ? [200, person] : [401, signedOut]),
      'POST /api/auth/logout': () => ((person = null), [204]),
      'POST /api/auth/login': () => ((person = MARIA), [200, { person: MARIA.person }]),
      'GET /api/org': [200, DEV_ORG],
    });
    const user = userEvent.setup();
    render(<StrictMode><App /></StrictMode>);
    await user.type(await answerField(user), 'Ivan: not sent yet');
    /* Ivan's own draft stays with him while he goes elsewhere and back. */
    await user.click(screen.getByRole('button', { name: /^Map/ }));
    expect(await answerField(user)).toHaveValue('Ivan: not sent yet');
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await user.type(await screen.findByLabelText('Email'), 'maria@acme.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account' })).toHaveTextContent('M'));
    expect(await answerField(user)).toHaveValue('');
  });

  it('shows another person who comes on the tab without a log in screen no answer the one before typed and did not send', async () => {
    fakeStream();
    let person = ME;
    mockApi({
      ...TRACKER,
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': () => [200, person],
      /* Another tab signs Maria in before this one hears who is here once Ivan left. */
      'POST /api/auth/logout': () => ((person = MARIA), [204]),
      'GET /api/org': [200, DEV_ORG],
    });
    const user = userEvent.setup();
    render(<StrictMode><App /></StrictMode>);
    await user.type(await answerField(user), 'Ivan: not sent yet');
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Account' })).toHaveTextContent('M'));
    expect(await answerField(user)).toHaveValue('');
  });

  it('opens the workspace when a person who joined from an invite skips connecting a subscription', async () => {
    window.history.replaceState(null, '', '/invite/tok1');
    mockApi({
      'GET /api/invites/tok1': [200, { companyName: 'Acme', name: 'Maria', email: 'maria@acme.com', title: '', access: { whole: true, departments: [], teams: [] } }],
      'POST /api/invites/tok1/accept': [200, { person: ME.person }],
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': [200, ME],
    });
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText('Choose a password'), 'long-enough-pass');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  /* The invite link is the one link a person who joined has, so it still leads in once it is used. */
  async function fromUsedInvite(me: [number, unknown]) {
    window.history.replaceState(null, '', '/invite/old');
    mockApi({
      'GET /api/invites/old': [410, { error: { code: 'gone', message: 'This invite has already been used or has expired. Ask for a new one.' } }],
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': me,
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Go to the company' }));
  }

  it('opens the workspace from a used invite link for a signed-in person', async () => {
    await fromUsedInvite([200, ME]);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('opens log in from a used invite link for a signed-out person', async () => {
    await fromUsedInvite([401, signedOut]);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('opens the workspace for a signed-in person', async () => {
    mockApi({ 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [200, ME] });
    render(<App />);
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });
});
