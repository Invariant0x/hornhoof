import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { agents, jobs, people, subscriptions } from '../src/db/schema.js';
import { BUILTIN } from '../src/modules/nodes/hub.js';
import { aclCompany, type AclCompany } from './agent-view-company.js';
import { as, connectNode, invitePerson, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

type Screen = { ws: WebSocket; frames: { type: string; [k: string]: unknown }[]; closed: Promise<{ code: number; reason: string }> };
type Refused = { status: number; reason?: string };

/* A browser that opens an agent's terminal: its screen, or how the server turned it away. */
function open(url: string, token: string, agentId: string): Promise<Screen | Refused> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('/api/nodes/socket', `/api/agents/${agentId}/terminal?cols=100&rows=30`), { headers: { cookie: `hh_session=${token}` } });
    const frames: Screen['frames'] = [];
    ws.on('message', data => frames.push(JSON.parse(String(data))));
    const closed = new Promise<{ code: number; reason: string }>(done => ws.on('close', (code, reason) => done({ code, reason: String(reason) })));
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, reason: body ? JSON.parse(body).error?.reason : undefined }));
    });
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, frames, closed }));
  });
}

const opened = async (url: string, token: string, agentId: string): Promise<Screen> => {
  const screen = await open(url, token, agentId);
  if ('status' in screen) throw new Error(`Turned away: ${screen.status}`);
  return screen;
};

async function next<T extends ServerMessage['type']>(node: FakeNode, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const m = await node.next();
    if (m.type === type) return m as Extract<ServerMessage, { type: T }>;
  }
}

/* The company of #398 on the built-in node, whose API key plans let an agent move between plans on one machine. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const c = await aclCompany({ NODE_KEY, STREAM_PING_MS: '60000', ...env });
  await c.db.update(subscriptions).set({ kind: 'api_key', targetKind: 'any' });
  const node = await connectNode(c.url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
  await until(() => c.app.ctx.hub.hasTerminals(BUILTIN));
  return { ...c, node };
}
type Company = Awaited<ReturnType<typeof company>>;

const onPlan = (c: AclCompany, agentId: string, planId: string) => c.db.update(agents).set({ subscriptionId: planId }).where(eq(agents.id, agentId));
const moved = (c: AclCompany, agentId: string, planId: string) => c.app.inject({ method: 'PATCH', url: `/api/agents/${agentId}`, payload: { subscription: planId }, ...as(c.tokens.ceo) });
const turnOn = async (c: AclCompany, agentId: string, planId: string, status: 'running' | 'done' = 'running') =>
  (await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: planId, agentId, kind: 'conversation', prompt: 'A turn.', timeoutMs: 900000, status, startedAt: new Date(), ...(status === 'done' ? { finishedAt: new Date() } : {}) }).returning())[0]!;
const ended = (c: AclCompany, jobId: string) => c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId));
const state = async (c: AclCompany, token: string, agentId: string) => (await c.app.inject({ url: `/api/agents/${agentId}/events`, ...as(token) })).json().state;

/* No view opened on the node since the last one read: the next it hears of is this one of the CEO's. */
async function openedNothing(c: Company): Promise<void> {
  const witness = await opened(c.url, c.tokens.ceo, c.crew.wide.id);
  expect((await next(c.node, 'term.open')).agentKey).toBe(c.crew.wide.id);
  witness.ws.close();
}

const CASES = [
  { who: 'own plan, own department', viewer: 'ann', agent: 'mine', write: true },
  { who: "another's plan, own department", viewer: 'ann', agent: 'other', refused: true },
  { who: 'own plan, other department', viewer: 'ann', agent: 'away', refused: true },
  { who: "another's plan, other department", viewer: 'ann', agent: 'far', refused: true },
  { who: 'department owner, own plan', viewer: 'olga', agent: 'owned', write: true },
  { who: "department owner, another's plan", viewer: 'olga', agent: 'other', refused: true },
  { who: 'whole company, own plan', viewer: 'wes', agent: 'wide', write: true },
  { who: "whole company, another's plan", viewer: 'wes', agent: 'other', refused: true },
  { who: "delegate, another's plan", viewer: 'lisa', agent: 'other', write: false },
  { who: 'delegate, own plan', viewer: 'lisa', agent: 'deputy', write: true },
  { who: "CEO, another's plan", viewer: 'ceo', agent: 'other', write: false },
] as const;

describe("who gets an agent's terminal", () => {
  it.each(CASES)('$who', async ({ viewer, agent, ...expected }) => {
    const c = await company();
    const said = await open(c.url, c.tokens[viewer], c.crew[agent].id);
    if ('refused' in expected) {
      expect(said).toEqual({ status: 403, reason: 'agent_hidden' });
      await openedNothing(c);
      return;
    }
    const screen = said as Screen;
    const seen = await next(c.node, 'term.open');
    expect(seen).toMatchObject({ agentKey: c.crew[agent].id, write: expected.write });
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: expected.write });
  });

  it('turns away a cookie that is no session, or no longer one, and tells the node nothing', async () => {
    const c = await company();
    expect(await open(c.url, 'not-a-session', c.crew.mine.id)).toMatchObject({ status: 401 });
    await c.app.inject({ method: 'POST', url: '/api/auth/logout', ...as(c.tokens.ann) });
    expect(await open(c.url, c.tokens.ann, c.crew.mine.id)).toMatchObject({ status: 401 });
    await openedNothing(c);
  });
});

describe('the program a terminal really shows', () => {
  it('gives the new owner of a moved agent nothing of the running program on the old plan, and leaves it to its owner', async () => {
    const c = await company();
    const running = await turnOn(c, c.crew.other.id, c.plans.bob.id);
    await onPlan(c, c.crew.other.id, c.plans.ann.id);
    expect(await open(c.url, c.tokens.ann, c.crew.other.id)).toEqual({ status: 403, reason: 'agent_hidden' });
    await openedNothing(c);
    await opened(c.url, c.tokens.bob, c.crew.other.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ agentKey: c.crew.other.id, write: true });
    await opened(c.url, c.tokens.ceo, c.crew.other.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ write: false });
    await ended(c, running.id);
  });

  it('tells the window of the new owner there is no terminal to type in, so it writes through Hornhoof', async () => {
    const c = await company();
    await turnOn(c, c.crew.other.id, c.plans.bob.id);
    await onPlan(c, c.crew.other.id, c.plans.ann.id);
    expect(await state(c, c.tokens.ann, c.crew.other.id)).toMatchObject({ terminal: false, canType: false });
    expect(await state(c, c.tokens.ceo, c.crew.other.id)).toMatchObject({ terminal: true, canType: false });
  });

  it('keeps the program of the old plan closed to the new owner after its turn, while it stays up on the machine', async () => {
    const c = await company();
    const running = await turnOn(c, c.crew.other.id, c.plans.bob.id);
    await onPlan(c, c.crew.other.id, c.plans.ann.id);
    await ended(c, running.id);
    expect(await open(c.url, c.tokens.ann, c.crew.other.id)).toEqual({ status: 403, reason: 'agent_hidden' });
    await openedNothing(c);
    expect(await state(c, c.tokens.ann, c.crew.other.id)).toMatchObject({ terminal: false, canType: false });
  });

  it("opens it to the new owner once a turn of their plan runs in its place, and closes it to the old owner", async () => {
    const c = await company();
    const old = await turnOn(c, c.crew.other.id, c.plans.bob.id);
    await onPlan(c, c.crew.other.id, c.plans.ann.id);
    await ended(c, old.id);
    await turnOn(c, c.crew.other.id, c.plans.ann.id);
    expect(await open(c.url, c.tokens.bob, c.crew.other.id)).toEqual({ status: 403, reason: 'agent_hidden' });
    await opened(c.url, c.tokens.ann, c.crew.other.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ agentKey: c.crew.other.id, write: true });
    expect(await state(c, c.tokens.ann, c.crew.other.id)).toMatchObject({ terminal: true, canType: true });
  });

  it('goes by the last program on the machine when an agent came back: A, then B, then A', async () => {
    const c = await company();
    await turnOn(c, c.crew.mine.id, c.plans.ann.id, 'done');
    await turnOn(c, c.crew.mine.id, c.plans.bob.id, 'done');
    expect(await open(c.url, c.tokens.ann, c.crew.mine.id)).toEqual({ status: 403, reason: 'agent_hidden' });
    await turnOn(c, c.crew.mine.id, c.plans.ann.id, 'done');
    await opened(c.url, c.tokens.ann, c.crew.mine.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ write: true });
  });

  it('counts no turn that never reached the machine', async () => {
    const c = await company();
    await turnOn(c, c.crew.mine.id, c.plans.ann.id, 'done');
    await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.plans.bob.id, agentId: c.crew.mine.id, kind: 'conversation', prompt: 'Never went out.', timeoutMs: 900000, status: 'failed', finishedAt: new Date() });
    await opened(c.url, c.tokens.ann, c.crew.mine.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ write: true });
  });

  it('moves nobody when the person who asks does not see the agent', async () => {
    const c = await company();
    const [before] = await c.db.select({ nodeId: agents.nodeId }).from(agents).where(eq(agents.id, c.crew.other.id));
    expect(await open(c.url, c.tokens.ann, c.crew.other.id)).toMatchObject({ status: 403 });
    const [after] = await c.db.select({ nodeId: agents.nodeId }).from(agents).where(eq(agents.id, c.crew.other.id));
    expect(after).toEqual(before);
  });
});

describe('a terminal open when the right to it goes', () => {
  const watching = async (c: Company, token = c.tokens.ann, agentId = c.crew.mine.id) => {
    const screen = await opened(c.url, token, agentId);
    const seen = await next(c.node, 'term.open');
    await until(() => screen.frames.length > 0);
    return { screen, termId: seen.termId };
  };
  const noAccess = { code: 4403, reason: 'no_access' };

  it('closes at once when the agent moves to a plan of someone else, and tells the node', async () => {
    const c = await company();
    const { screen, termId } = await watching(c);
    expect((await moved(c, c.crew.mine.id, c.plans.bob.id)).statusCode).toBe(200);
    expect(await screen.closed).toEqual(noAccess);
    expect(await next(c.node, 'term.close')).toEqual({ type: 'term.close', termId });
  });

  it('closes at once when the person loses the department', async () => {
    const c = await company();
    const { screen } = await watching(c);
    await c.app.inject({ method: 'PATCH', url: `/api/people/${c.ids.ann}`, payload: { access: { departments: [c.sales.id] } }, ...as(c.tokens.ceo) });
    expect(await screen.closed).toEqual(noAccess);
  });

  it('closes at once when the person signs out', async () => {
    const c = await company();
    const { screen } = await watching(c);
    await c.app.inject({ method: 'POST', url: '/api/auth/logout', ...as(c.tokens.ann) });
    expect(await screen.closed).toEqual(noAccess);
  });

  it('closes at once when a person stops being the delegate', async () => {
    const c = await company();
    const { screen } = await watching(c, c.tokens.lisa, c.crew.other.id);
    await c.app.inject({ method: 'PUT', url: `/api/people/${c.ids.lisa}/ceo-delegate`, payload: { isCeoDelegate: false }, ...as(c.tokens.ceo) });
    expect(await screen.closed).toEqual(noAccess);
  });

  it('sends nothing of the screen once it knows', async () => {
    const c = await company();
    const { screen, termId } = await watching(c);
    await moved(c, c.crew.mine.id, c.plans.bob.id);
    await next(c.node, 'term.close');
    const said = screen.frames.length;
    c.node.send({ type: 'term.data', termId, data: 'WORDS OF A CLOSED SCREEN' });
    await new Promise(done => setTimeout(done, 100));
    expect(screen.frames).toHaveLength(said);
  });

  /* The right can go without anyone being told, and a next look is far off. */
  it.each([
    ['keys', { type: 'input', data: 'late words\r' }, 'term.input'],
    ['a size', { type: 'resize', cols: 80, rows: 20 }, 'term.resize'],
  ] as const)('passes on no %s after a right that went unnoticed, and closes', async (_what, frame, heard) => {
    const c = await company();
    const { screen } = await watching(c);
    await onPlan(c, c.crew.mine.id, c.plans.bob.id);
    await new Promise(done => setTimeout(done, 1100));
    screen.ws.send(JSON.stringify(frame));
    expect(await screen.closed).toEqual(noAccess);
    const seen: string[] = [];
    while (c.node.queued()) seen.push((await c.node.next()).type);
    expect(seen).not.toContain(heard);
  });

  it('opens again with the rights of now when the person still sees it but is no longer the one who types', async () => {
    const c = await company({ STREAM_PING_MS: '100' });
    const running = await turnOn(c, c.crew.deputy.id, c.plans.lisa.id);
    await onPlan(c, c.crew.deputy.id, c.plans.wes.id);
    const { screen } = await watching(c, c.tokens.lisa, c.crew.deputy.id);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: true });
    await turnOn(c, c.crew.deputy.id, c.plans.wes.id, 'done');
    await ended(c, running.id);
    expect(await screen.closed).toEqual({ code: 4410, reason: 'node_offline' });
    await opened(c.url, c.tokens.lisa, c.crew.deputy.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ write: false });
  });

  it('takes the keys of someone who may type right up to when the right goes', async () => {
    const c = await company();
    const { screen, termId } = await watching(c);
    await new Promise(done => setTimeout(done, 1100));
    screen.ws.send(JSON.stringify({ type: 'input', data: 'still mine\r' }));
    expect(await next(c.node, 'term.input')).toMatchObject({ termId, data: 'still mine\r' });
  });
});

describe('a person who only watches', () => {
  it('sends no keys, by what the server knows and not by what the browser says', async () => {
    const c = await company();
    const invited = await invitePerson(c.app, c.tokens.ceo, { name: 'Dana', email: 'dana@acme.com', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.name, 'Dana'));
    const screen = await opened(c.url, invited, c.crew.other.id);
    const seen = await next(c.node, 'term.open');
    expect(seen.write).toBe(false);
    screen.ws.send(JSON.stringify({ type: 'input', data: 'from a watcher\r', write: true, sender: c.ids.bob }));
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 81, rows: 21 }));
    expect(await next(c.node, 'term.resize')).toMatchObject({ termId: seen.termId, cols: 81 });
  });
});
