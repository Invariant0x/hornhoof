import { eq } from 'drizzle-orm';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { sessions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { AppMode, modeGate, refusalOf, whileLeading } from '../src/modules/keeper/app-mode.js';
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

  it('enters a hook registered while leading at once, and in the order hooks were registered', async () => {
    const dir = folder();
    const { mode } = modeIn(dir);
    const order: string[] = [];
    mode.whenLead(() => void order.push('first in'), () => void order.push('first out'));
    writeKeeperState(dir, stateOf('lead'));
    await mode.check();
    mode.whenLead(() => void order.push('late in'), () => void order.push('late out'));
    expect(order).toEqual(['first in', 'late in']);
    writeKeeperState(dir, stateOf('read'));
    await mode.check();
    expect(order.slice(2)).toEqual(['first out', 'late out']);
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
    expect(ask('read', 'POST', '/mcp')).toBe('read_only');
    expect(ask('maintenance', 'DELETE', '/api/x')).toBe('maintenance');
    expect(ask('read', 'GET', '/api/nodes/socket', 'WebSocket')).toBe('read_only');
    expect(ask('maintenance', 'GET', '/api/nodes/socket', 'websocket')).toBe('maintenance');
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
  if (first) writeKeeperState(dir, stateOf(first, Date.now()));
  const made = await testApp({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: dir, NODE_KEY, TUNNEL_HOST: TUNNEL });
  const say = (mode: Mode) => writeKeeperState(dir, stateOf(mode, Date.now()));
  const modeNow = async () => (await made.app.inject({ url: '/api/health' })).json().mode;
  const reaches = (mode: Mode) => until(async () => (await modeNow()) === mode, 4000);
  return { ...made, dir, say, reaches };
}

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
    for (const refused of [mcp, login, socket]) {
      expect(refused.statusCode).toBe(503);
      expect(refused.json().error).toMatchObject({ code: 'unavailable', reason });
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

  it('closes open sockets when it leaves lead, and refuses new ones while it is away', async () => {
    const { app, say } = await appWithKeeper('lead');
    const url = await listen(app);
    const node = await connectNode(url, NODE_KEY);
    say('maintenance');
    const code = await Promise.race([node.closed, new Promise<number>(done => setTimeout(() => done(-1), 4000))]);
    expect(code).toBe(1012);
    await expect(connectNode(url, NODE_KEY)).rejects.toThrow(/503/);
  });
});
