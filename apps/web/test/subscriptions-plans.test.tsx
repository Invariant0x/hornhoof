import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { SubView } from '../src/types';
import { armor, Decrypter, generateX25519Identity, identityToRecipient } from 'age-encryption';
import { ME, MACHINE, mockApi, SUBS, withKey } from './api-mock';
import { decl } from './css';
import { fakeStream } from './fake-stream';
import { commandCode } from './command-code';
import { COMMAND, lists, rowOf, openAll } from './subscriptions-helpers';

vi.mock('../src/ui/AgentTerminal', () => ({
  AgentTerminal: ({ path }: { path: string }) => <div data-testid="live-terminal" data-path={path} />,
}));

afterEach(() => localStorage.clear());

describe('subscription search and filters', () => {
  it('searches agents and machines without closing matching cards, then clears the query', async () => {
    lists();
    render(<Subscriptions me={ME} />);
    expect(await screen.findByText('4 subscriptions')).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search' });
    await userEvent.click(screen.getByRole('button', { name: 'Open the card of Claude' }));
    await userEvent.type(search, 'bRuNo');
    expect(screen.getByText('Showing 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Claude, Ivan' })).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'dev-laptop');
    expect(screen.getByText('Showing 2 of 4')).toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, 'missing');
    expect(screen.getByText('Nothing matches. Change the search or clear the filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('4 subscriptions')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Claude, Ivan' })).toBeInTheDocument();
  });

  it('widens providers in one group and combines provider, owner and status filters', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [SUBS[0]!, SUBS[1]!, { ...SUBS[2]!, owner: { id: 'p2', name: 'Maria' } }, SUBS[3]!] }] });
    render(<Subscriptions me={ME} />);
    await screen.findByRole('table');
    const provider = screen.getByRole('group', { name: 'Provider' });
    await userEvent.click(within(provider).getByRole('button', { name: /Claude.*2/ }));
    expect(screen.getByText('Showing 2 of 4')).toBeInTheDocument();
    await userEvent.click(within(provider).getByRole('button', { name: /Codex.*1/ }));
    expect(screen.getByText('Showing 3 of 4')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('group', { name: 'Owner' })).getByRole('button', { name: /^Ivan/ }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: /^Waiting for the login/ }));
    expect(screen.getByText('Showing 1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'Codex' })).toBeInTheDocument();
  });

  it('searches key endings, tiers, account addresses and where the plan serves', async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, tier: 'max', accounts: [{ nodeId: 'n1', hostname: 'dev-laptop', tier: 'max', email: 'private@acme.com' }], place: { kind: 'department', id: 'd1', name: 'Marketing' } }, SUBS[3]!] }] });
    render(<Subscriptions me={ME} />);
    await screen.findByRole('table');
    const search = screen.getByRole('searchbox');
    for (const query of ['9f3a', 'max', 'private@acme.com', 'Marketing']) {
      await userEvent.clear(search);
      await userEvent.type(search, query);
      expect(screen.getByText('Showing 1 of 2')).toBeInTheDocument();
    }
    expect(screen.queryByRole('group', { name: 'Provider' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Owner' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Status' })).not.toBeInTheDocument();
  });
});

describe('signing in to plans', () => {
  const NODE = '7d1c6a52-2f4e-4c4b-9f55-0d7a3c1e9b10';
  const LAPTOP = { id: 'm3', hostname: 'dev-notebook', status: 'ready' as const, online: true };
  const claude = SUBS[0]!;
  const codex = SUBS[1]!;
  const only = (...subs: typeof SUBS) => ({ 'GET /api/subscriptions': [200, { subscriptions: subs }] as [number, unknown] });

  it("says a plan signed in once runs on any of its owner's machines, and how many are online", async () => {
    mockApi(only({ ...claude, signedInOnce: true, machines: [MACHINE, LAPTOP, { ...LAPTOP, id: 'm4', hostname: 'work-tower', online: false }] }));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Claude')).getByText("Signed in once, runs on any of Ivan's machines (2 online)")).toBeInTheDocument();
  });

  it('says a plan signed in on its machine by hand runs only there', async () => {
    mockApi(only(claude));
    render(<Subscriptions me={ME} />);
    await openAll();
    const row = rowOf('Claude');
    expect(within(row).getByText('Signed in on dev-laptop only')).toBeInTheDocument();
    expect(within(row).queryByText(/^Signed in once/)).not.toBeInTheDocument();
  });

  it('says a Codex plan signed in once runs on one machine at a time, and on which', async () => {
    mockApi(only({ ...codex, status: 'ready', signedInOnce: true, leaseMachine: 'dev-notebook', machines: [MACHINE, LAPTOP] }));
    render(<Subscriptions me={ME} />);
    await openAll();
    const row = rowOf('Codex');
    expect(within(row).getByText('Codex runs on one machine at a time; now on dev-notebook')).toBeInTheDocument();
    expect(within(row).queryByText(/^Signed in once/)).not.toBeInTheDocument();
  });

  it('names the tier each plan runs on, and what a free Codex plan cannot do', async () => {
    const free = { ...codex, status: 'ready' as const, tier: 'free', accounts: [{ nodeId: NODE, hostname: 'dev-laptop', tier: 'free' }] };
    mockApi(only({ ...claude, signedInOnce: true }, free));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Claude')).getByText('Claude, one-year sign-in')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Codex, Free: newer models need Plus or Pro')).toBeInTheDocument();
  });

  it('names a paid tier, and says when machines of one plan are signed in to different accounts', async () => {
    const pro = { ...codex, status: 'ready' as const, tier: 'pro', accounts: [{ nodeId: NODE, hostname: 'dev-laptop', tier: 'pro', email: 'ivan@acme.com' }] };
    const accounts = [
      { nodeId: NODE, hostname: 'dev-laptop', tier: 'max', email: 'ivan@acme.com' },
      { nodeId: 'n2', hostname: 'dev-notebook', tier: 'pro', email: 'ivan@acme.example' },
    ];
    mockApi(only({ ...claude, machines: [MACHINE, LAPTOP], accounts, accountsDiffer: true }, pro));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(within(rowOf('Codex')).getByText('Codex, Pro')).toBeInTheDocument();
    expect(within(rowOf('Claude')).getByText('dev-laptop and dev-notebook are signed in to different accounts')).toBeInTheDocument();
  });

  it("signs a plan in again with another account in a terminal on the owner's machine, and closes it once signed in", async () => {
    const stream = fakeStream();
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only({ ...claude, signedInOnce: true }), 'POST /api/subscriptions/s-claude/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude with another account' }));
    expect(calls.find(c => c.method === 'POST')).toEqual({ method: 'POST', path: '/api/subscriptions/s-claude/signin', body: { fresh: true } });
    expect(await screen.findByRole('heading', { name: 'Signing in on dev-laptop' })).toBeInTheDocument();
    expect(screen.getByTestId('live-terminal')).toHaveAttribute('data-path', `/api/subscriptions/s-claude/signin/terminal?nodeId=${NODE}`);
    /* Another plan's or machine's sign-in leaves this one open. */
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: true, error: null, owner: 'p1' });
    expect(screen.getByRole('heading', { name: 'Signing in on dev-laptop' })).toBeInTheDocument();
    stream.send({ type: 'subscription.signin', subscriptionId: 's-claude', nodeId: NODE, ok: true, error: null, owner: 'p1' });
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Signing in on dev-laptop' })).not.toBeInTheDocument());
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('signs in a plan that waits for its login, and says in plain words when the sign-in fails', async () => {
    const stream = fakeStream();
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ fresh: false });
    await screen.findByRole('heading', { name: 'Signing in on dev-laptop' });
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: false, error: 'tmux: lost server', owner: 'p1' });
    /* Under the plan's row, as a test's result is. */
    expect(await screen.findByText('The sign-in did not finish, so nothing changed. Try again.')).toBeInTheDocument();
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  it('says under the plan why a sign-in ended early: its code and what its program said last', async () => {
    const stream = fakeStream();
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    await screen.findByRole('heading', { name: 'Signing in on dev-laptop' });
    const line = 'Error: claude native binary not installed. Either postinstall did not run ... or the platform-native optional dependency was not downloaded (--omit=optional)';
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: false, error: 'The sign-in ended before it finished, so nothing changed.', code: 1, line, owner: 'p1' });
    expect(await screen.findByText(`The sign-in ended with code 1, so nothing changed. The program said: ${line}`)).toBeInTheDocument();
    expect(screen.queryByText('The sign-in ended before it finished, so nothing changed.')).not.toBeInTheDocument();
  });

  it('brings the sign-in window into view when it opens, below a long card', async () => {
    const shown: Element[] = [];
    const before = Element.prototype.scrollIntoView;
    /* As Chromium's does, it gives back a promise. */
    Element.prototype.scrollIntoView = function (this: Element) { shown.push(this); return Promise.resolve() as unknown as void; };
    onTestFinished(() => void (Element.prototype.scrollIntoView = before));
    fakeStream();
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only({ ...codex, status: 'ready', machines: [MACHINE] }), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }], 'POST /api/subscriptions/s-codex/signin/stop': [204] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    const heading = await screen.findByRole('heading', { name: 'Signing in on dev-laptop' });
    await vi.waitFor(() => expect(shown.some(node => node.contains(heading))).toBe(true));
    /* Closing it must not trip over what scrolling gave back. */
    await userEvent.click(screen.getByRole('button', { name: 'Stop the sign-in' }));
    await vi.waitFor(() => expect(screen.queryByRole('heading', { name: 'Signing in on dev-laptop' })).not.toBeInTheDocument());
  });

  it('says what to do when the machine could not install the program to sign in with', async () => {
    const stream = fakeStream();
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    await screen.findByRole('heading', { name: 'Signing in on dev-laptop' });
    stream.send({ type: 'subscription.signin', subscriptionId: 's-codex', nodeId: NODE, ok: false, error: 'The program could not be installed on this machine, so nothing changed.', owner: 'p1' });
    expect(await screen.findByText("The program could not be installed on this machine, so nothing changed. Check the machine's internet connection and free disk space, then try again.")).toBeInTheDocument();
  });

  it('stops a sign-in half way', async () => {
    fakeStream();
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(codex), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }], 'POST /api/subscriptions/s-codex/signin/stop': [204] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Stop the sign-in' }));
    expect(calls.find(c => c.path.endsWith('/signin/stop'))).toEqual({ method: 'POST', path: '/api/subscriptions/s-codex/signin/stop', body: { nodeId: NODE } });
    expect(screen.queryByTestId('live-terminal')).not.toBeInTheDocument();
  });

  /* A server that names no machine or gives no command, or gives them in another shape, gets the plain words, and no
     command box. */
  it.each([
    ['no details', undefined],
    ['no machines', { command: 'curl -fsSL https://hq.acme.com/install.sh | bash' }],
    ['no command', { machines: ['dev-laptop'] }],
    ['machines that are not a list', { machines: 'dev-laptop', command: 'curl -fsSL https://hq.acme.com/install.sh | bash' }],
    ['a command that is not text', { machines: ['dev-laptop'], command: { text: 'curl -fsSL https://hq.acme.com/install.sh | bash' } }],
  ])('says under the plan, in plain words, why a sign-in cannot start, instead of at the top of the page, with %s', async (_, details) => {
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    const unsupported = { error: { code: 'conflict', message: 'The machine of this plan is online, but its node cannot run the sign-in.', reason: 'signin_unsupported', ...(details ? { details } : {}) } };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], ...only(ready, SUBS[0]!), 'POST /api/subscriptions/s-codex/signin': [409, unsupported] });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in to Codex' }));
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    const words = 'The machine is online, but its node cannot sign in from Hornhoof yet. Update the nodes on that machine, then try again.';
    expect(await within(card).findByText(words)).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Sign in to Codex' })).toBeInTheDocument();
    /* Under the plan whose button was pressed alone. */
    expect(within(screen.getByRole('article', { name: 'Claude, Ivan' })).queryByText(words)).not.toBeInTheDocument();
  });

  it.each([
    ['en', 'Sign in to Codex', 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs. To update them, run this command in a terminal on dev-laptop, then sign in again.', 'Copy', 'It moves the Hornhoof nodes on that machine to the new build and keeps their sign-ins and files.'],
    ['ru', 'Войти в Codex', 'Ноды на dev-laptop старше, чем нужно для входа из Hornhoof. Чтобы обновить их, выполните эту команду в терминале на dev-laptop, затем войдите снова.', 'Копировать', 'Она переводит ноды Hornhoof на этой машине на новую сборку, а их вход и файлы сохраняет.'],
  ])('names the machine whose nodes are too old for the sign-in, with the command that updates them to copy, in %s', async (language, signIn, text, copy, trust) => {
    localStorage.setItem('hh-lang', language);
    const update = 'curl -fsSL https://hq.acme.com/install.sh | bash';
    const old = { error: { code: 'conflict', message: 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs.', reason: 'signin_unsupported', details: { machines: ['dev-laptop'], command: update } } };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], ...only({ ...codex, status: 'ready' as const, machines: [MACHINE] }), 'POST /api/subscriptions/s-codex/signin': [409, old] });
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn((t: string) => { copied.push(t); return Promise.resolve(); }) } });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: signIn }));
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(await within(card).findByText(text)).toBeInTheDocument();
    expect(within(card).getByText(commandCode(update))).toBeInTheDocument();
    expect(within(card).getByText(trust)).toBeInTheDocument();
    await userEvent.click(within(card).getAllByRole('button', { name: copy })[0]!);
    expect(copied).toEqual([update]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    /* The next try starts clean: the note and its command go once the sign-in starts. */
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], ...only({ ...codex, status: 'ready' as const, machines: [MACHINE] }), 'POST /api/subscriptions/s-codex/signin': [200, { nodeId: NODE, hostname: 'dev-laptop' }] });
    await userEvent.click(within(card).getByRole('button', { name: signIn }));
    await vi.waitFor(() => expect(within(card).queryByText(commandCode(update))).not.toBeInTheDocument());
  });

  it('says in Russian that no machine of the plan is online to sign in on', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    const offline = { error: { code: 'conflict', message: 'No machine of this plan is online.', reason: 'no_node_online' } };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],  ...only(ready), 'POST /api/subscriptions/s-codex/signin': [409, offline] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Войти в Codex' }));
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(await within(card).findByText('Ни одна машина этой подписки не в сети. Включите одну из них и попробуйте еще раз.')).toBeInTheDocument();
  });

  it('offers no sign-in for a plan of another person, or one with no machine online', async () => {
    mockApi(only({ ...codex, owner: { id: 'p4', name: 'Oleg' } }, { ...claude, online: false, machines: [{ ...MACHINE, online: false }] }));
    render(<Subscriptions me={ME} />);
    await openAll();
    rowOf('Codex');
    expect(screen.queryByRole('button', { name: /^Sign in to / })).not.toBeInTheDocument();
  });

  it('seals a pasted Kimi key in the browser for each machine of the plan, so Hornhoof never sees it', async () => {
    const identity = await generateX25519Identity();
    const KEY = 'sk-kimi-7Hq2xP9wLm4Zr8Tv';
    const kimi = { ...SUBS[2]!, status: 'needs_login' as const, online: true, machines: [{ ...MACHINE, status: 'needs_login' as const }] };
    const calls = mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }],
      ...only(kimi),
      'GET /api/subscriptions/s-kimi/recipients': [200, { version: 2, recipients: [{ nodeId: NODE, publicKey: await identityToRecipient(identity), hostname: 'dev-laptop' }] }],
      'POST /api/subscriptions/s-kimi/credential': [200, { stored: 1 }],
    });
    render(<Subscriptions me={ME} />);
    await openAll();
    await userEvent.click(await screen.findByRole('button', { name: 'Paste the key for Kimi' }));
    expect(screen.getByRole('link', { name: /Kimi/ })).toHaveAttribute('href', 'https://www.kimi.com/code/console');
    await userEvent.type(screen.getByLabelText('Kimi key'), KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Connect key' }));
    await vi.waitFor(() => expect(calls.find(c => c.path === '/api/subscriptions/s-kimi/credential')).toBeTruthy());
    const sent = calls.find(c => c.path === '/api/subscriptions/s-kimi/credential')!.body as { kind: string; version: number; envelopes: { nodeId: string; sealed: string }[] };
    expect(sent.kind).toBe('kimi_key');
    expect(sent.version).toBe(3);
    expect(sent.envelopes.map(e => e.nodeId)).toEqual([NODE]);
    const d = new Decrypter();
    d.addIdentity(identity);
    expect(await d.decrypt(armor.decode(sent.envelopes[0]!.sealed), 'text')).toBe(KEY);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    await vi.waitFor(() => expect(screen.queryByLabelText('Kimi key')).not.toBeInTheDocument());
  });

  it('says the sign-in lines in Russian', async () => {
    localStorage.setItem('hh-lang', 'ru');
    const free = { ...codex, status: 'ready' as const, tier: 'free', signedInOnce: true, leaseMachine: 'dev-laptop', accounts: [{ nodeId: NODE, hostname: 'dev-laptop', tier: 'free' }] };
    mockApi(only({ ...claude, signedInOnce: true, machines: [MACHINE, LAPTOP] }, free));
    render(
      <LanguageProvider>
        <Subscriptions me={ME} />
      </LanguageProvider>,
    );
    await openAll();
    const row = rowOf('Claude');
    expect(within(row).getByText('Вход выполнен один раз, работает на любой машине Ivan (на связи: 2)')).toBeInTheDocument();
    expect(within(row).getByText('Claude, вход на год')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Войти в Claude с другим аккаунтом' })).toHaveTextContent('Войти в другой аккаунт');
    expect(within(rowOf('Codex')).getByText('Codex работает на одной машине за раз; сейчас на dev-laptop')).toBeInTheDocument();
    expect(within(rowOf('Codex')).getByText('Codex, Free: новым моделям нужен Plus или Pro')).toBeInTheDocument();
  });
});

/* A plan that does not work yet, as it waits for its machine or its sign-in, or whose sign-in found nodes too old for it,
   has nothing else to show: its card is one block across, saying what is wrong and where, with what to do and Remove. */
describe('the card of a plan that does not work', () => {
  const [claude, codex, kimi, key] = SUBS as [SubView, SubView, SubView, SubView];
  const UPDATE = 'curl -fsSL https://hq.acme.com/install.sh | bash';
  const OLD = { error: { code: 'conflict', message: 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs.', reason: 'signin_unsupported', details: { machines: ['dev-laptop'], command: UPDATE } } };
  const OLD_TEXT = 'The nodes on dev-laptop are older than the sign-in from Hornhoof needs. To update them, run this command in a terminal on dev-laptop, then sign in again.';
  const only = (...subs: SubView[]) => ({ 'GET /api/nodes/commands': [200, { commands: [] }] as [number, unknown], 'GET /api/subscriptions': [200, { subscriptions: subs }] as [number, unknown] });
  const THREE = ['blk blk-facts', 'blk blk-run', 'blk blk-side'];
  const blocks = (card: HTMLElement) => [...card.querySelectorAll('.blocks > .blk')].map(b => b.className);
  const buttons = (part: HTMLElement) => within(part).getAllByRole('button').map(b => b.textContent);
  /* The install command of a plan waiting for its machine, live for 21 more hours, its block at the top closed with Done. */
  const installFor = (sub: SubView) => ({ id: 'c'.repeat(64), kind: 'plans', subscriptionIds: [sub.id], dismissedSubscriptionIds: [sub.id], plans: [sub.label], machine: null, command: COMMAND, expiresAt: new Date(Date.now() + 21 * 3600_000 + 60_000).toISOString() });
  /* What a working plan's card has, and the card of one that does not work leaves out. */
  const workingParts = (card: HTMLElement) => [
    ...['Limits', 'Owner and account', 'Settings', 'Machines of this plan'].filter(name => within(card).queryByRole('heading', { name })),
    ...(within(card).queryByRole('region', { name: 'Agents on it' }) ? ['Agents on it'] : []),
    ...within(card).queryAllByRole('button', { name: /^(Run a test on |Use .+ for the orchestrator$)/ }).map(b => b.textContent),
  ];

  it('shows a plan waiting for its sign-in as one block across the card: why and where, Sign in and Remove', async () => {
    mockApi(only(codex));
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(workingParts(card)).toEqual([]);
    const block = card.querySelector<HTMLElement>('.blk-fix')!;
    expect(block.firstElementChild).toHaveTextContent('On dev-laptop. Only Ivan can sign in.');
    expect(buttons(block)).toEqual(['Sign in', 'Remove']);
    /* Said once, in the block, and not in the card's head as well. */
    expect(within(card).getAllByText('On dev-laptop. Only Ivan can sign in.')).toHaveLength(1);
    expect(decl('.blk-fix', 'grid-column')).toBe('1 / -1');
    expect(decl('.blk-fix', 'grid-row')).toBe('1 / -1');
  });

  it.each([
    ['en', 'It needs a sign-in on dev-laptop, and the machine is offline.', 'Remove'],
    ['ru', 'Нужен вход на dev-laptop, а машина не в сети.', 'Удалить'],
  ])('says in %s that a plan waiting for its sign-in has its machine offline, with Remove alone', async (language, words, remove) => {
    localStorage.setItem('hh-lang', language);
    mockApi(only({ ...codex, online: false, machines: [{ ...codex.machines[0]!, online: false }] }));
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(card.querySelector('.blk-fix')!.firstElementChild).toHaveTextContent(words);
    expect(buttons(card)).toEqual([remove]);
  });

  it('shows a plan waiting for its machine as one block: who has not run the command, Make a new command and Remove', async () => {
    mockApi(only(kimi));
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Kimi, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(workingParts(card)).toEqual([]);
    expect(card.querySelector('.blk-fix')!.firstElementChild).toHaveTextContent('Ivan has not run the install command yet.');
    expect(buttons(card)).toEqual(['Make a new command', 'Remove']);
    /* The button stands where the command will, as wide as its words, not across the card. */
    expect(decl('.blk-fix > .act', 'justify-self')).toBe('start');
  });

  it.each([
    ['en', 'Ivan has not run the install command yet.', 'Valid for 21 more hours.', ['Copy', 'Remove']],
    ['ru', 'Владелец (Ivan) еще не выполнил команду установки.', 'Действует еще 21 ч.', ['Копировать', 'Удалить']],
  ])('puts the install command of a plan waiting for its machine in its block, in %s', async (language, words, lifetime, actions) => {
    localStorage.setItem('hh-lang', language);
    mockApi({ ...only(kimi), 'GET /api/nodes/commands': [200, { commands: [installFor(kimi)] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await openAll();
    const card = screen.getByRole('article', { name: 'Kimi, Ivan' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(workingParts(card)).toEqual([]);
    /* Why, the steps to its work, the command and the one for Windows, each with Copy, and how long they work, then Remove:
       one block, nothing beside it. */
    const [why, steps, install, last, ...rest] = [...card.querySelector<HTMLElement>('.blk-fix')!.children] as HTMLElement[];
    expect(why!.textContent).toBe(words);
    expect(steps).toHaveRole('list');
    await vi.waitFor(() => expect(install).toHaveTextContent(withKey(COMMAND)));
    expect(install).toHaveTextContent(lifetime);
    expect(buttons(install!)).toEqual([actions[0], actions[0]]);
    expect(buttons(last!)).toEqual([actions[1]]);
    expect(rest).toEqual([]);
  });

  it("shows the plan of another person waiting for their machine without its install command: who, and Remove", async () => {
    const maria = { ...kimi, owner: { id: 'p2', name: 'Maria' } };
    mockApi({ ...only(maria), 'GET /api/nodes/commands': [200, { commands: [installFor(maria)] }] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Kimi, Maria' });
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(card.querySelector('.blk-fix')!.firstElementChild).toHaveTextContent('Maria has not run the install command yet.');
    expect(within(card).queryByText(commandCode(withKey(COMMAND)))).not.toBeInTheDocument();
    expect(buttons(card)).toEqual(['Remove']);
  });

  it("turns a working plan's card into the block when its sign-in finds old nodes, and back into the card after a reload", async () => {
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    mockApi({ ...only(ready), 'POST /api/subscriptions/s-codex/signin': [409, OLD] });
    const { unmount } = render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(card)).toEqual(THREE);
    expect(workingParts(card)).toEqual(['Limits', 'Owner and account', 'Settings', 'Machines of this plan', 'Agents on it', 'Run a test', 'Use for the orchestrator']);
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    await vi.waitFor(() => expect(blocks(card)).toEqual(['blk blk-fix']));
    expect(workingParts(card)).toEqual([]);
    /* The machine and why, the command and the one for Windows with Copy, and Sign in and Remove under them. */
    const block = card.querySelector<HTMLElement>('.blk-fix')!;
    expect(block.firstElementChild).toHaveTextContent(OLD_TEXT);
    expect(within(block).getByText(commandCode(UPDATE))).toBeInTheDocument();
    expect(buttons(block)).toEqual(['Copy', 'Copy', 'Sign in', 'Remove']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    /* The screen alone keeps it: opened again, the card is the working plan's. */
    unmount();
    render(<Subscriptions me={ME} />);
    await openAll();
    const again = screen.getByRole('article', { name: 'Codex, Ivan' });
    expect(blocks(again)).toEqual(THREE);
    expect(within(again).queryByText(commandCode(UPDATE))).not.toBeInTheDocument();
  });

  it('keeps the block while Sign in is asked again, and changes it only for the answer', async () => {
    const ready = { ...codex, status: 'ready' as const, machines: [MACHINE] };
    let answer: (reply: [number, unknown]) => void = () => {};
    let asked = 0;
    mockApi({ ...only(ready), 'POST /api/subscriptions/s-codex/signin': () => (++asked === 1 ? [409, OLD] : new Promise(done => { answer = done; })) });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    await vi.waitFor(() => expect(blocks(card)).toEqual(['blk blk-fix']));
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    await vi.waitFor(() => expect(asked).toBe(2));
    /* While the server has not answered, the card stays as it was. */
    expect(blocks(card)).toEqual(['blk blk-fix']);
    expect(within(card).getByText(commandCode(UPDATE))).toBeInTheDocument();
    act(() => answer([409, OLD]));
    await vi.waitFor(() => expect(within(card).getByText(commandCode(UPDATE))).toBeInTheDocument());
    expect(blocks(card)).toEqual(['blk blk-fix']);
  });

  it('puts the old nodes and their command in place of the why, in the block of a plan waiting for its sign-in', async () => {
    mockApi({ ...only(codex), 'POST /api/subscriptions/s-codex/signin': [409, OLD] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const card = screen.getByRole('article', { name: 'Codex, Ivan' });
    await userEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex' }));
    const block = card.querySelector<HTMLElement>('.blk-fix')!;
    await vi.waitFor(() => expect(block.firstElementChild).toHaveTextContent(OLD_TEXT));
    expect(within(card).queryByText('On dev-laptop. Only Ivan can sign in.')).not.toBeInTheDocument();
    expect(buttons(block)).toEqual(['Copy', 'Copy', 'Sign in', 'Remove']);
    expect(blocks(card)).toEqual(['blk blk-fix']);
  });

  it.each([
    ['ready', claude],
    ['at its limit', { ...claude, limits: { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2099-10-29T18:00:00.000Z' }] } }],
    ['with its machine offline', { ...claude, online: false, machines: [{ ...MACHINE, online: false }] }],
    ['of a key whose built-in node is offline', { ...key, online: false }],
  ])('keeps the three blocks of the card for a plan %s', async (_, sub) => {
    mockApi(only(sub));
    render(<Subscriptions me={ME} />);
    await openAll();
    const [card] = screen.getAllByRole('article');
    expect(blocks(card!)).toEqual(THREE);
  });

  it('says nothing under the state of a working plan that is not at its limit', async () => {
    mockApi(only(claude));
    render(<Subscriptions me={ME} />);
    await openAll();
    expect(screen.getByRole('article', { name: 'Claude, Ivan' }).querySelector('.stline')).toHaveTextContent(/^Ready$/);
  });

  it("asks before removing a working plan's key from its card, then sends DELETE", async () => {
    const calls = mockApi({ ...only(key), 'DELETE /api/subscriptions/s-key': [204] });
    render(<Subscriptions me={ME} />);
    await openAll();
    const side = screen.getByRole('article', { name: 'Anthropic key ending 9f3a, Ivan' }).querySelector<HTMLElement>('.blk-side')!;
    await userEvent.click(within(side).getByRole('button', { name: 'Remove Anthropic key ending 9f3a' }));
    expect(within(side).getByText('Remove Anthropic key ending 9f3a? The key is deleted from Hornhoof.')).toBeInTheDocument();
    await userEvent.click(within(side).getByRole('button', { name: 'Yes, remove' }));
    expect(calls.find(c => c.method === 'DELETE')).toEqual({ method: 'DELETE', path: '/api/subscriptions/s-key', body: undefined });
  });
});

describe('the forms that connect plans and keys', () => {
  const groupOf = (button: HTMLElement) => {
    const foot = button.parentElement!;
    expect(foot).toHaveClass('form-foot');
    return within(foot).getAllByRole('button');
  };

  it('offers each plan as a card with its mark, and says Preparing… on Show command, which comes before Cancel', async () => {
    let finish!: (reply: [number, unknown]) => void;
    lists({ 'POST /api/subscriptions/connect': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'Connect a subscription' }));
    expect(screen.getByRole('heading', { name: 'Connect subscriptions' })).toBeInTheDocument();
    const claude = screen.getByRole('checkbox', { name: 'Claude' });
    expect(claude.closest('label')!.querySelector('svg.pm')).not.toBeNull();
    await user.click(claude);
    const show = screen.getByRole('button', { name: 'Show command' });
    expect(groupOf(show)).toEqual([show, screen.getByRole('button', { name: 'Cancel' })]);
    await user.click(show);
    expect(show).toHaveAccessibleName('Preparing…');
    expect(show).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish([201, { subscriptions: [SUBS[0]], command: 'curl x' }]); });
  });

  it('asks for a key in the form grid, says Connecting… on Connect key, which comes before Cancel', async () => {
    let finish!: (reply: [number, unknown]) => void;
    const kimi = { ...SUBS[2]!, status: 'needs_login' as const, online: true, machines: [{ ...MACHINE, status: 'needs_login' as const }] };
    mockApi({ 'GET /api/nodes/commands': [200, { commands: [] }], 'GET /api/subscriptions': [200, { subscriptions: [kimi] }], 'GET /api/subscriptions/s-kimi/recipients': () => new Promise(resolve => { finish = resolve; }) });
    const user = userEvent.setup();
    render(<Subscriptions me={ME} />);
    await openAll();
    await user.click(await screen.findByRole('button', { name: 'Paste the key for Kimi' }));
    const field = screen.getByLabelText('Kimi key');
    expect(field.closest('form')).toHaveClass('form-grid');
    expect(field).toHaveAccessibleDescription(/Stored encrypted and never shown again after saving\./);
    await user.type(field, 'sk-kimi-1');
    const connect = screen.getByRole('button', { name: 'Connect key' });
    expect(groupOf(connect)).toEqual([connect, screen.getByRole('button', { name: 'Cancel' })]);
    await user.click(connect);
    expect(connect).toHaveAccessibleName('Connecting…');
    expect(connect).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish([200, { version: 1, recipients: [] }]); });
    expect(await screen.findByRole('alert')).toHaveTextContent('No machine of this plan can take the key yet.');
    expect(connect).toHaveAccessibleName('Connect key');
  });
});
