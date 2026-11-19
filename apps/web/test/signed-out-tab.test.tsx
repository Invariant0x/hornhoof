import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, onSignedOut } from '../src/api';
import { App } from '../src/App';
import { keyDefaults } from '../src/owner-key-store';
import { page } from '../src/updates';
import type { Me } from '../src/types';
import { CARD, decisions, DEV_ORG, ME, mockApi, REQUESTS, TASKS, TURN } from './api-mock';
import { fakeStream } from './fake-stream';

type Reply = [number, unknown?];

/* What the server answers every request of a session it no longer knows, as requirePerson does. */
const SIGNED_OUT = { error: { code: 'unauthorized', message: 'Sign in to continue.', reason: 'signed_out' } };
const WRONG_PASSWORD = { error: { code: 'unauthorized', message: 'Wrong email or password.', reason: 'wrong_password' } };
const MEMBER: Me = { ...ME, person: { ...ME.person, scopeKind: 'listed', isOwner: false } };

/* What the Tasks screen asks for, with a question #9 the person may answer. */
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

async function logIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Email'), 'ivan@acme.com');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
}

/* The builds the server answers on /api/build, one per look, the last one again for every look after them. */
function builds(...answers: Reply[]): Record<string, () => Reply> {
  let looks = 0;
  return { 'GET /api/build': () => answers[Math.min(looks++, answers.length - 1)]! };
}

const build = (id: string): Reply => [200, { build: id }];

/* The page's own clock: the build is looked at again only as the test moves it. */
function testClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

/* The page looks at the build every five minutes while it is seen. */
const LOOK_MS = 5 * 60_000;
const nextLooks = (looks: number) => act(() => vi.advanceTimersByTimeAsync(LOOK_MS * looks));
const asked = (calls: { path: string }[], path: string) => calls.filter(c => c.path === path).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('the page hears that its session ended', () => {
  it('from a read, a change, a text and a file the server refused as signed out, and never from a wrong password', async () => {
    const heard: string[] = [];
    const stop = onSignedOut(() => heard.push('ended'));
    try {
      mockApi({
        'GET /api/read': [401, SIGNED_OUT], 'POST /api/change': [401, SIGNED_OUT], 'GET /api/text': [401, SIGNED_OUT], 'GET /api/file': [401, SIGNED_OUT],
        'POST /api/auth/login': [401, WRONG_PASSWORD],
      });
      await expect(api.post('/api/auth/login', {})).rejects.toMatchObject({ status: 401, reason: 'wrong_password' });
      expect(heard).toEqual([]);
      await expect(api.get('/api/read')).rejects.toMatchObject({ reason: 'signed_out' });
      await expect(api.post('/api/change', {})).rejects.toMatchObject({ reason: 'signed_out' });
      await expect(api.text('/api/text')).rejects.toMatchObject({ reason: 'signed_out' });
      await expect(api.streamBytes('/api/file')).rejects.toMatchObject({ reason: 'signed_out' });
      expect(heard).toEqual(['ended', 'ended', 'ended', 'ended']);
    } finally {
      stop();
    }
    await expect(api.get('/api/read')).rejects.toMatchObject({ reason: 'signed_out' });
    expect(heard).toHaveLength(4);
  });
});

describe('a tab whose session ended', () => {
  it('goes to log in at once and forgets the owner key, the company and the drafts, as when the person changes', async () => {
    const stream = fakeStream();
    let ended = false;
    let signedInAgain = false;
    let orgAgain: ((reply: Reply) => void) | null = null;
    const session = (reply: Reply) => (): Reply => (ended ? [401, SIGNED_OUT] : reply);
    mockApi({
      ...Object.fromEntries(Object.entries(TRACKER).map(([route, reply]) => [route, session(reply)])),
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': session([200, ME]),
      'POST /api/auth/login': () => ((ended = false), [200, { person: ME.person }]),
      /* After the new log in the company is still on its way, so whatever the map draws then is of the tab's memory. */
      'GET /api/org': () => (ended ? [401, SIGNED_OUT] : orgAgain === null && signedInAgain ? new Promise<Reply>(answer => (orgAgain = answer)) : [200, DEV_ORG]),
    });
    await keyDefaults.store.put({ publicKey: 'device-public-key', privateKey: {} as CryptoKey });
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.type(await answerField(user), 'Ivan: not sent yet');
    /* The draft stays with Ivan while he goes back to the map, where the tab stays once he logs in again. */
    await user.click(screen.getByRole('button', { name: /^Map/ }));
    expect(await screen.findByRole('button', { name: /^Development/ })).toBeInTheDocument();

    /* The server ends the session; the next look of the open page is refused. */
    ended = true;
    stream.send({ type: 'org' });
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(await keyDefaults.store.get()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Development/ })).not.toBeInTheDocument();

    signedInAgain = true;
    await logIn(user);
    await waitFor(() => expect(container.querySelector('.map[aria-busy]')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^Development/ })).not.toBeInTheDocument();
    await waitFor(() => expect(orgAgain).not.toBeNull());
    await act(async () => {
      orgAgain!([200, DEV_ORG]);
      await new Promise(r => setImmediate(r));
    });
    expect(await answerField(user)).toHaveValue('');
  });

  it('still shows a wrong password on log in, and asks nothing again by itself', async () => {
    const calls = mockApi({
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': [401, SIGNED_OUT],
      'POST /api/auth/login': [401, WRONG_PASSWORD],
    });
    const user = testClock();
    render(<App />);
    await logIn(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');
    await nextLooks(3);
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong email or password.');
    expect(asked(calls, '/api/me')).toBe(1);
    expect(asked(calls, '/api/auth/login')).toBe(1);
  });
});

describe('a signed-out tab and a new build', () => {
  const signedOut = { 'GET /api/setup': [200, { needed: false }], 'GET /api/me': [401, SIGNED_OUT] } satisfies Record<string, Reply>;

  it('reloads once the server runs another build', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    mockApi({ ...signedOut, ...builds(build('build-one'), build('build-two')) });
    testClock();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    await nextLooks(1);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('does not reload while the server runs the same build', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const calls = mockApi({ ...signedOut, ...builds(build('build-one')) });
    testClock();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    await nextLooks(3);
    expect(asked(calls, '/api/build')).toBeGreaterThanOrEqual(4);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when a look at the build fails', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    const calls = mockApi({ ...signedOut, ...builds(build('build-one'), [503, { error: { code: 'unavailable', message: 'Hornhoof is starting.', reason: 'starting' } }], [200, null], [200, { build: 42 }], [404]) });
    testClock();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    await nextLooks(5);
    expect(asked(calls, '/api/build')).toBeGreaterThanOrEqual(6);
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps a signed-in tab as it is on a new build, and reloads it once its session ends', async () => {
    const stream = fakeStream();
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {});
    let ended = false;
    mockApi({
      'GET /api/setup': [200, { needed: false }],
      'GET /api/me': () => (ended ? [401, SIGNED_OUT] : [200, MEMBER]),
      'GET /api/org': () => (ended ? [401, SIGNED_OUT] : [200, DEV_ORG]),
      ...builds(build('build-one'), build('build-two')),
    });
    testClock();
    render(<App />);
    expect(await screen.findByRole('button', { name: /^Development/ })).toBeInTheDocument();
    await nextLooks(2);
    expect(reload).not.toHaveBeenCalled();
    ended = true;
    stream.send({ type: 'org' });
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });
});
