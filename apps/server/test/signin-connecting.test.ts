import type { FastifyInstance } from 'fastify';
import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { nodes } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, nextOf, openStream, setUpCompany, TEST_SECRET, testApp, until, type FakeNode, type StreamReader } from './helpers.js';

/* 19.11: after the sign-in code, nothing on the plan's card changed while its program connected, and an Antigravity plan
   took so long that its owner could not tell whether it worked or hung. From the first step its node reports until the
   plan is ready, the plan says it is connecting, at which step and since when; a failure says why; past one limit for the
   whole connection it says that, and its owner can try again or stop. The server's clock and rounds go only as far as a
   test moves them. */

const MINUTE = 60_000;
/* The longest the whole connection takes before its owner hears it takes too long, unless set otherwise. */
const LIMIT = 10 * MINUTE;
/* The server looks at the connections once a second. */
const ROUND = 1000;
const T0 = new Date('2026-11-19T22:00:00.000Z');
const LAPTOP = { machineId: 'laptop-0002-abcd', hostname: 'dev-laptop', os: 'linux', arch: 'x86_64' };
const KEY = 'age1' + 'c'.repeat(58);

type Joined = { nodeId: string; subscriptionId: string; provider: string; key: string };
type Connecting = { nodeId: string; hostname: string; state: string; step: string; since: string; until: string; error: string | null; code: number | null; line: string | null };

const codeOf = (command: string) => command.split('--join ')[1]!;
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

/* The owner's Codex and Antigravity plans on one machine, each with its node online and not signed in yet. */
async function plans(env: NodeJS.ProcessEnv = {}) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp(env);
  const owner = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex', 'antigravity'] }, ...as(owner) })).json();
  const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: codeOf(connected.command), ...LAPTOP } })).json().nodes as Joined[];
  const url = await listen(app);
  const online = async (provider: 'codex' | 'antigravity') => {
    const n = joined.find(j => j.provider === provider)!;
    const node = await connectNode(url, n.key);
    node.send({ type: 'hello', version: '0.39.2', loggedIn: false, running: [], publicKey: KEY, terminals: true });
    await until(async () => (await db.select({ k: nodes.publicKey }).from(nodes).where(eq(nodes.id, n.nodeId)))[0]?.k === KEY);
    return { node, nodeId: n.nodeId, plan: n.subscriptionId };
  };
  const codex = await online('codex');
  const agy = await online('antigravity');
  const stream = await openStream(app, owner);
  onTestFinished(() => stream.close());
  return { app, db, owner, codex, agy, stream };
}

/* The plan as its owner's list shows it. */
async function planOf(app: FastifyInstance, token: string, plan: string) {
  const list = (await app.inject({ method: 'GET', url: '/api/subscriptions', ...as(token) })).json().subscriptions as { id: string; status: string; connecting: Connecting | null }[];
  return list.find(s => s.id === plan)!;
}

/* What the stream said last of the plan's connection, once it said something new; undefined while it said nothing. */
const said = (stream: StreamReader, plan: string) =>
  stream.messages.filter(m => m.type === 'subscription.connecting' && m.subscriptionId === plan).map(m => m.connecting as Connecting | null);

async function saysNext(stream: StreamReader, plan: string, before: number, check: (c: Connecting | null) => boolean = () => true): Promise<Connecting | null> {
  await until(() => said(stream, plan).slice(before).some(check));
  return said(stream, plan).slice(before).filter(check).at(-1)!;
}

/* The node says it is signed in, as a node does once its program took the sign-in. */
const signedIn = (node: FakeNode) => node.send({ type: 'status', loggedIn: true, limits: null });

/* The server's clock moves on, and its rounds with it. */
const later = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };

describe('connecting a plan after its sign-in code', () => {
  it('has one limit for the whole connection, ten minutes unless set otherwise', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).signinConnectMs).toBe(LIMIT);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, SIGNIN_CONNECT_MS: '120000' }).signinConnectMs).toBe(2 * MINUTE);
    expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, SIGNIN_CONNECT_MS: 'soon' })).toThrow(/SIGNIN_CONNECT_MS/);
  });

  it('shows a Codex plan connecting from the first step its node reports, at the step it is at and since when, until it is ready', async () => {
    const { app, owner, codex, stream } = await plans();
    codex.node.send({ type: 'login.step', step: 'checking' });
    const first = await saysNext(stream, codex.plan, 0);
    const shown = { nodeId: codex.nodeId, hostname: 'dev-laptop', state: 'connecting', step: 'checking', since: at(0), until: at(LIMIT), error: null, code: null, line: null };
    expect(first).toEqual(shown);
    expect((await planOf(app, owner, codex.plan)).connecting).toEqual(shown);
    await later(5000);
    codex.node.send({ type: 'login.step', step: 'saving' });
    expect(await saysNext(stream, codex.plan, 1)).toEqual({ ...shown, step: 'saving' });
    codex.node.send({ type: 'login.step', step: 'models' });
    expect(await saysNext(stream, codex.plan, 2)).toEqual({ ...shown, step: 'models' });
    signedIn(codex.node);
    codex.node.send({ type: 'login.done', ok: true, error: null });
    expect(await saysNext(stream, codex.plan, 3)).toBeNull();
    const ready = await planOf(app, owner, codex.plan);
    expect(ready).toMatchObject({ status: 'ready', connecting: null });
  });

  it('shows an Antigravity plan connecting from the steps of its sign-in in the install window, until it is ready', async () => {
    const { app, owner, agy, stream } = await plans();
    agy.node.send({ type: 'login.step', step: 'checking' });
    expect(await saysNext(stream, agy.plan, 0)).toMatchObject({ state: 'connecting', step: 'checking', since: at(0) });
    await later(40_000);
    /* The program took the sign-in in the install window; the node reads what the plan can do before it says it is ready. */
    agy.node.send({ type: 'login.step', step: 'signed_in' });
    agy.node.send({ type: 'login.step', step: 'models' });
    expect(await saysNext(stream, agy.plan, 1, c => c?.step === 'models')).toMatchObject({ state: 'connecting', step: 'models', since: at(0) });
    agy.node.send({ type: 'login.step', step: 'limits' });
    expect(await saysNext(stream, agy.plan, 1, c => c?.step === 'limits')).toMatchObject({ state: 'connecting', step: 'limits' });
    expect((await planOf(app, owner, agy.plan)).connecting).toMatchObject({ step: 'limits', since: at(0) });
    const before = said(stream, agy.plan).length;
    signedIn(agy.node);
    expect(await saysNext(stream, agy.plan, before)).toBeNull();
    expect(await planOf(app, owner, agy.plan)).toMatchObject({ status: 'ready', connecting: null });
  });

  it('keeps showing a plan that was ready connecting while it signs in again, until the new sign-in is done', async () => {
    const { app, owner, codex, stream } = await plans();
    signedIn(codex.node);
    await until(async () => (await planOf(app, owner, codex.plan)).status === 'ready');
    codex.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, codex.plan, 0);
    signedIn(codex.node);
    codex.node.send({ type: 'login.step', step: 'saving' });
    expect(await saysNext(stream, codex.plan, 1)).toMatchObject({ state: 'connecting', step: 'saving' });
    expect((await planOf(app, owner, codex.plan)).connecting).toMatchObject({ state: 'connecting', step: 'saving' });
    codex.node.send({ type: 'login.done', ok: true, error: null });
    expect(await saysNext(stream, codex.plan, 2)).toBeNull();
  });

  it('says why a Codex connection failed, as its node said it, and keeps saying it', async () => {
    const { app, owner, codex, stream } = await plans();
    codex.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, codex.plan, 0);
    codex.node.send({ type: 'login.done', ok: false, error: SIGNIN_ERRORS.notTaken });
    expect(await saysNext(stream, codex.plan, 1)).toMatchObject({ state: 'failed', step: 'checking', error: SIGNIN_ERRORS.notTaken, line: null });
    await later(LIMIT + ROUND);
    expect((await planOf(app, owner, codex.plan)).connecting).toMatchObject({ state: 'failed', error: SIGNIN_ERRORS.notTaken });
  });

  it('says why an Antigravity connection failed, with the last line its program said', async () => {
    const { app, owner, agy, stream } = await plans();
    agy.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, agy.plan, 0);
    const line = 'Google did not take the code: invalid_grant';
    agy.node.send({ type: 'login.step', step: 'failed', error: SIGNIN_ERRORS.unfinished, line });
    expect(await saysNext(stream, agy.plan, 1)).toMatchObject({ state: 'failed', step: 'checking', error: SIGNIN_ERRORS.unfinished, line });
    expect((await planOf(app, owner, agy.plan)).connecting).toMatchObject({ state: 'failed', line });
  });

  it('says nothing of a sign-in that ended before its code, which says why where it ran', async () => {
    const { codex, stream } = await plans();
    codex.node.send({ type: 'login.done', ok: false, error: SIGNIN_ERRORS.stopped });
    await until(() => stream.messages.some(m => m.type === 'subscription.signin'));
    expect(said(stream, codex.plan)).toEqual([]);
  });

  it('says a connection takes too long past the one limit for the whole of it, whatever its steps, and still turns ready if it ends', async () => {
    const { app, owner, agy, stream } = await plans();
    agy.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, agy.plan, 0);
    await later(4 * MINUTE);
    agy.node.send({ type: 'login.step', step: 'models' });
    await saysNext(stream, agy.plan, 1);
    /* A new step does not move the limit: it is of the whole connection. */
    await later(6 * MINUTE - 2 * ROUND);
    expect((await planOf(app, owner, agy.plan)).connecting).toMatchObject({ state: 'connecting', step: 'models', until: at(LIMIT) });
    await later(3 * ROUND);
    expect(await saysNext(stream, agy.plan, 2)).toMatchObject({ state: 'too_long', step: 'models', since: at(0), until: at(LIMIT), error: null });
    expect((await planOf(app, owner, agy.plan)).connecting).toMatchObject({ state: 'too_long' });
    signedIn(agy.node);
    expect(await saysNext(stream, agy.plan, 3)).toBeNull();
    expect(await planOf(app, owner, agy.plan)).toMatchObject({ status: 'ready', connecting: null });
  });

  it('takes the limit it is set to', async () => {
    const { codex, stream } = await plans({ SIGNIN_CONNECT_MS: String(2 * MINUTE) });
    codex.node.send({ type: 'login.step', step: 'checking' });
    expect(await saysNext(stream, codex.plan, 0)).toMatchObject({ until: at(2 * MINUTE) });
    await later(2 * MINUTE + ROUND);
    expect(await saysNext(stream, codex.plan, 1)).toMatchObject({ state: 'too_long' });
  });

  it('stops on Cancel: the sign-in running on the node stops and the plan shows no connection', async () => {
    const { app, owner, codex, stream } = await plans();
    codex.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, codex.plan, 0);
    const cancel = await app.inject({ method: 'POST', url: `/api/subscriptions/${codex.plan}/connecting/cancel`, ...as(owner) });
    expect(cancel.statusCode).toBe(204);
    expect(await nextOf(codex.node, 'login.stop')).toEqual({ type: 'login.stop' });
    expect(await saysNext(stream, codex.plan, 1)).toBeNull();
    expect((await planOf(app, owner, codex.plan)).connecting).toBeNull();
  });

  it('tries an Antigravity connection again on Retry: its node checks the sign-in again, and the limit starts over', async () => {
    const { app, owner, agy, stream } = await plans();
    agy.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, agy.plan, 0);
    await later(LIMIT + ROUND);
    await saysNext(stream, agy.plan, 1, c => c?.state === 'too_long');
    const retry = await app.inject({ method: 'POST', url: `/api/subscriptions/${agy.plan}/connecting/retry`, ...as(owner) });
    expect(retry.statusCode).toBe(204);
    expect(await nextOf(agy.node, 'login.check')).toEqual({ type: 'login.check' });
    const before = said(stream, agy.plan).length;
    agy.node.send({ type: 'login.step', step: 'models' });
    expect(await saysNext(stream, agy.plan, before, c => c?.state === 'connecting')).toMatchObject({ step: 'models', since: at(LIMIT + ROUND), until: at(2 * LIMIT + ROUND) });
  });

  it('starts over on Retry of a Codex connection, which signs in again in a new terminal', async () => {
    const { app, owner, codex, stream } = await plans();
    codex.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, codex.plan, 0);
    codex.node.send({ type: 'login.done', ok: false, error: SIGNIN_ERRORS.notTaken });
    await saysNext(stream, codex.plan, 1);
    const again = await app.inject({ method: 'POST', url: `/api/subscriptions/${codex.plan}/signin`, payload: { fresh: false }, ...as(owner) });
    expect(again.statusCode).toBe(200);
    expect(await nextOf(codex.node, 'login.start')).toEqual({ type: 'login.start', fresh: false });
    expect(await saysNext(stream, codex.plan, 2)).toBeNull();
    expect((await planOf(app, owner, codex.plan)).connecting).toBeNull();
  });

  it("shows a plan's connection only to its owner, who signs it in", async () => {
    const { app, owner, codex, stream } = await plans();
    const other = await invitePerson(app, owner, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
    const theirs = await openStream(app, other);
    onTestFinished(() => theirs.close());
    codex.node.send({ type: 'login.step', step: 'checking' });
    await saysNext(stream, codex.plan, 0);
    await until(() => theirs.messages.some(m => m.type === 'org'));
    expect(theirs.messages.some(m => m.type === 'subscription.connecting')).toBe(false);
    expect((await planOf(app, other, codex.plan)).connecting).toBeNull();
  });

  it('cancels and retries only for the plan owner', async () => {
    const { app, owner, codex } = await plans();
    const other = await invitePerson(app, owner, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
    for (const what of ['cancel', 'retry']) {
      const answer = await app.inject({ method: 'POST', url: `/api/subscriptions/${codex.plan}/connecting/${what}`, ...as(other) });
      expect(answer.statusCode).toBe(403);
    }
  });
});
