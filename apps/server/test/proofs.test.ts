import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Term } from '../src/db/net.js';
import type { Beat, Heard } from '../src/modules/keeper/beats.js';
import { Keeper } from '../src/modules/keeper/keeper.js';
import type { Clocks } from '../src/modules/keeper/lease.js';
import { LeaseProofs, othersFinished } from '../src/modules/keeper/proofs.js';
import { fakeLease } from './fake-lease.js';
import { createTestSql, ownDatabases, TEST_SECRET } from './helpers.js';

/* One test writes machines and handovers with nothing behind them, which a truncate does not undo. */
ownDatabases();

const A = 'a0'.repeat(16);
const B = 'b0'.repeat(16);
const C = 'c0'.repeat(16);
const TERM: Term = { number: 7, machine: A, split: false };
const clocks = (mono: number): Clocks => ({ wall: 1_000_000 + mono, mono });

/* The leading keeper A, with a link whose answer the test sets, the beats it heard, and a clock the test moves. */
function proofs() {
  const said = { now: 1000, link: 'self' as 'self' | 'other' | 'stale' | 'silent' | 'throws', term: TERM as Term | null, b: B as string | null };
  const answers = new Map<string, Heard>();
  const lasts = new Map<string, Heard>();
  const nonces: string[] = [];
  const it = new LeaseProofs({
    probe: async nonce => {
      nonces.push(nonce);
      if (said.link === 'throws') throw new Error('no route');
      if (said.link === 'silent') return null;
      return { machine: said.link === 'other' ? B : A, nonce: said.link === 'stale' ? 'n'.repeat(22) : nonce };
    },
    beats: { answer: id => answers.get(id) ?? null, all: () => lasts },
    self: A, term: () => said.term, b: () => said.b, now: () => clocks(said.now),
  });
  const beat = (machine: string, stance: Beat['stance'], host = 'mac'): Beat => ({ machine, host, stance, number: 2, reach: null, ready: true, full: false });
  /* The copy's answer to a beat this keeper sent at that moment. */
  const answer = (machine: string, stance: Beat['stance'], sentAt: number) => {
    const heard = { beat: beat(machine, stance), at: sentAt + 50, sent: clocks(sentAt) };
    answers.set(machine, heard);
    lasts.set(machine, heard);
  };
  const hears = (machine: string, stance: Beat['stance'], host?: string) => void lasts.set(machine, { beat: beat(machine, stance, host), at: said.now, sent: null });
  return { it, said, nonces, answer, hears };
}

describe('the proofs a leader keeps its lease by', () => {
  it('proves by the link', async () => {
    const p = proofs();
    expect([p.it.proof(), p.it.ended()]).toEqual([null, null]);
    await p.it.tick();
    /* This machine answered its own nonce: the name led here when the question went out. */
    expect(p.it.proof()).toEqual(clocks(1000));
    expect(p.nonces[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    /* Each question has a nonce of its own, and the newest answer counts. */
    p.said.now = 2000;
    await p.it.tick();
    expect([p.it.proof(), new Set(p.nonces).size]).toEqual([clocks(2000), 2]);
    /* An answer with another nonce, none at all, and a question that failed prove nothing. */
    for (const link of ['stale', 'silent', 'throws'] as const) {
      p.said.link = link;
      p.said.now += 1000;
      await p.it.tick();
      expect([link, p.it.proof(), p.it.ended()]).toEqual([link, clocks(2000), null]);
    }
  });

  it('proves by B', () => {
    const p = proofs();
    p.answer(B, { kind: 'follow', term: TERM }, 900);
    expect(p.it.proof()).toEqual(clocks(900));
    /* The same from a copy the relay's record does not name proves nothing. */
    p.said.b = C;
    expect(p.it.proof()).toBeNull();
    p.answer(C, { kind: 'follow', term: TERM }, 950);
    expect(p.it.proof()).toEqual(clocks(950));
    p.said.b = null;
    expect(p.it.proof()).toBeNull();
    /* Following an older term, or none, or attempting, it vouches for nothing. */
    p.said.b = B;
    for (const stance of [{ kind: 'follow', term: { ...TERM, number: 6 } }, { kind: 'follow', term: null }, { kind: 'attempting' }] as Beat['stance'][]) {
      p.answer(B, stance, 1000);
      expect(p.it.proof(), JSON.stringify(stance)).toBeNull();
    }
    /* With no lease there is no term to vouch for. */
    p.answer(B, { kind: 'follow', term: TERM }, 1100);
    p.said.term = null;
    expect(p.it.proof()).toBeNull();
  });

  it('takes the newer of the two', async () => {
    const p = proofs();
    p.answer(B, { kind: 'follow', term: TERM }, 1500);
    await p.it.tick();
    expect(p.it.proof()).toEqual(clocks(1500));
    p.said.now = 2000;
    await p.it.tick();
    expect(p.it.proof()).toEqual(clocks(2000));
  });

  it('ends when another machine answers at the link', async () => {
    const p = proofs();
    await p.it.tick();
    p.said.link = 'other';
    p.said.now = 2000;
    await p.it.tick();
    expect(p.it.ended()).toBe('another machine answers at the link');
    /* The keeper forgets both at each take. */
    p.it.clear();
    expect([p.it.ended(), p.it.proof()]).toEqual([null, null]);
  });

  it('ends when a beat says lead under a higher term', () => {
    const p = proofs();
    p.hears(B, { kind: 'lead', term: { number: 8, machine: B, split: false }, lease: 'normal', sync: null, until: 0 }, 'studio');
    expect(p.it.ended()).toBe('studio leads under term 8');
    /* A term that is not above its own ends nothing, nor does a machine that only follows or would lead. */
    const quiet: Beat['stance'][] = [
      { kind: 'lead', term: { number: 7, machine: A, split: false }, lease: 'normal', sync: null, until: 0 }, { kind: 'lead', term: { number: 6, machine: B, split: false }, lease: 'normal', sync: null, until: 0 },
      { kind: 'follow', term: { number: 9, machine: B, split: false } }, { kind: 'idle', term: { number: 9, machine: B, split: false } }, { kind: 'attempting' },
    ];
    for (const stance of quiet) {
      p.hears(B, stance);
      expect(p.it.ended(), JSON.stringify(stance)).toBeNull();
    }
    /* At the same number the machine decides. */
    p.hears(C, { kind: 'lead', term: { number: 7, machine: C, split: false }, lease: 'normal', sync: null, until: 0 }, '');
    expect(p.it.ended()).toBe('another machine leads under term 7');
  });
});

describe('whether a lease takes a proof', () => {
  it('needs one once another machine holds a copy that finished, or led before', async () => {
    const { sql } = await createTestSql();
    await sql.query('SET session_replication_role = replica');
    const company = '0f0f0f0f-0000-4000-8000-00000000000c';
    const person = '0f0f0f0f-0000-4000-8000-00000000000d';
    const row = async (id: string, networkId: string | null, more: { role?: string | null; copy?: string | null; revoked?: boolean } = {}) =>
      sql.query(
        `INSERT INTO machines (id, company_id, person_id, machine_key, hostname, role, network_id, copy_state, revoked_at)
         VALUES ($1, $2, $3, $4, 'm', $5, $6, $7, ${more.revoked ? 'now()' : 'NULL'})
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, copy_state = EXCLUDED.copy_state, revoked_at = EXCLUDED.revoked_at`,
        [id, company, person, `key-${id}`, more.role === undefined ? 'data' : more.role, networkId, more.copy ?? null],
      );
    const [own, other] = ['0f0f0f0f-0000-4000-8000-0000000000a1', '0f0f0f0f-0000-4000-8000-0000000000b1'];
    await row(own, A, { copy: 'ready' });
    /* Alone, its own row counts for nothing. */
    expect(await othersFinished(sql, A)).toBe(false);
    /* A copy still being made needs none; one that finished once does, whatever became of it since. */
    for (const [copy, needed] of [[null, false], ['making', false], ['ready', true], ['remaking', true], ['stopped', true], ['saving', true]] as const) {
      await row(other, B, { copy });
      expect([copy, await othersFinished(sql, A)]).toEqual([copy, needed]);
    }
    /* A machine that holds no data, or was disconnected, counts for nothing. */
    await row(other, B, { copy: 'ready', role: 'worker' });
    expect(await othersFinished(sql, A)).toBe(false);
    await row(other, B, { copy: 'ready', revoked: true });
    expect(await othersFinished(sql, A)).toBe(false);
    /* The machine the newest handover names as the leader before holds a database that led. */
    await row(other, B, { copy: null });
    await sql.query(`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, kind) VALUES (gen_random_uuid(), $1, 7, $2, '0/1', $3, now(), 'takeover')`, [other, B, own]);
    expect(await othersFinished(sql, A)).toBe(true);
    /* Only the newest one counts. */
    const older = sql;
    await sql.query(`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at) VALUES (gen_random_uuid(), $1, 8, $2, '0/2', $3, now() + interval '1 minute')`, [own, A, other]);
    expect(await othersFinished(sql, A)).toBe(false);
    /* A database of the build before the network knows no copies and no handovers: there a lease takes no proof. */
    await row(other, B, { copy: 'ready' });
    expect(await othersFinished(older, A)).toBe(true);
    await older.query('ALTER TABLE net.handovers RENAME TO handovers_of_later');
    expect(await othersFinished(older, A)).toBe(false);
    await older.query('ALTER TABLE net.handovers_of_later RENAME TO handovers');
    await older.query('ALTER TABLE machines RENAME COLUMN copy_state TO copy_state_of_later');
    expect(await othersFinished(older, A)).toBe(false);
  });
});

async function slowLinkStand(opts: { probeMs: number; linkEveryMs?: number; renew?: () => boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-proofs-keeper-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-proofs-ctrl-'));
  const app = http.createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const appPort = (app.address() as AddressInfo).port;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  vi.setSystemTime(new Date('2026-11-14T01:14:00.000Z'));
  const state = { needed: false, link: 'self' as 'self' | 'silent' };
  const lines: string[] = [];
  const lease = fakeLease({ renew: async () => (opts.renew ? opts.renew() : true) });
  const keeper = new Keeper({
    config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_CONTROL_DIR: controlDir, HORNHOOF_MACHINE_ID: A, ACME_DIRECTORY: 'off' }),
    db: null,
    lease,
    app: { host: '127.0.0.1', port: appPort },
    frontHost: null,
    log: line => lines.push(line),
    host: '127.0.0.1',
    ports: { front: 0, linkHttp: 0, linkTls: 0 },
    dir,
    everyMs: 1000,
    linkEveryMs: opts.linkEveryMs ?? 3000,
    reportEveryMs: 3_600_000,
    backupsEveryMs: 3_600_000,
    backupKeysRetryMs: 3_600_000,
    computer: { openEveryMs: 3_600_000, closedEveryMs: 3_600_000 },
    throughput: { start: () => undefined, stop: () => undefined, best: () => ({}) },
    proofs: {
      needed: async () => state.needed,
      probe: nonce => new Promise(resolve => setTimeout(() => resolve(state.link === 'silent' ? null : { machine: A, nonce }), opts.probeMs)),
      ownTerm: async () => null,
      poll: async () => ({
        sent: { wall: Date.now(), mono: performance.now() },
        replied: performance.now(),
        route: { known: true, state: 'held', client: `acme-${A.slice(0, 8)}-link`, generation: 1, since: 0, relayStarted: 100, evictionBound: 30, sync: { state: 'off', copy: null, epoch: 1, generation: 1, at: null } },
        health: { up: true, relayStarted: 100 },
      }),
      follow: async () => undefined,
    },
  });
  await keeper.start();
  onTestFinished(async () => {
    vi.useRealTimers();
    await keeper.stop();
    await new Promise<void>(resolve => app.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  });
  return { keeper, lease, lines, state };
}

describe('keeping the lease when the first copy finishes on a slow link', () => {
  it('keeps leading without dropping to read when the first copy finishes near lease end and the link probe takes 1 s', async () => {
    let canRenew = true;
    const { keeper, lease, lines, state } = await slowLinkStand({ probeMs: 1000, linkEveryMs: 500, renew: () => canRenew });
    expect([keeper.mode(), keeper.term()?.number, keeper.linkWanted()]).toEqual(['lead', 1, true]);

    /* Renewals did not commit for 8 s while the machine still led alone, leaving 1.5 s on the standing lease. */
    canRenew = false;
    await vi.advanceTimersByTimeAsync(8000);
    expect([keeper.mode(), keeper.term()?.number]).toEqual(['lead', 1]);

    /* The first copy finishes while each link probe takes 1 s to answer. */
    canRenew = true;
    state.needed = true;
    for (let step = 0; step < 40; step++) {
      await vi.advanceTimersByTimeAsync(500);
      expect([step, keeper.mode(), keeper.term()?.number, keeper.linkWanted()]).toEqual([step, 'lead', 1, true]);
    }
    expect(lines.some(line => line.includes('Another machine holds a copy of the data'))).toBe(true);
    expect(lease.calls.filter(call => call.method === 'fence')).toEqual([]);
  });

  it('keeps leading without dropping to read when the first copy finishes while the link probe takes 3 s', async () => {
    const { keeper, lease, lines, state } = await slowLinkStand({ probeMs: 3000 });
    expect([keeper.mode(), keeper.term()?.number, keeper.linkWanted()]).toEqual(['lead', 1, true]);

    await vi.advanceTimersByTimeAsync(2500);
    state.needed = true;
    for (let step = 0; step < 50; step++) {
      await vi.advanceTimersByTimeAsync(500);
      expect([step, keeper.mode(), keeper.term()?.number, keeper.linkWanted()]).toEqual([step, 'lead', 1, true]);
    }
    expect(lines.some(line => line.includes('Another machine holds a copy of the data'))).toBe(true);
    expect(lease.calls.filter(call => call.method === 'fence')).toEqual([]);
  });
});
