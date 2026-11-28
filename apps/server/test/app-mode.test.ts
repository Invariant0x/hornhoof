import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { agents, nodes, sessions, subscriptions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import type { AgentSql } from '../src/db/agent-sql.js';
import { idOnly } from '../src/db/selections.js';
import { startTimers } from '../src/modules/agents/timers.js';
import { agentSqlFollowsMode, AppMode, modeGate, refusalOf, whileLeading } from '../src/modules/keeper/app-mode.js';
import { NODE_STALE_MS } from '../src/modules/nodes/nodes.js';
import { freshState, KEEPER_FILE, readKeeperState, writeKeeperState, type KeeperState, type Mode } from '../src/modules/keeper/state.js';
import { as, connectNode, listen, setUpCompany, testApp, TUNNEL, until, viaLink } from './helpers.js';

const NOW = 1_700_000_000_000;
const NODE_KEY = 'k'.repeat(40);

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-mode-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const stateOf = (mode: Mode, at: number = NOW): KeeperState => ({ mode, at: new Date(at).toISOString(), link: null });

function modeIn(dir: string, extra: Partial<ConstructorParameters<typeof AppMode>[0]> = {}) {
  const lines: string[] = [];
  const mode = new AppMode({ dir, fromKeeper: true, now: () => NOW, log: line => lines.push(line), ...extra });
  return { mode, lines };
}

/* A promise the test opens by hand, so a hook stays in the middle of its work for as long as the test needs. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>(done => (open = done));
  return { opened, open };
}

describe('timer shutdown evidence', () => {
  async function timerMode() {
    const records: { event?: string; attemptId?: string; processId?: number; msg?: string }[] = [];
    const { app, db } = await testApp({}, { stream: { write: line => { records.push(JSON.parse(line)); } } });
    const dir = folder();
    const { mode } = modeIn(dir);
    startTimers(app, { ...app.ctx, mode });
    onTestFinished(() => mode.stop());
    const switchTo = (next: Mode) => {
      writeKeeperState(dir, stateOf(next));
      return mode.check();
    };
    return { db, mode, records, switchTo };
  }

  it('logs matching start and completion events with a fresh attempt ID for each drain', async () => {
    const { mode, records, switchTo } = await timerMode();
    await switchTo('lead');
    await switchTo('read');
    await switchTo('lead');
    await mode.stop();
    const events = records.filter(({ event }) => event?.startsWith('timer_sweeps_drain'));
    expect(events.map(({ event }) => event)).toEqual([
      'timer_sweeps_drain_started', 'timer_sweeps_drained', 'timer_sweeps_drain_started', 'timer_sweeps_drained',
    ]);
    const [first, firstDone, second, secondDone] = events;
    expect(first).toMatchObject({ attemptId: expect.any(String), processId: process.pid });
    expect(firstDone).toMatchObject({ attemptId: first!.attemptId, processId: process.pid });
    expect(second).toMatchObject({ attemptId: expect.any(String), processId: process.pid });
    expect(secondDone).toMatchObject({ attemptId: second!.attemptId, processId: process.pid });
    expect(second!.attemptId).not.toBe(first!.attemptId);
  });

  it('logs the drain start but omits completion after a timer step reports an error', async () => {
    const { db, mode, records, switchTo } = await timerMode();
    vi.spyOn(db, 'update').mockImplementationOnce(() => { throw new Error('test database error'); });
    await switchTo('lead');
    await mode.stop();
    expect(records).toContainEqual(expect.objectContaining({ msg: 'ending the node connections of the last run failed' }));
    expect(records.filter(({ event }) => event?.startsWith('timer_sweeps_drain')).map(({ event }) => event)).toEqual(['timer_sweeps_drain_started']);
  });
});

describe('the keeper file', () => {
  it('is written whole and read back', () => {
    const dir = folder();
    const state: KeeperState = { mode: 'lead', at: new Date(NOW).toISOString(), link: { host: 'acme.hornhoof.test', fingerprint256: null } };
    writeKeeperState(dir, state);
    expect(readKeeperState(dir)).toEqual(state);
  });

  it('reads as nothing when it is missing, not JSON, or not this shape', () => {
    const dir = folder();
    expect(readKeeperState(dir)).toBeNull();
    writeFileSync(join(dir, KEEPER_FILE), 'not json');
    expect(readKeeperState(dir)).toBeNull();
    writeFileSync(join(dir, KEEPER_FILE), '{"mode":"nope"}');
    expect(readKeeperState(dir)).toBeNull();
  });

  it('counts a word fresh for ten seconds', () => {
    const dir = folder();
    writeKeeperState(dir, stateOf('lead', NOW - 10_000));
    expect(freshState(dir, NOW)?.mode).toBe('lead');
    writeKeeperState(dir, stateOf('lead', NOW - 10_001));
    expect(freshState(dir, NOW)).toBeNull();
    expect(freshState(dir, NOW, 20_000)?.mode).toBe('lead');
  });

  it('counts a word from the future as no word, however little ahead', () => {
    const dir = folder();
    writeKeeperState(dir, stateOf('lead', NOW + 1));
    expect(freshState(dir, NOW)).toBeNull();
    writeKeeperState(dir, stateOf('lead', NOW));
    expect(freshState(dir, NOW)?.mode).toBe('lead');
  });
});

describe('AppMode', () => {
  it('leads at once without a keeper', () => {
    const { mode, lines } = modeIn(folder(), { fromKeeper: false });
    expect(mode.current()).toBe('off');
    mode.start();
    expect(mode.current()).toBe('lead');
    expect(lines).toEqual(['Hornhoof now runs in lead mode.']);
  });

  it('is off until the keeper writes, then takes its mode', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    await mode.check();
    expect(mode.current()).toBe('off');
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    expect(mode.current()).toBe('lead');
    writeKeeperState(dir, stateOf('maintenance'));
    await mode.check();
    expect(mode.current()).toBe('maintenance');
  });

  it('stops leading once the keeper has said nothing fresh for ten seconds, and leads again on its next word', async () => {
    const dir = folder();
    let now = NOW;
    const { mode, lines } = modeIn(dir, { now: () => now });
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    now = NOW + 10_000;
    await mode.check();
    expect(mode.current()).toBe('lead');
    now = NOW + 10_001;
    await mode.check();
    expect(mode.current()).toBe('read');
    expect(lines.at(-1)).toBe('Hornhoof now runs in read mode.');
    writeKeeperState(dir, stateOf('lead', now));
    await mode.check();
    expect(mode.current()).toBe('lead');
  });

  it('keeps a maintenance the keeper stopped speaking of: only its word ends one', async () => {
    const dir = folder();
    let now = NOW;
    const { mode } = modeIn(dir, { now: () => now });
    writeKeeperState(dir, stateOf('maintenance'));
    await mode.check();
    now = NOW + 60_000;
    await mode.check();
    expect(mode.current()).toBe('maintenance');
  });

  it("keeps its mode when the keeper's word is stale or unreadable", async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    writeKeeperState(dir, stateOf('maintenance', NOW - 11_000));
    await mode.check();
    expect(mode.current()).toBe('lead');
    writeFileSync(join(dir, KEEPER_FILE), '{"mode":"nope"}');
    await mode.check();
    expect(mode.current()).toBe('lead');
  });

  it('runs lead work on the way in and out', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    const counts = { enter: 0, leave: 0 };
    mode.whenLead(() => void counts.enter++, () => void counts.leave++);
    for (const next of ['lead', 'maintenance', 'lead'] as const) {
      writeKeeperState(dir, stateOf(next));
      await mode.check();
    }
    await mode.stop();
    expect(counts).toEqual({ enter: 2, leave: 2 });
  });

  it('enters a hook registered while leading, and in the order hooks were registered', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    const order: string[] = [];
    mode.whenLead(() => void order.push('first in'), () => void order.push('first out'));
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    mode.whenLead(() => void order.push('late in'), () => void order.push('late out'));
    await mode.settled();
    expect(order).toEqual(['first in', 'late in']);
    writeKeeperState(dir, stateOf('read'));
    await mode.check();
    expect(order.slice(2)).toEqual(['first out', 'late out']);
  });

  it('enters a hook registered after start only once the hooks before it have ended', async () => {
    const { mode } = modeIn(folder(), { fromKeeper: false });
    const order: string[] = [];
    const first = gate();
    mode.whenLead(async () => {
      order.push('first in');
      await first.opened;
      order.push('first done');
    }, () => undefined);
    mode.start();
    mode.whenLead(() => void order.push('second in'), () => undefined);
    await Promise.resolve();
    first.open();
    await mode.settled();
    expect(order).toEqual(['first in', 'first done', 'second in']);
  });

  /* The app is in lead with a first hook still entering, the second waiting behind it. */
  async function midwayIntoLead(dir: string, order: string[]) {
    const { mode } = modeIn(dir);
    const reached = gate();
    const slow = gate();
    mode.whenLead(async () => {
      order.push('slow in');
      reached.open();
      await slow.opened;
    }, () => void order.push('slow out'));
    mode.whenLead(() => void order.push('next in'), () => void order.push('next out'));
    writeKeeperState(dir, stateOf('lead'));
    void mode.check();
    await reached.opened;
    return { mode, slow };
  }

  it('stops the remaining hooks of a stay in lead that ended, and leaves only those it entered', async () => {
    const dir = folder();
    const order: string[] = [];
    const { mode, slow } = await midwayIntoLead(dir, order);
    mode.whenLead(() => void order.push('late in'), () => void order.push('late out'));
    writeKeeperState(dir, stateOf('read'));
    void mode.check();
    slow.open();
    await mode.settled();
    expect(order).toEqual(['slow in', 'slow out']);
  });

  it('finishes leaving before it enters again, on a quick lead, read, lead', async () => {
    const dir = folder();
    const order: string[] = [];
    const { mode, slow } = await midwayIntoLead(dir, order);
    writeKeeperState(dir, stateOf('read'));
    void mode.check();
    writeKeeperState(dir, stateOf('lead'));
    void mode.check();
    slow.open();
    await mode.settled();
    expect(order).toEqual(['slow in', 'slow out', 'slow in', 'next in']);
  });

  it('runs whenLeaving in the very call that leaves lead, ahead of a hook still at work', async () => {
    const dir = folder();
    const { mode, slow } = await midwayIntoLead(dir, []);
    const left: string[] = [];
    mode.whenLeaving(() => {
      left.push('first');
      throw new Error('boom');
    });
    mode.whenLeaving(() => void left.push('second'));
    writeKeeperState(dir, stateOf('read'));
    void mode.check();
    expect(left).toEqual(['first', 'second']);
    writeKeeperState(dir, stateOf('maintenance'));
    void mode.check();
    expect(left).toEqual(['first', 'second']);
    slow.open();
    await mode.settled();
  });

  it('tells its hooks of every change, in the order they were registered', async () => {
    const dir = folder();
    const { mode, lines } = modeIn(dir);
    const heard: string[] = [];
    mode.onChange((from, to) => void heard.push(`first ${from} ${to}`));
    mode.onChange(() => { throw new Error('boom'); });
    mode.onChange((from, to) => void heard.push(`third ${from} ${to}`));
    /* Work of lead mode starts after them. */
    mode.whenLead(() => void heard.push('lead work'), () => void heard.push('lead work ends'));
    for (const next of ['read', 'lead', 'lead', 'off'] as const) {
      writeKeeperState(dir, stateOf(next));
      await mode.check();
    }
    expect(heard).toEqual(['first off read', 'third off read', 'first read lead', 'third read lead', 'lead work', 'first lead off', 'third lead off', 'lead work ends']);
    /* The one that throws is a line each time, and stops neither the next hook nor the change. */
    expect(lines.filter(line => line.includes('boom'))).toHaveLength(3);
    expect(mode.current()).toBe('off');
  });

  it('grants once the keeper speaks', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    const opened: { closed: boolean }[] = [];
    const holder: { agentSql?: AgentSql | null; agentSqlPending?: boolean } = {};
    const open = async (): Promise<AgentSql> => {
      const mine = { closed: false };
      opened.push(mine);
      return { run: async () => [], close: async () => void (mine.closed = true) } as unknown as AgentSql;
    };
    agentSqlFollowsMode({ mode, holder, open });
    /* Until the keeper's first word nothing is granted: the database may still be empty. */
    expect([opened.length, holder.agentSqlPending, holder.agentSql]).toEqual([0, true, null]);
    writeKeeperState(dir, stateOf('read'));
    await mode.check();
    expect([opened.length, holder.agentSqlPending]).toEqual([1, false]);
    const first = holder.agentSql;
    expect(first).not.toBeNull();
    /* A change between other modes grants nothing anew. */
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    expect(opened.length).toBe(1);
    /* Off and back: the database may be another one now, so the roles get their rights again, and the old pools go. */
    writeKeeperState(dir, stateOf('off'));
    await mode.check();
    expect([opened.length, holder.agentSql === first]).toEqual([1, true]);
    writeKeeperState(dir, stateOf('read'));
    await mode.check();
    expect(opened.map(one => one.closed)).toEqual([true, false]);
    expect(holder.agentSql).not.toBe(first);
  });

  it('lets the next hook run when one throws, and says so in one log line', async () => {
    const dir = folder();
    const { mode, lines } = modeIn(dir);
    let second = 0;
    mode.whenLead(() => { throw new Error('boom'); }, () => undefined);
    mode.whenLead(() => void second++, () => undefined);
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    expect(second).toBe(1);
    expect(mode.current()).toBe('lead');
    expect(lines.filter(line => line.includes('boom'))).toHaveLength(1);
  });

  it('hides a password in what a failed hook logs', async () => {
    const dir = folder();
    const { mode, lines } = modeIn(dir);
    mode.whenLead(() => { throw new Error('no database at postgres://hornhoof:hunter2@db/x'); }, () => undefined);
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    expect(lines.filter(line => line.includes('hunter2'))).toEqual([]);
    expect(lines.filter(line => line.includes('no database at'))).toHaveLength(1);
  });

  it('waits for a slow leave hook in the check that leaves', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    let finished = false;
    mode.whenLead(() => undefined, () => new Promise<void>(done => setTimeout(() => { finished = true; done(); }, 200)));
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    writeKeeperState(dir, stateOf('maintenance'));
    await mode.check();
    expect(finished).toBe(true);
  });
});

describe('AppMode on the clock, behind a keeper', () => {
  function clocked() {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const dir = folder();
    return { dir, ...modeIn(dir) };
  }

  it('takes the keeper\'s word in the start itself, and acts on a new word within 2 s, ahead of any hook', async () => {
    const { dir, mode } = clocked();
    const told: Mode[] = [];
    writeKeeperState(dir, stateOf('lead'));
    mode.whenLead(() => new Promise(() => undefined), () => undefined);
    mode.whenLeaving(() => void told.push(mode.current()));
    mode.start();
    expect(mode.current()).toBe('lead');
    writeKeeperState(dir, stateOf('maintenance'));
    vi.advanceTimersByTime(2000);
    expect(told).toEqual(['maintenance']);
  });

  it('reads no more once stopped, though it was started twice', async () => {
    const { dir, mode } = clocked();
    mode.start();
    mode.start();
    await mode.stop();
    writeKeeperState(dir, stateOf('lead'));
    vi.advanceTimersByTime(2000);
    expect(mode.current()).toBe('off');
  });

  it('takes no word in a late check after stop', async () => {
    const { dir, mode } = clocked();
    await mode.stop();
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    expect(mode.current()).toBe('off');
  });
});

describe('whileLeading', () => {
  it('does its work in lead, and in maintenance and off resolves without doing it', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    const calls: number[] = [];
    const work = whileLeading(mode, async (n: number) => void calls.push(n));
    await work(0);
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    await work(1);
    writeKeeperState(dir, stateOf('maintenance'));
    await mode.check();
    await work(2);
    expect(calls).toEqual([1]);
  });

  it('does not run a call that was queued in lead once the app has left it', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    const calls: string[] = [];
    const work = whileLeading(mode, async (name: string) => void calls.push(name));
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    let release!: () => void;
    const slow = new Promise<void>(done => (release = done));
    const queued = slow.then(() => work('late'));
    writeKeeperState(dir, stateOf('maintenance'));
    await mode.check();
    release();
    await queued;
    expect(calls).toEqual([]);
  });
});

describe('what each mode allows', () => {
  const ask = (mode: Mode, method: string, url: string, upgrade?: string) => refusalOf(mode, { method, url, headers: upgrade ? { upgrade } : {} });

  it('lets everything through in lead', () => {
    expect(ask('lead', 'POST', '/api/anything')).toBeNull();
    expect(ask('lead', 'GET', '/api/nodes/socket', 'websocket')).toBeNull();
  });

  it('lets reads through in read and maintenance, and names the reason of the rest', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(ask('read', method, '/api/me')).toBeNull();
    expect(ask('maintenance', 'GET', '/api/me')).toBeNull();
    /* An agent's tool calls pass in read, where the ones that read are answered; any other change does not. */
    expect(ask('read', 'POST', '/mcp')).toBeNull();
    expect(ask('read', 'POST', '/api/tasks')).toBe('read_only');
    expect(ask('maintenance', 'POST', '/mcp')).toBe('maintenance');
    expect(ask('maintenance', 'DELETE', '/api/x')).toBe('maintenance');
    expect(ask('read', 'GET', '/api/nodes/socket', 'WebSocket')).toBe('read_only');
    expect(ask('maintenance', 'GET', '/api/nodes/socket', 'websocket')).toBe('maintenance');
  });

  it("takes a sign-in, a sign-out and the CEO's answer to a copy's question in read, and nowhere else", () => {
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/network/question/go-on', '/api/network/question/wait', '/mcp']) {
      expect(ask('read', 'POST', path), path).toBeNull();
      expect(ask('read', 'POST', `${path}?x=1`), path).toBeNull();
      expect(ask('maintenance', 'POST', path), path).toBe('maintenance');
      expect(ask('off', 'POST', path), path).toBe('starting');
      expect(ask('read', 'PUT', path), path).toBe('read_only');
    }
    expect(ask('read', 'POST', '/api/auth/login/more')).toBe('read_only');
  });

  it('lets only the health answer through in off', () => {
    expect(ask('off', 'GET', '/api/health')).toBeNull();
    expect(ask('off', 'GET', '/api/health?x=1')).toBeNull();
    expect(ask('off', 'GET', '/api/me')).toBe('starting');
    expect(ask('off', 'POST', '/api/health')).toBe('starting');
  });

  it('refuses with a 503 that carries the reason and its words', async () => {
    const { mode } = modeIn(folder());
    await expect(modeGate(mode)({ method: 'GET', url: '/api/me', headers: {} } as never)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
      reason: 'starting',
      message: 'Hornhoof is starting.',
    });
  });
});

async function appWithKeeper(first?: Mode) {
  const dir = folder();
  const made = await testApp({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir, NODE_KEY, TUNNEL_HOST: TUNNEL });
  const say = (mode: Mode) => writeKeeperState(dir, stateOf(mode, Date.now()));
  /* Said once the app is built and not yet started, so a slow build cannot make the word stale. */
  if (first) say(first);
  const modeNow = async () => (await made.app.inject({ url: '/api/health' })).json().mode;
  /* How soon the poll comes is shown on the clock above, so this bound only has to outlast a loaded machine. */
  const reaches = (mode: Mode) => until(async () => (await modeNow()) === mode);
  return { ...made, dir, say, reaches };
}

/* A company with a plan and a node for it, whose key the test can connect with. */
async function companyWithNode(app: FastifyInstance) {
  const ceo = await setUpCompany(app);
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
  const code = connected.json().command.split('--join ')[1];
  const payload = { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
  const [node] = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload })).json().nodes;
  return { ceo, nodeId: node.nodeId as string, subId: node.subscriptionId as string, key: node.key as string };
}
type CompanyWithNode = Awaited<ReturnType<typeof companyWithNode>>;

describe('the app behind a keeper', () => {
  it('answers only health while off', async () => {
    const { app, config } = await appWithKeeper();
    const health = await app.inject({ url: '/api/health' });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toEqual({ ok: false, version: config.version, commit: config.commit, mode: 'off' });
    const me = await app.inject({ url: '/api/me' });
    expect(me.statusCode).toBe(503);
    expect(me.json().error.reason).toBe('starting');
  });

  it('keeps the health answer a bare ok over the link', async () => {
    const { app } = await appWithKeeper('lead');
    const health = await app.inject({ url: '/api/health', ...viaLink() });
    expect(health.json()).toEqual({ ok: true });
  });

  const refusesChanges = async (first: Mode, then: Mode, reason: string) => {
    const { app, say, reaches } = await appWithKeeper(first);
    const token = await setUpCompany(app);
    say(then);
    await reaches(then);
    expect((await app.inject({ url: '/api/me', ...as(token) })).statusCode).toBe(200);
    const mcp = await app.inject({ method: 'POST', url: '/mcp', payload: {}, ...as(token) });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@b.test', password: 'x' } });
    const socket = await app.inject({ url: '/api/nodes/socket', headers: { upgrade: 'websocket', connection: 'upgrade' } });
    const change = await app.inject({ method: 'POST', url: '/api/tasks', payload: {}, ...as(token) });
    /* A machine that only reads still takes a sign-in, which writes nothing there, and the agents' tool calls, which
       it answers by its own rules. */
    for (const refused of then === 'read' ? [change, socket] : [mcp, change, login, socket]) {
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error).toMatchObject({ code: 'unavailable', reason });
    }
    if (then === 'read') {
      expect([login.statusCode, login.json().error.reason]).toEqual([401, 'wrong_password']);
      /* The call carries no job's token, so it is nobody's. */
      expect(mcp.statusCode).toBe(401);
    }
  };

  it('serves reads and refuses changes in maintenance', () => refusesChanges('lead', 'maintenance', 'maintenance'));

  it('answers read_only in read', () => refusesChanges('lead', 'read', 'read_only'));

  it('hands over no session outside lead', async () => {
    const { app, db, say, reaches } = await appWithKeeper('lead');
    const token = await setUpCompany(app);
    await db.update(sessions).set({ beforeHostCookie: true }).where(eq(sessions.tokenHash, hashToken(token)));
    const before = await db.select().from(sessions);
    say('maintenance');
    await reaches('maintenance');
    const res = await app.inject({ url: '/api/me', ...viaLink(), cookies: { hh_session: token } });
    expect(res.cookies.some(cookie => cookie.name === '__Host-hh_session')).toBe(false);
    expect(await db.select().from(sessions)).toEqual(before);
  });

  it('writes nothing on the screens that show nodes, with a node silent for over a day', async () => {
    const { app, db, say, reaches } = await appWithKeeper('lead');
    const { ceo, nodeId, subId } = await companyWithNode(app);
    await db.update(nodes).set({ status: 'ready', lastSeenAt: new Date(Date.now() - NODE_STALE_MS - 60_000) }).where(eq(nodes.id, nodeId));
    await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, subId));
    const [orchestrator] = await db.select(idOnly(agents)).from(agents);
    say('read');
    await reaches('read');
    for (const url of ['/api/org', '/api/subscriptions', `/api/agents/${orchestrator!.id}`, '/api/machines', '/api/pool']) {
      expect((await app.inject({ url, ...as(ceo) })).statusCode).toBe(200);
      expect((await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.status, url).toBe('ready');
      expect((await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.status, url).toBe('ready');
    }
  });

  /* That the poll comes within 2 s is shown on the clock above; this is the way from the keeper's word to the socket. */
  it('closes open sockets when it leaves lead, and refuses new ones while it is away', async () => {
    const { app, say } = await appWithKeeper('lead');
    const url = await listen(app);
    const node = await connectNode(url, NODE_KEY);
    say('maintenance');
    expect(await node.closed).toBe(1012);
    await expect(connectNode(url, NODE_KEY)).rejects.toThrow(/503/);
  });

  it('closes open sockets at once on leaving lead, though the way in is still at work', async () => {
    const { app, say, reaches } = await appWithKeeper('read');
    const url = await listen(app);
    const stuck = gate();
    onTestFinished(stuck.open);
    app.ctx.links.sync = () => stuck.opened.then(() => true);
    say('lead');
    await reaches('lead');
    const node = await connectNode(url, NODE_KEY);
    say('maintenance');
    expect(await node.closed).toBe(1012);
  });
});

describe('a socket whose connect crosses a step-down', () => {
  /* The app steps down once the first gate has let the connect through, as it may while a route's own checks wait for
     the database. */
  async function steppingDown(path: (at: CompanyWithNode) => string, headers: (at: CompanyWithNode) => Record<string, string>) {
    const { app, say } = await appWithKeeper('lead');
    let armed = false;
    app.addHook('preValidation', async req => {
      if (!armed || !req.ws) return;
      say('read');
      await app.ctx.mode.check();
    });
    const nodeSocket = await listen(app);
    const at = await companyWithNode(app);
    armed = true;
    return new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(nodeSocket.replace('/api/nodes/socket', path(at)), { headers: headers(at) });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('error', reject);
    });
  }

  it("is refused on a node's socket", async () => {
    expect(await steppingDown(() => '/api/nodes/socket', at => ({ authorization: `Bearer ${at.key}` }))).toBe(503);
  });

  it("is refused on an agent's terminal", async () => {
    expect(await steppingDown(() => '/api/agents/orchestrator/terminal?cols=100&rows=30', at => ({ cookie: `hh_session=${at.ceo}` }))).toBe(503);
  });

  it("is refused on a plan's sign-in terminal", async () => {
    const path = (at: CompanyWithNode) => `/api/subscriptions/${at.subId}/signin/terminal?nodeId=${at.nodeId}&cols=100&rows=30`;
    expect(await steppingDown(path, at => ({ cookie: `hh_session=${at.ceo}` }))).toBe(503);
  });
});
