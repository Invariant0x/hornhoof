import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents, jobs, people } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { as, invitePerson, until } from './helpers.js';
import { company, ended, handled, moved, next, onPlan, open, opened, state, turnOn, type Company, type Screen } from './terminal-company.js';

/* No view opened on the node since the last one read: the next it hears of is this one of the CEO's. */
async function openedNothing(c: Company): Promise<void> {
  const witness = await opened(c.url, c.tokens.ceo, c.crew.wide.id);
  expect((await next(c.node, 'term.open')).agentKey).toBe(c.crew.wide.id);
  witness.ws.close();
}

/* What a window hears of its rights: the node takes keys from any window, as the server already chose them. */
async function rights(c: Company, token: string, agentId: string) {
  const screen = await opened(c.url, token, agentId);
  await next(c.node, 'term.open');
  await until(() => screen.frames.length > 0);
  return screen.frames[0];
}

const CASES = [
  { who: 'own plan, own department', viewer: 'ann', agent: 'mine', write: true },
  { who: "another's plan, own department", viewer: 'ann', agent: 'other', refused: true },
  { who: 'own plan, other department', viewer: 'ann', agent: 'away', refused: true },
  { who: "another's plan, other department", viewer: 'ann', agent: 'far', refused: true },
  { who: 'department owner, own plan', viewer: 'olga', agent: 'owned', write: true },
  /* The owner of a department watches every agent of it, and types only on a plan of their own. */
  { who: "department owner, another's plan", viewer: 'olga', agent: 'other', write: false },
  { who: "department owner, another's plan, other department", viewer: 'olga', agent: 'far', refused: true },
  { who: 'whole company, own plan', viewer: 'wes', agent: 'wide', write: true },
  { who: "whole company, another's plan", viewer: 'wes', agent: 'other', refused: true },
  { who: "delegate, another's plan", viewer: 'clara', agent: 'other', write: false },
  { who: 'delegate, own plan', viewer: 'clara', agent: 'deputy', write: true },
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
    expect(seen).toMatchObject({ agentKey: c.crew[agent].id, write: true });
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: expected.write, message: true });
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
    expect(await rights(c, c.tokens.ceo, c.crew.other.id)).toEqual({ type: 'ready', write: false, message: true });
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
    await opened(c.url, c.tokens.bob, c.crew.other.id);
    expect(await next(c.node, 'term.open')).toMatchObject({ agentKey: c.crew.other.id, write: true });
    expect(await rights(c, c.tokens.ceo, c.crew.other.id)).toEqual({ type: 'ready', write: false, message: true });
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
    expect(await rights(c, c.tokens.ceo, c.crew.other.id)).toEqual({ type: 'ready', write: false, message: true });
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
    const [before] = await c.db.select(only(agents, 'nodeId')).from(agents).where(eq(agents.id, c.crew.other.id));
    expect(await open(c.url, c.tokens.ann, c.crew.other.id)).toMatchObject({ status: 403 });
    const [after] = await c.db.select(only(agents, 'nodeId')).from(agents).where(eq(agents.id, c.crew.other.id));
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
  /* Keys and sizes have the view look again at its rights once a second went by since its last look: the clock moves that second. */
  const aSecondLater = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1000);
  };
  afterEach(() => vi.useRealTimers());

  /* A view that ends for good tells the node so: no view of this person comes back to it, so it holds the program no longer. */
  it('closes at once when the agent moves to a plan of someone else, and tells the node the view ended for good', async () => {
    const c = await company();
    const { screen, termId } = await watching(c);
    expect((await moved(c, c.crew.mine.id, c.plans.bob.id)).statusCode).toBe(200);
    expect(await screen.closed).toEqual(noAccess);
    expect(await next(c.node, 'term.close')).toEqual({ type: 'term.close', termId, final: true });
  });

  it('tells the node of a view the browser closed that it may come back', async () => {
    const c = await company();
    const { screen, termId } = await watching(c);
    screen.ws.close();
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
    const { screen } = await watching(c, c.tokens.clara, c.crew.other.id);
    await c.app.inject({ method: 'PUT', url: `/api/people/${c.ids.clara}/ceo-delegate`, payload: { isCeoDelegate: false }, ...as(c.tokens.ceo) });
    expect(await screen.closed).toEqual(noAccess);
  });

  it('sends nothing of the screen once it knows', async () => {
    const c = await company();
    const { screen, termId } = await watching(c);
    await moved(c, c.crew.mine.id, c.plans.bob.id);
    await next(c.node, 'term.close');
    const said = screen.frames.length;
    c.node.send({ type: 'term.data', termId, data: 'WORDS OF A CLOSED SCREEN' });
    await handled(c.node);
    await screen.closed;
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
    aSecondLater();
    screen.ws.send(JSON.stringify(frame));
    expect(await screen.closed).toEqual(noAccess);
    await handled(c.node);
    const seen: string[] = [];
    while (c.node.queued()) seen.push((await c.node.next()).type);
    expect(seen).not.toContain(heard);
  });

  it('opens again with the rights of now when the person still sees it but is no longer the one who types', async () => {
    const c = await company({ STREAM_PING_MS: '100' });
    const running = await turnOn(c, c.crew.deputy.id, c.plans.clara.id);
    await onPlan(c, c.crew.deputy.id, c.plans.wes.id);
    const { screen } = await watching(c, c.tokens.clara, c.crew.deputy.id);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: true, message: true });
    await turnOn(c, c.crew.deputy.id, c.plans.wes.id, 'done');
    await ended(c, running.id);
    expect(await screen.closed).toEqual({ code: 4410, reason: 'node_offline' });
    expect(await rights(c, c.tokens.clara, c.crew.deputy.id)).toEqual({ type: 'ready', write: false, message: true });
  });

  it('takes the keys of someone who may type right up to when the right goes', async () => {
    const c = await company();
    const { screen, termId } = await watching(c);
    aSecondLater();
    screen.ws.send(JSON.stringify({ type: 'input', data: 'still mine\r' }));
    expect(await next(c.node, 'term.input')).toMatchObject({ termId, data: 'still mine\r' });
  });
});

describe('a person who may only write a message', () => {
  it('steers nothing, by what the server knows and not by what the browser says', async () => {
    const c = await company();
    const invited = await invitePerson(c.app, c.tokens.ceo, { name: 'Dana', email: 'dana@acme.com', access: { whole: true } });
    await c.db.update(people).set({ isCeoDelegate: true }).where(eq(people.name, 'Dana'));
    const screen = await opened(c.url, invited, c.crew.other.id);
    const seen = await next(c.node, 'term.open');
    screen.ws.send(JSON.stringify({ type: 'input', data: '/login\r', write: true, sender: c.ids.bob }));
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 81, rows: 21 }));
    expect(await next(c.node, 'term.resize')).toMatchObject({ termId: seen.termId, cols: 81 });
  });
});
