import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { REPLICA_FILE } from '../src/modules/keeper/become.js';
import { COPY_STATE } from '../src/modules/keeper/copy.js';
import { recordHandover, termOf, writeTerm } from '../src/modules/keeper/promote.js';
import { ABORTED_KEEP_MS, SWITCH_MS, type Taking } from '../src/modules/keeper/switch-step.js';
import { Promoter, readTaking, Taker, TAKING_FILE, writeTaking, type OwnSubscription, type PromoterOptions } from '../src/modules/keeper/taking.js';
import { createTestSql, ownDatabases } from './helpers.js';

/* These tests write the term a database stands under, which a truncate does not undo. */
ownDatabases();

const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const C = 'c0'.repeat(16);
const TERM = { number: 5, machine: A, split: false };
const W = '0/3000000';

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-taking-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* This machine's subscription as a test sets it, with what was done to it, in order. */
function subscriptionOf() {
  const state = { enabled: true, applying: true, did: [] as string[] };
  const subscription: OwnSubscription = {
    enabled: async () => state.enabled,
    applying: async () => state.enabled && state.applying,
    disable: async () => {
      state.did.push('disable');
      state.enabled = false;
    },
    enable: async () => {
      state.did.push('enable');
      state.enabled = true;
    },
  };
  return { state, subscription };
}

async function database() {
  const { sql } = await createTestSql();
  /* No company, person or machine stands behind the rows of these tests, which the check of that is told to let pass. */
  await sql.query('SET session_replication_role = replica');
  await sql.query('DELETE FROM net_local.lease; DELETE FROM net_local.state');
  return sql;
}

/* The follow keeper's part on B, the machine the server moves to, whose link names A as the leader. */
async function taker() {
  const dir = folder();
  const sql = await database();
  const { state, subscription } = subscriptionOf();
  const said = { leader: { networkId: A, hostname: 'rack' } as { networkId: string; hostname: string } | null, ready: true, now: 1_000_000, exits: 0 };
  const lines: string[] = [];
  const it = new Taker({ dir, sql, leader: () => said.leader, copyReady: () => said.ready, subscription, exit: () => void (said.exits += 1), now: () => said.now, log: line => lines.push(line) });
  const post = async (from: string, name: string, body: object) => {
    const answer = await it.handle(from, 'POST', `/peer/switch/${name}`, body);
    answer.after?.();
    return [answer.status, answer.body];
  };
  const stateOf = async (from: string, id: string) => {
    const answer = await it.handle(from, 'GET', `/peer/switch/state?switch=${id}`, undefined);
    return [answer.status, answer.body];
  };
  return { dir, sql, it, state, said, lines, post, stateOf, taking: () => readTaking(dir) };
}

describe('the follow keeper of the machine the server moves to', () => {
  it('accepts an offer only when ready', async () => {
    const t = await taker();
    const id = randomUUID();
    const offer = { switch: id, term: TERM, deadline: 0 };
    /* Only the machine its link names as the leader offers. */
    expect(await t.post(C, 'offer', offer)).toEqual([403, { ok: false }]);
    t.said.ready = false;
    expect(await t.post(A, 'offer', offer)).toEqual([409, { ok: false, why: 'not_ready' }]);
    t.said.ready = true;
    t.state.enabled = false;
    expect(await t.post(A, 'offer', offer)).toEqual([409, { ok: false, why: 'not_ready' }]);
    t.state.enabled = true;
    expect(t.taking()).toBeNull();

    expect(await t.post(A, 'offer', offer)).toEqual([200, { ok: true }]);
    /* The deadline is counted on this machine's own clock, from the moment the offer came. */
    const written: Taking = { switch: id, from: { networkId: A, hostname: 'rack' }, term: TERM, at: 1_000_000, deadline: 1_000_000 + SWITCH_MS, phase: 'offered', w: null, copies: null, slots: null, why: null };
    expect(t.taking()).toEqual(written);
    /* The same offer again changes nothing; another one does not take its place. */
    t.said.now += 5000;
    expect(await t.post(A, 'offer', offer)).toEqual([200, { ok: true }]);
    expect(t.taking()).toEqual(written);
    expect(await t.post(A, 'offer', { ...offer, switch: randomUUID() })).toEqual([409, { ok: false, why: 'not_ready' }]);
    expect(await t.post(A, 'offer', { switch: 'x' })).toEqual([409, { ok: false, why: 'not_ready' }]);
    expect((await t.it.handle(A, 'GET', '/peer/switch/offer', undefined)).status).toBe(404);
    expect([t.state.did, t.said.exits]).toEqual([[], 0]);
  });

  it('takes go from the machine that offered', async () => {
    const t = await taker();
    const id = randomUUID();
    expect((await t.post(A, 'offer', { switch: id, term: TERM, deadline: 0 }))[0]).toBe(200);
    /* A fenced, and its hello says it leads no more. */
    t.said.leader = null;
    const go = { switch: id, w: W, copies: [C] };
    expect((await t.post(C, 'go', go))[0]).toBe(403);
    expect((await t.post(A, 'go', { ...go, switch: randomUUID() }))[0]).toBe(409);
    expect((await t.post(A, 'go', { ...go, w: 'somewhere' }))[0]).toBe(409);
    t.state.applying = false;
    expect((await t.post(A, 'go', go))[0]).toBe(409);
    expect([t.taking()?.phase, t.state.did, t.said.exits, t.it.going()]).toEqual(['offered', [], 0, false]);
    t.state.applying = true;

    expect(await t.post(A, 'go', go)).toEqual([200, { ok: true }]);
    expect(t.taking()).toMatchObject({ switch: id, phase: 'go', w: W, copies: [C] });
    expect([t.state.did, t.said.exits, t.it.going()]).toEqual([['disable'], 1, true]);
    expect(t.lines).toEqual(['Taking the server over from rack.']);
    /* The same go again changes nothing. */
    expect(await t.post(A, 'go', go)).toEqual([200, { ok: true }]);
    expect([t.state.did, t.said.exits]).toEqual([['disable'], 1]);
  });

  it('ends by itself when the answer to go never went out', async () => {
    const t = await taker();
    const id = randomUUID();
    await t.post(A, 'offer', { switch: id, term: TERM, deadline: 0 });
    /* The go is written down, and then its answer is lost: the stream is gone, so nothing is done after it. */
    const answer = await t.it.handle(A, 'POST', '/peer/switch/go', { switch: id, w: W, copies: [] });
    expect([answer.status, t.taking()?.phase, t.said.exits]).toEqual([200, 'go', 0]);
    /* The same word again is answered as taken, with nothing to do after it either. */
    expect((await t.it.handle(A, 'POST', '/peer/switch/go', { switch: id, w: W, copies: [] })).after).toBeUndefined();
    /* Its next look ends the keeper, once: it starts again as the one that takes the server. */
    await t.it.tick();
    await t.it.tick();
    expect([t.said.exits, t.taking()?.phase]).toEqual([1, 'go']);

    /* A go whose subscription could not be stopped is refused as a failure, and its next look stops it and ends. */
    const other = await taker();
    const second = randomUUID();
    await other.post(A, 'offer', { switch: second, term: TERM, deadline: 0 });
    const disable = other.it['opts'].subscription.disable;
    other.it['opts'].subscription.disable = async () => Promise.reject(new Error('the database does not answer'));
    await expect(other.it.handle(A, 'POST', '/peer/switch/go', { switch: second, w: W, copies: [] })).rejects.toThrow('the database does not answer');
    expect([other.taking()?.phase, other.state.enabled, other.said.exits]).toEqual(['go', true, 0]);
    await expect(other.it.tick()).rejects.toThrow('the database does not answer');
    expect(other.said.exits).toBe(0);
    other.it['opts'].subscription.disable = disable;
    await other.it.tick();
    expect([other.state.enabled, other.state.did, other.said.exits]).toEqual([false, ['disable'], 1]);
    /* An answer that did go out ends it there, and the look after it ends nothing twice. */
    const usual = await taker();
    const third = randomUUID();
    await usual.post(A, 'offer', { switch: third, term: TERM, deadline: 0 });
    await usual.post(A, 'go', { switch: third, w: W, copies: [] });
    await usual.it.tick();
    expect(usual.said.exits).toBe(1);
  });

  it('takes no go after the deadline', async () => {
    const t = await taker();
    const id = randomUUID();
    expect((await t.post(A, 'offer', { switch: id, term: TERM, deadline: 0 }))[0]).toBe(200);
    t.said.now += SWITCH_MS;
    expect((await t.post(A, 'go', { switch: id, w: W, copies: [] }))[0]).toBe(409);
    expect([t.taking()?.phase, t.state.did, t.said.exits]).toEqual(['offered', [], 0]);
  });

  it('answers its state', async () => {
    const t = await taker();
    const id = randomUUID();
    const other = randomUUID();
    expect(await t.stateOf(A, id)).toEqual([200, { state: 'none' }]);
    await t.post(A, 'offer', { switch: id, term: TERM, deadline: 0 });
    expect(await t.stateOf(A, id)).toEqual([200, { state: 'offered', switch: id }]);
    expect((await t.stateOf(C, id))[0]).toBe(403);
    expect(await t.stateOf(A, other)).toEqual([200, { state: 'none' }]);
    await t.post(A, 'go', { switch: id, w: W, copies: [] });
    expect(await t.stateOf(A, id)).toEqual([200, { state: 'go', switch: id }]);
    /* Promoted, with no handover recorded yet: still go, which the old leader cannot abort on. */
    await writeTerm(t.sql, { above: TERM.number, machine: B });
    writeTaking(t.dir, { ...t.taking()!, phase: 'promoted', slots: { [A]: 'copy_a_1' } });
    expect(await t.stateOf(A, id)).toEqual([200, { state: 'go', switch: id }]);
    const slots = { [A]: 'copy_a0a0a0a0a0a0a0a0_1' };
    await recordHandover(t.sql, { id, from: randomUUID(), term: TERM, applied: W, to: randomUUID(), at: new Date(), slots });
    const leading = [200, { state: 'leading', switch: id, term: TERM, slots }];
    expect(await t.stateOf(A, id)).toEqual(leading);
    /* With nothing written down any more, the handover answers the machine it names as the leader before. */
    rmSync(join(t.dir, TAKING_FILE));
    expect(await t.stateOf(A, id)).toEqual(leading);
    expect((await t.stateOf(C, id))[0]).toBe(403);
    expect(await t.stateOf(A, other)).toEqual([200, { state: 'none' }]);
  });

  it('ends an offer nobody followed', async () => {
    const t = await taker();
    const id = randomUUID();
    await t.post(A, 'offer', { switch: id, term: TERM, deadline: 0 });
    t.said.now += SWITCH_MS - 1;
    await t.it.tick();
    expect(t.taking()?.phase).toBe('offered');
    t.said.now += 1;
    await t.it.tick();
    expect(t.taking()).toBeNull();
    expect(await t.stateOf(A, id)).toEqual([200, { state: 'none' }]);
    expect((await t.post(A, 'go', { switch: id, w: W, copies: [] }))[0]).toBe(403);
    expect([t.state.did, t.said.exits]).toEqual([[], 0]);
  });

  it('gives the switch up on the word of the machine that offered', async () => {
    const t = await taker();
    const id = randomUUID();
    await t.post(A, 'offer', { switch: id, term: TERM, deadline: 0 });
    expect((await t.post(C, 'abort', { switch: id }))[0]).toBe(403);
    expect((await t.post(A, 'abort', { switch: randomUUID() }))[0]).toBe(409);
    await t.post(A, 'go', { switch: id, w: W, copies: [] });
    const aborted = [200, { state: 'aborted', switch: id, follow: { number: TERM.number + 1, machine: A, split: false }, why: null }];
    expect(await t.post(A, 'abort', { switch: id })).toEqual(aborted);
    /* Its subscription follows again, and a go of that switch comes too late. */
    expect([t.taking()?.phase, t.state.did, t.state.enabled]).toEqual(['aborted', ['disable', 'enable'], true]);
    expect(await t.post(A, 'abort', { switch: id })).toEqual(aborted);
    expect((await t.post(A, 'go', { switch: id, w: W, copies: [] }))[0]).toBe(409);
    /* What it wrote down goes ten minutes later, and a new offer takes its place before that. */
    t.said.now += ABORTED_KEEP_MS - 1;
    await t.it.tick();
    expect(t.taking()?.phase).toBe('aborted');
    const next = randomUUID();
    expect((await t.post(A, 'offer', { switch: next, term: TERM, deadline: 0 }))[0]).toBe(200);
    expect(t.taking()).toMatchObject({ switch: next, phase: 'offered' });
    await t.post(A, 'abort', { switch: next });
    t.said.now += ABORTED_KEEP_MS;
    await t.it.tick();
    expect(t.taking()).toBeNull();
  });
});

describe('a note of a switch that cannot be read', () => {
  it('is no word that there is no switch', async () => {
    const t = await taker();
    const id = randomUUID();
    await t.post(A, 'offer', { switch: id, term: TERM, deadline: 0 });
    await t.it.handle(A, 'POST', '/peer/switch/go', { switch: id, w: W, copies: [] });
    writeFileSync(join(t.dir, TAKING_FILE), '{');
    /* The machine that offered gets no answer, so it stays as it is and asks again; it is never told "none". */
    await expect(t.it.handle(A, 'GET', `/peer/switch/state?switch=${id}`, undefined)).rejects.toThrow(/cannot read/);
    await expect(t.it.handle(A, 'POST', '/peer/switch/abort', { switch: id })).rejects.toThrow(/cannot read/);
    expect(() => readTaking(t.dir)).toThrow(/cannot read/);
    /* Its copy's maker takes no step meanwhile, and its look ends nothing and forgets nothing. */
    expect(t.it.going()).toBe(true);
    await expect(t.it.tick()).rejects.toThrow(/cannot read/);
    expect([t.said.exits, existsSync(join(t.dir, TAKING_FILE))]).toEqual([0, true]);

    /* The keeper that takes the server over does not lead on it either: it promotes nothing and takes no lease. */
    const p = await promoter({ phase: 'go' });
    writeFileSync(join(p.dir, TAKING_FILE), 'not json');
    await p.it.look();
    await p.it.look();
    expect([p.it.leads(), p.did, p.said.exits]).toEqual([false, [], 0]);
    expect(p.lines.filter(line => line.includes('could not go on taking the server over'))).toHaveLength(1);
    await expect(p.it.handle(A, 'GET', `/peer/switch/state?switch=${p.id}`, undefined)).rejects.toThrow(/cannot read/);
  });
});

/* A keeper of B that started again after it took the go: it is taking the server over. */
async function promoter(over: Partial<Taking> = {}, more: Partial<PromoterOptions> = {}) {
  const [dir, controlDir] = [folder(), folder()];
  const sql = await database();
  const { state, subscription } = subscriptionOf();
  state.enabled = false;
  const id = randomUUID();
  const said = { registered: false, answer: null as { machine: string; nonce: string } | 'echo' | null, now: 1_000_000, exits: 0, appLeads: false };
  const did: string[] = [];
  const lines: string[] = [];
  const nonces: string[] = [];
  const taking: Taking = { switch: id, from: { networkId: A, hostname: 'rack' }, term: TERM, at: 1_000_000, deadline: 1_000_000 + SWITCH_MS, phase: 'go', w: W, copies: [C], slots: null, why: null, ...over };
  writeTaking(dir, taking);
  writeFileSync(join(controlDir, REPLICA_FILE), '{}');
  writeFileSync(join(dir, COPY_STATE), '{}');
  const slots = { [A]: 'copy_a0a0a0a0a0a0a0a0_1', [C]: 'copy_c0c0c0c0c0c0c0c0_2' };
  const it = new Promoter({
    dir, controlDir, sql, machine: { networkId: B },
    registered: async () => said.registered,
    probe: async nonce => {
      nonces.push(nonce);
      return said.answer === 'echo' ? { machine: B, nonce } : said.answer;
    },
    tunnel: { start: () => void did.push('tunnel start'), stop: async () => void did.push('tunnel stop') },
    subscription, appLeads: () => said.appLeads, exit: () => void (said.exits += 1),
    promote: async t => {
      did.push(`promote ${t.switch === id ? 'this switch' : 'another'}`);
      await writeTerm(sql, { above: t.term.number, machine: B });
      return slots;
    },
    now: () => said.now, log: line => lines.push(line),
    ...more,
  });
  /* One look after the clock moved on. */
  const look = async (ms = 250) => {
    said.now += ms;
    await it.look();
  };
  const looks = async (count: number, ms = 250) => {
    for (let n = 0; n < count; n++) await look(ms);
  };
  return { dir, controlDir, sql, it, id, state, said, did, lines, nonces, slots, look, looks, taking: () => readTaking(dir) };
}

describe('a keeper that is taking the server over', () => {
  it('registers, checks its nonce, then promotes', async () => {
    const p = await promoter();
    /* Its link's client starts once, and nothing is sent while hornhoof.org names another client. */
    await p.looks(8);
    expect([p.did, p.nonces, p.it.leads()]).toEqual([['tunnel start'], [], false]);
    /* The name is this keeper's: a nonce of its own goes through the link, once a second. */
    p.said.registered = true;
    p.said.answer = { machine: A, nonce: 'x'.repeat(22) };
    await p.looks(8);
    expect(p.nonces).toHaveLength(2);
    expect(new Set(p.nonces).size).toBe(2);
    for (const nonce of p.nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    /* The old leader's answer, an answer with another nonce, and none at all prove nothing. */
    p.said.answer = { machine: B, nonce: 'y'.repeat(22) };
    await p.looks(4);
    p.said.answer = null;
    await p.looks(4);
    expect([p.did, p.taking()?.phase, p.it.leads()]).toEqual([['tunnel start'], 'go', false]);

    p.said.answer = 'echo';
    await p.looks(5);
    expect(p.did).toEqual(['tunnel start', 'promote this switch']);
    expect(p.taking()).toMatchObject({ phase: 'promoted', slots: p.slots });
    expect([existsSync(join(p.controlDir, REPLICA_FILE)), existsSync(join(p.dir, COPY_STATE)), p.it.leads()]).toEqual([false, false, true]);
    /* Once its app leads, nothing is left written down. */
    await p.looks(4);
    expect(p.taking()?.phase).toBe('promoted');
    p.said.appLeads = true;
    await p.look();
    expect([p.taking(), p.it.leads(), p.said.exits]).toEqual([null, true, 0]);
    expect(p.lines).toEqual([`This machine leads the company now, under term ${TERM.number + 1}.`]);
    expect(p.state.did).toEqual([]);
  });

  it('looks often only while it takes the server', async () => {
    const p = await promoter({ phase: 'go' });
    await p.it.look();
    expect([p.it.leads(), p.it.pace()]).toEqual([false, 250]);
    /* With nothing written down it leads as any keeper, and has little to look at. */
    rmSync(join(p.dir, TAKING_FILE));
    await p.it.look();
    expect([p.it.leads(), p.it.pace()]).toEqual([true, 1000]);
  });

  it('gives the server back when the name does not come', async () => {
    const p = await promoter();
    await p.looks(4);
    p.said.now = 1_000_000 + SWITCH_MS - 250;
    await p.look();
    expect([p.did, p.said.exits, p.state.did]).toEqual([['tunnel start', 'tunnel stop'], 1, ['enable']]);
    expect(p.taking()).toMatchObject({ phase: 'aborted', why: 'no_link' });
    expect(p.lines).toEqual(["Gave the server back to rack: hornhoof.org did not give this machine the company's name in time."]);
    expect(await termOf(p.sql)).toBeNull();
    /* The old leader learns it, and under which term it leads again. */
    const answer = await p.it.handle(A, 'GET', `/peer/switch/state?switch=${p.id}`, undefined);
    expect([answer.status, answer.body]).toEqual([200, { state: 'aborted', switch: p.id, follow: { number: TERM.number + 1, machine: A, split: false }, why: 'no_link' }]);
  });

  it('goes on after a restart in each phase', async () => {
    /* The term was written before the restart: it promotes, also past the deadline, and never gives the server back. */
    const written = await promoter();
    await writeTerm(written.sql, { above: TERM.number, machine: B });
    written.said.now += 10 * SWITCH_MS;
    await written.look();
    expect([written.did, written.taking()?.phase, written.said.exits]).toEqual([['tunnel start', 'promote this switch'], 'promoted', 0]);
    const refused = await written.it.handle(A, 'POST', '/peer/switch/abort', { switch: written.id });
    expect([refused.status, refused.body, written.taking()?.phase]).toEqual([409, { state: 'go', switch: written.id }, 'promoted']);

    const promoted = await promoter({ phase: 'promoted', slots: {} });
    await promoted.look();
    expect([promoted.it.leads(), promoted.did]).toEqual([true, ['tunnel start']]);

    const aborted = await promoter({ phase: 'aborted', at: 1_000_000 });
    aborted.said.now += ABORTED_KEEP_MS - 500;
    await aborted.look();
    expect(aborted.taking()?.phase).toBe('aborted');
    await aborted.look(60_000);
    expect([aborted.taking(), aborted.did]).toEqual([null, []]);
  });

  it('gives the server back when the machine that offered calls the move off', async () => {
    const p = await promoter();
    p.said.registered = true;
    await p.look();
    expect((await p.it.handle(C, 'POST', '/peer/switch/abort', { switch: p.id })).status).toBe(403);
    expect((await p.it.handle(A, 'POST', '/peer/switch/abort', { switch: randomUUID() })).status).toBe(409);
    /* The go this keeper started on, sent again, changes nothing. */
    expect((await p.it.handle(A, 'POST', '/peer/switch/go', { switch: p.id, w: W, copies: [C] })).status).toBe(200);
    const answer = await p.it.handle(A, 'POST', '/peer/switch/abort', { switch: p.id });
    expect([answer.status, answer.body]).toEqual([200, { state: 'aborted', switch: p.id, follow: { number: TERM.number + 1, machine: A, split: false }, why: null }]);
    answer.after?.();
    expect([p.did, p.state.did, p.said.exits, p.taking()?.phase]).toEqual([['tunnel start', 'tunnel stop'], ['enable'], 1, 'aborted']);
    expect(p.lines).toEqual(['Gave the server back to rack: that machine called the move off.']);
  });
});
