import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobs } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { as, until } from './helpers.js';
import { company, next, open, opened, turnOn, type Company, type Screen } from './terminal-company.js';

/* Checked on the server, before a byte reaches the program. A person who may write a message types words, pastes and presses
   Enter, and the turn that opens is theirs. Keys that steer the program, and lines that start with / or !, come only from the
   owner of the plan the program runs on, whatever the browser says or sends. */
type View = { screen: Screen; termId: string };

const CTRL_C = '\x03';
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const send = ({ screen }: View, data: string, more: object = {}) => screen.ws.send(JSON.stringify({ type: 'input', data, ...more }));

async function view(c: Company, token: string, agentId: string): Promise<View> {
  const screen = await opened(c.url, token, agentId);
  const { termId } = await next(c.node, 'term.open');
  await until(() => screen.frames.length > 0);
  return { screen, termId };
}

let witness = 20;
/* What reached the node, and what the browser heard, of what was sent so far: frames go in order, so a size sent last ends them. */
async function outcome(c: Company, { screen, termId }: View): Promise<{ keys: string[]; refused: unknown[] }> {
  const cols = ++witness;
  screen.ws.send(JSON.stringify({ type: 'resize', cols, rows: 20 }));
  const keys: string[] = [];
  for (;;) {
    const m = await c.node.next();
    if (m.type === 'term.input' && m.termId === termId) keys.push(m.data);
    if (m.type === 'term.resize' && m.cols === cols) break;
  }
  /* The browser hears on its own socket: what the server said before that size has reached it once a ping came back. */
  await new Promise(done => { screen.ws.once('pong', done); screen.ws.ping(); });
  const refused = screen.frames.filter(f => f.type === 'refused').map(f => f.reason);
  screen.frames.splice(0, screen.frames.length, ...screen.frames.filter(f => f.type !== 'refused'));
  return { keys, refused };
}

const STEERING = [
  ['Escape', '\x1b'],
  ['Ctrl+C', CTRL_C],
  ['Ctrl+U', '\x15'],
  ['Tab', '\t'],
  ['an arrow', '\x1b[A'],
  ['words with an arrow in them', 'hi\x1b[A'],
  ['a line with /', '/login'],
  ['a line with !', '!rm -rf /'],
  ['/ after an Enter in one frame', 'hi\r/login'],
  ['a paste of /', paste('/login')],
  ['a paste of !', paste('!rm -rf /')],
  ['a paste with / on its second line', paste('hi\n/login')],
  ['a paste with Escape in it', paste('hi\x1bthere')],
  ['a paste with Ctrl+C in it', paste(`hi${CTRL_C}`)],
  ['half a paste', '\x1b[200~hi'],
] as const;

const MESSAGES = [
  ['words', 'hello'],
  ['words and Enter', 'hello\r'],
  ['Enter', '\r'],
  ['words in another alphabet', 'привет 你好'],
  ['a paste', paste('hello\nworld')],
  ['a paste with / inside its line', paste('see /etc/hosts')],
  ['a slash inside a line', 'a/b'],
] as const;

const REPORTS = ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[3;1R', '\x1b[<0;10;5M', '\x1b[<0;10;5m'];

describe('what someone who may only write a message sends', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['ceo', 'clara'] as const)('%s is told so when the view opens, and the node takes keys from them', async who => {
    const c = await company();
    const screen = await opened(c.url, c.tokens[who], c.crew.other.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ agentKey: c.crew.other.id, write: true });
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: false, message: true });
  });

  it.each(STEERING)('never reaches the program as %s, and the browser hears why', async (_what, data) => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, data);
    expect(await outcome(c, v)).toEqual({ keys: [], refused: ['control'] });
  });

  it.each(MESSAGES)('reaches the program as %s', async (_what, data) => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, data);
    expect(await outcome(c, v)).toEqual({ keys: [data], refused: [] });
  });

  it('counts what the frame says of no right at all', async () => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, '\x1b', { write: true, message: true, control: true, sender: c.ids.bob });
    expect(await outcome(c, v)).toEqual({ keys: [], refused: ['control'] });
  });

  it.each(REPORTS)('drops the report %j with nothing said', async data => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, data);
    expect(await outcome(c, v)).toEqual({ keys: [], refused: [] });
  });

  it('knows a command typed key by key, up to the next Enter', async () => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    for (const key of '/login') send(v, key);
    expect(await outcome(c, v)).toEqual({ keys: [], refused: Array(6).fill('control') });
    send(v, '\r');
    send(v, 'hello');
    expect(await outcome(c, v)).toEqual({ keys: ['\r', 'hello'], refused: [] });
  });

  it('lets a slash through only inside a line, and knows when the line is empty again', async () => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, 'a');
    send(v, '/b');
    expect((await outcome(c, v)).keys).toEqual(['a', '/b']);
    for (const key of ['\x7f', '\x7f', '\x7f']) send(v, key);
    send(v, '/c');
    expect(await outcome(c, v)).toEqual({ keys: ['\x7f', '\x7f', '\x7f'], refused: ['control'] });
  });

  it('holds what the next frame says of the line for all the views of the agent', async () => {
    const c = await company();
    const first = await view(c, c.tokens.ceo, c.crew.other.id);
    send(first, 'a');
    expect((await outcome(c, first)).keys).toEqual(['a']);
    send(first, '\r');
    expect((await outcome(c, first)).keys).toEqual(['\r']);
    const second = await view(c, c.tokens.clara, c.crew.other.id);
    send(second, '/login');
    expect(await outcome(c, second)).toEqual({ keys: [], refused: ['control'] });
  });

  it('takes the line for empty again once Hornhoof keeps and clears its words', async () => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, 'left words');
    expect((await outcome(c, v)).keys).toEqual(['left words']);
    c.node.send({ type: 'agent.input_left', agentKey: c.crew.other.id, jobId: null, text: 'left words', typed: true, ref: 'r'.repeat(32) });
    await next(c.node, 'agent.input_kept');
    send(v, '/login');
    expect(await outcome(c, v)).toEqual({ keys: [], refused: ['control'] });
  });

  it('takes the line for empty again after a while, as a program may have taken it', async () => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, 'a');
    expect((await outcome(c, v)).keys).toEqual(['a']);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 31_000);
    send(v, '/login');
    expect(await outcome(c, v)).toEqual({ keys: [], refused: ['control'] });
  });
});

describe('what the owner of the plan sends', () => {
  it('has the program told it may be steered', async () => {
    const c = await company();
    const screen = await opened(c.url, c.tokens.bob, c.crew.other.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ write: true });
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: true, message: true });
  });

  it.each(STEERING)('reaches the program as %s', async (_what, data) => {
    const c = await company();
    const v = await view(c, c.tokens.bob, c.crew.other.id);
    send(v, data);
    expect(await outcome(c, v)).toEqual({ keys: [data], refused: [] });
  });

  it.each(REPORTS)('passes the report %j', async data => {
    const c = await company();
    const v = await view(c, c.tokens.bob, c.crew.other.id);
    send(v, data);
    expect(await outcome(c, v)).toEqual({ keys: [data], refused: [] });
  });

  it('counts in the line others write in, and clears it with a key that steers', async () => {
    const c = await company();
    const owner = await view(c, c.tokens.bob, c.crew.other.id);
    const other = await view(c, c.tokens.ceo, c.crew.other.id);
    send(owner, 'abc');
    expect((await outcome(c, owner)).keys).toEqual(['abc']);
    send(other, '/x');
    expect(await outcome(c, other)).toEqual({ keys: ['/x'], refused: [] });
    send(owner, '\x15');
    expect((await outcome(c, owner)).keys).toEqual(['\x15']);
    send(other, '/login');
    expect(await outcome(c, other)).toEqual({ keys: [], refused: ['control'] });
  });

  it('does not give the CEO the plan of someone else, nor the owner another plan', async () => {
    const c = await company();
    const onBobs = await view(c, c.tokens.ceo, c.crew.other.id);
    send(onBobs, CTRL_C);
    expect((await outcome(c, onBobs)).refused).toEqual(['control']);
    expect(await open(c.url, c.tokens.bob, c.crew.mine.id)).toEqual({ status: 403, reason: 'agent_hidden' });
  });
});

describe('whose turn a key opens', () => {
  it("is the turn of who pressed Enter, on another person's plan", async () => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, 'please look\r');
    expect((await outcome(c, v)).keys).toEqual(['please look\r']);
    c.node.send({ type: 'turn.open', agentKey: c.crew.other.id, text: 'please look', ref: 'typed-1' });
    const opened = await next(c.node, 'turn.opened');
    expect(opened).toMatchObject({ ref: 'typed-1', jobId: expect.any(String), toolToken: expect.any(String) });
    const [turn] = await c.db.select().from(jobs).where(eq(jobs.id, opened.jobId!));
    expect(turn).toMatchObject({ createdBy: c.ids.ceo, subscriptionId: c.plans.bob.id });
  });

  it('counts an Enter in a running turn for who pressed it, at its end too', async () => {
    const c = await company();
    const running = await turnOn(c, c.crew.other.id, c.plans.bob.id);
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, 'and the limits\r');
    expect(await next(c.node, 'term.input')).toMatchObject({ data: 'and the limits\r', pressedIn: running.id });
    c.node.send({ type: 'job.done', jobId: running.id, ok: true, sessionId: 's', result: 'Done.', tail: '', error: null, wordsWaiting: true });
    await until(async () => (await c.db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, running.id)))[0]?.status !== 'running');
    c.node.send({ type: 'turn.open', agentKey: c.crew.other.id, text: 'and the limits', ref: 'typed-2', queuedFrom: running.id });
    const opened = await next(c.node, 'turn.opened');
    const [turn] = await c.db.select().from(jobs).where(eq(jobs.id, opened.jobId!));
    expect(turn).toMatchObject({ createdBy: c.ids.ceo });
  });

  it('does not count an Enter that never went through', async () => {
    const c = await company();
    const v = await view(c, c.tokens.ceo, c.crew.other.id);
    send(v, '/login\r');
    expect((await outcome(c, v)).keys).toEqual([]);
    expect(c.app.ctx.terminals.takeTyped(c.nodeIdentity, c.crew.other.id)).toBeNull();
    expect(c.app.ctx.terminals.lastWriter(c.nodeIdentity, c.crew.other.id)).toBeNull();
  });

  it('keeps a line starting with / from going in through a message instead', async () => {
    const c = await company();
    expect((await c.app.inject({ method: 'POST', url: `/api/agents/${c.crew.other.id}/messages`, payload: { text: '/login' }, ...as(c.tokens.ceo) })).statusCode).toBe(202);
    const run = await next(c.node, 'job.run');
    expect(run.prompt).toContain('/login');
    expect(run.prompt.trimStart()[0]).not.toBe('/');
  });
});
