import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql as raw } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { companies, machines, peerSecrets, people, publicLinks } from '../src/db/schema.js';
import { REPLICA_FILE } from '../src/modules/keeper/become.js';
import { COPY_STATE } from '../src/modules/keeper/copy.js';
import { Hander, HANDING_FILE, readHanding, writeHanding, type HanderOptions } from '../src/modules/keeper/handing.js';
import { BEHIND_MS, MOVE_WAIT_MS, OTHERS_WAIT_MS, SWITCH_MS, type Handing, type TakeState } from '../src/modules/keeper/switch-step.js';
import { PEERS_FILE } from '../src/modules/keeper/worker.js';
import type { SyncRecord } from '../src/modules/link/relay.js';
import { createTestSql, ownDatabases, TEST_SECRET } from './helpers.js';

/* These tests write the term a database stands under, which a truncate does not undo. */
ownDatabases();

const A = 'a0'.repeat(16);
const C = 'c0'.repeat(16);
const D = 'd0'.repeat(16);
const W = '0/3000000';
const TERM = { number: 5, machine: A, split: false };
const D_SLOT = 'copy_d0d0d0d0d0d0d0d0_2';
const C_SLOT = 'copy_c0c0c0c0c0c0c0c0_1';
const START = 1_000_000;

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-handing-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* The keeper of A, which leads, with the copies C (2) and D (3), and the CEO's request to move the server to D. */
async function hander(over: { request?: boolean; handing?: Partial<Handing>; link?: boolean } = {}) {
  const [dir, controlDir] = [folder(), folder()];
  const { db, sql } = await createTestSql();
  const [acme] = await db.insert(companies).values({ name: 'Acme' }).returning();
  const [ivan] = await db.insert(people).values({ companyId: acme!.id, name: 'Ivan', email: 'ivan@acme.test', status: 'active', scopeKind: 'company', isOwner: true }).returning();
  const row = async (hostname: string, more: Partial<typeof machines.$inferInsert>) =>
    (await db.insert(machines).values({ companyId: acme!.id, personId: ivan!.id, machineKey: `key-${hostname}`, hostname, role: 'data', ...more }).returning())[0]!;
  const a = await row('rack', { networkId: A, serverOrder: 1 });
  const c = await row('laptop', { networkId: C, serverOrder: 2, copyName: C_SLOT, copyState: 'ready' });
  const d = await row('studio', { networkId: D, serverOrder: 3, copyName: D_SLOT, copyState: 'ready' });
  /* The company's link, with the secrets machines reach each other by, as the app keeps them. */
  const secret = Buffer.from(TEST_SECRET, 'base64');
  if (over.link !== false) {
    await db.insert(publicLinks).values({ companyId: acme!.id, name: 'acme', url: 'https://acme.hornhoof.test', keyEnc: encryptSecret('the link key', secret), tunnelEnc: encryptSecret(JSON.stringify({ serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' }), secret) });
    await db.insert(peerSecrets).values([
      { kind: 'app', secretEnc: encryptSecret('app secret', secret) },
      { kind: 'data', secretEnc: encryptSecret('data secret', secret) },
      { kind: 'visit', secretEnc: encryptSecret(JSON.stringify({ name: 'acme', key: 'visitor key' }), secret) },
    ]);
  }
  const moves = async () => (await db.execute(raw`SELECT request::text, state, reason, ended_at FROM net.move`) as unknown as { rows: { request: string; state: string; reason: string | null; ended_at: unknown }[] }).rows;
  const ask = async (machine: string, at = 'clock_timestamp()') => {
    await db.execute(raw`DELETE FROM net.move`);
    await db.execute(raw`INSERT INTO net.move (machine_id, from_machine_id, asked_by, asked_at, state) VALUES (${machine}, ${a.id}, ${ivan!.id}, ${raw.raw(at)}, 'preparing')`);
    return (await moves())[0]!.request;
  };
  const request = over.request === false ? null : await ask(d.id);

  /* What the keeper sees, as a test sets it, and what it did, in order. */
  const said = {
    now: START, leads: true, updating: false, named: D as string | null, generation: 7 as number | null,
    record: { state: 'on', copy: D, epoch: 3, generation: 7, at: 100 } as SyncRecord | null,
    copies: [{ name: C_SLOT, networkId: C, state: 'pace' as const }, { name: D_SLOT, networkId: D, state: 'sync' as const }],
    slots: [{ name: C_SLOT, read: true, atW: true }, { name: D_SLOT, read: true, atW: true }],
    offer: { status: 200, body: { ok: true } } as { status: number; body: unknown } | null,
    state: null as TakeState | null,
  };
  const did: string[] = [];
  const sent: unknown[] = [];
  const lines: string[] = [];
  const opts: HanderOptions = {
    dir, controlDir, sql, secret,
    lease: { fence: async () => void did.push('fence') },
    term: () => (said.leads ? TERM : null),
    sync: { named: () => said.named, record: () => said.record, generation: () => said.generation, copies: () => said.copies },
    peer: networkId => ({
      request: async (method, path, body) => {
        /* The switch's id is the request's, checked where a test looks at what was written down; a deadline is kept as
           how far ahead it lies. */
        const told = body as { deadline?: number } | undefined;
        sent.push([networkId, method, path.replace(/=[0-9a-f-]{36}$/, '=<switch>'), told === undefined ? undefined : { ...told, switch: '<switch>', ...(told.deadline === undefined ? {} : { deadline: told.deadline - said.now }) }]);
        if (path.endsWith('/offer')) return said.offer;
        if (path.includes('/state')) return said.state ? { status: 200, body: said.state } : null;
        return { status: 200, body: { ok: true } };
      },
    }),
    front: { close: async () => void did.push('front close'), open: () => void did.push('front open') },
    tunnel: { start: () => void did.push('tunnel start'), stop: async () => void did.push('tunnel stop') },
    leads: () => said.leads, updating: () => said.updating, machine: { networkId: A },
    exit: () => void did.push('exit'),
    wal: { position: async () => W, slots: async () => said.slots },
    now: () => said.now, log: line => lines.push(line),
  };
  if (over.handing) {
    writeHanding(dir, {
      switch: request ?? randomUUID(), to: { machine: d.id, networkId: D, hostname: 'studio' }, term: TERM, at: START, deadline: START + SWITCH_MS,
      phase: 'offered', fenced: false, w: null, copies: null, slot: null, reason: null, ...over.handing,
    });
  }
  const it = new Hander(opts);
  /* One look after the clock moved on. */
  const look = async (ms = 250) => {
    said.now += ms;
    await it.look();
  };
  const looks = async (count: number, ms = 250) => {
    for (let n = 0; n < count; n++) await look(ms);
  };
  return { dir, controlDir, db, sql, it, a, c, d, request, said, did, sent, lines, look, looks, moves, ask, handing: () => readHanding(dir) };
}

const OFFER = [D, 'POST', '/peer/switch/offer', { switch: '<switch>', term: TERM, deadline: SWITCH_MS }];
const leading = (id: string): TakeState => ({ state: 'leading', switch: id, term: { number: 6, machine: D, split: false }, slots: { [A]: 'copy_a0a0a0a0a0a0a0a0_1', [C]: 'copy_c0c0c0c0c0c0c0c0_2' } });

describe('the keeper that hands the server over', () => {
  it('hands over when the target keeps pace', async () => {
    const h = await hander();
    /* While the target is not the copy commits wait for, at the relay too, nothing is offered. */
    h.said.named = C;
    await h.looks(2);
    h.said.named = D;
    h.said.record = { ...h.said.record!, copy: C };
    await h.looks(2);
    h.said.record = { ...h.said.record, copy: D };
    h.said.updating = true;
    await h.looks(2);
    expect([h.sent, h.handing(), h.it.holds()]).toEqual([[], null, false]);
    h.said.updating = false;

    /* One offer, with the request claimed first. */
    await h.look();
    expect(h.sent).toEqual([OFFER]);
    expect(await h.moves()).toMatchObject([{ request: h.request, state: 'switching' }]);
    expect(h.handing()).toMatchObject({ switch: h.request, to: { machine: h.d.id, networkId: D, hostname: 'studio' }, term: TERM, phase: 'offered', fenced: false });
    expect([h.it.holds(), h.lines]).toEqual([false, ['Handing the server over to studio.']]);
    /* Accepted: the front door closes and the lease is fenced, in that order, and from then on it leads no more. */
    await h.look();
    expect(h.did).toEqual(['front close', 'fence']);
    expect(h.handing()).toMatchObject({ phase: 'stopped', fenced: true });
    expect(h.it.holds()).toBe(true);
    h.said.leads = false;
    await h.look();
    expect(h.handing()).toMatchObject({ phase: 'stopped', w: W });
    /* The target's slot and the other copy's both hold W: go, with that copy, and the link's client stops. */
    await h.look();
    expect(h.handing()).toMatchObject({ phase: 'go', copies: [C] });
    expect(h.sent.at(-1)).toEqual([D, 'POST', '/peer/switch/go', { switch: '<switch>', w: W, copies: [C] }]);
    expect(h.did).toEqual(['front close', 'fence', 'tunnel stop']);
    /* It asks until the target says it leads, and then follows it. */
    await h.look();
    expect(h.sent.at(-1)).toEqual([D, 'GET', '/peer/switch/state?switch=<switch>', undefined]);
    h.said.state = leading(h.request!);
    await h.looks(2);
    await h.look();
    expect(h.did).toEqual(['front close', 'fence', 'tunnel stop', 'exit']);
    expect(h.handing()).toBeNull();
    const [state] = (await h.sql.query<{ to: string; lsn: string; at: unknown }>('SELECT handed_to AS "to", handed_lsn AS lsn, handed_at AS at FROM net_local.state')).rows;
    expect([state!.to, state!.lsn, state!.at === null]).toEqual([D, W, false]);
    /* What its keeper starts on as one that follows: the view of the network, the slot to join, and the marker. */
    const view = JSON.parse(readFileSync(join(h.dir, PEERS_FILE), 'utf8')) as { machine: string; data: { networkId: string }[]; link: { url: string; visitorKey: string } };
    expect([view.machine, view.data.map(row => row.networkId).sort(), view.link.url, view.link.visitorKey]).toEqual([h.a.id, [C, D], 'https://acme.hornhoof.test', 'visitor key']);
    expect(JSON.parse(readFileSync(join(h.dir, COPY_STATE), 'utf8'))).toEqual({ attempt: 1, database: 'hornhoof', phase: 'join', slot: 'copy_a0a0a0a0a0a0a0a0_1', leader: D });
    expect(statSync(join(h.dir, PEERS_FILE)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(h.controlDir, REPLICA_FILE))).toBe(true);
    expect(h.lines).toEqual(['Handing the server over to studio.', 'studio leads now; this machine keeps a copy.']);
    expect(await h.moves()).toMatchObject([{ state: 'switching' }]);
  });

  it('gives no slot to a copy that missed W, or that still makes its copy', async () => {
    const h = await hander();
    h.said.slots = [{ name: C_SLOT, read: true, atW: false }, { name: D_SLOT, read: true, atW: true }];
    await h.looks(4);
    expect(h.handing()).toMatchObject({ phase: 'stopped', w: W });
    /* The other copy is waited for, for a while. */
    await h.looks(3, 1000);
    expect(h.handing()?.phase).toBe('stopped');
    h.said.now += OTHERS_WAIT_MS;
    await h.it.look();
    expect(h.handing()).toMatchObject({ phase: 'go', copies: [] });

    const making = await hander();
    await making.db.update(machines).set({ copyState: 'making' });
    await making.looks(4);
    expect(making.handing()).toMatchObject({ phase: 'go', copies: [] });
    /* A copy nobody reads now is not waited for. */
    const away = await hander();
    away.said.slots = [{ name: C_SLOT, read: false, atW: false }, { name: D_SLOT, read: true, atW: true }];
    await away.looks(4);
    expect(away.handing()).toMatchObject({ phase: 'go', copies: [] });
  });

  it('aborts alone before go', async () => {
    const h = await hander();
    h.said.offer = { status: 409, body: { ok: false, why: 'not_ready' } };
    await h.looks(2);
    expect(h.sent.at(-1)).toEqual([D, 'POST', '/peer/switch/abort', { switch: '<switch>' }]);
    expect(h.handing()).toMatchObject({ phase: 'aborted', reason: 'not_ready' });
    expect([h.did, h.it.holds()]).toEqual([['front open', 'tunnel start'], false]);
    expect(h.lines.at(-1)).toBe('The server stays here: studio was not ready to take it.');
    /* Leading again, it says of the request why it did not move. */
    await h.look();
    expect([h.handing(), await h.moves()]).toEqual([null, [expect.objectContaining({ request: h.request, state: 'failed', reason: 'not_ready' })]]);
    expect((await h.moves())[0]!.ended_at).not.toBeNull();
    /* Nothing more comes of it. */
    await h.looks(4);
    expect(h.sent).toHaveLength(2);

    /* A target that does not hold W ten seconds before the deadline: the same, with behind. */
    const late = await hander();
    late.said.slots = [{ name: D_SLOT, read: true, atW: false }];
    await late.looks(3);
    expect(late.handing()).toMatchObject({ phase: 'stopped', fenced: true, w: W });
    late.said.leads = false;
    late.said.now = START + 250 + SWITCH_MS - BEHIND_MS;
    await late.it.look();
    expect(late.handing()).toMatchObject({ phase: 'aborted', reason: 'behind' });
    expect(late.did).toEqual(['front close', 'fence', 'front open', 'tunnel start']);
    expect(late.it.keepsPeerTunnel()).toBe(false);
    /* Not before it leads again is the request marked. */
    await late.looks(2);
    expect(await late.moves()).toMatchObject([{ state: 'switching' }]);
    late.said.leads = true;
    await late.look();
    expect([late.handing(), await late.moves()]).toEqual([null, [expect.objectContaining({ state: 'failed', reason: 'behind' })]]);

    /* A target that says nothing to the offer: no_answer. */
    const silent = await hander();
    silent.said.offer = null;
    await silent.looks(2);
    expect(silent.handing()).toMatchObject({ phase: 'aborted', reason: 'no_answer' });
  });

  it("never leads again after go without the target's word", async () => {
    const h = await hander();
    await h.looks(4);
    h.said.leads = false;
    expect(h.handing()?.phase).toBe('go');
    expect(h.it.keepsPeerTunnel()).toBe(true);
    const before = h.did.length;
    /* Five minutes of silence: it holds, asks, and says so once a minute. */
    await h.looks(300, 1000);
    expect([h.it.holds(), h.did.slice(before), h.handing()?.phase]).toEqual([true, [], 'go']);
    expect(h.it.keepsPeerTunnel()).toBe(false);
    expect(h.lines.filter(line => line === 'Waiting for studio to say whether it took the server.')).toHaveLength(5);
    /* An offer the target still holds, past the deadline: the go goes again, and it asks on. */
    h.said.state = { state: 'offered', switch: h.request! };
    const gone = h.sent.length;
    /* A look that asks, then one that sends, and so on. */
    await h.looks(4, 1000);
    expect(h.sent.slice(gone).filter(one => (one as string[])[2] === '/peer/switch/go')).toHaveLength(2);
    expect(h.handing()?.phase).toBe('go');
    /* The target gave the server back. */
    h.said.state = { state: 'aborted', switch: h.request!, follow: { number: 6, machine: A, split: false }, why: 'no_link' };
    await h.looks(2, 1000);
    expect(h.handing()).toMatchObject({ phase: 'aborted', reason: 'no_link' });
    expect([h.did.slice(before), h.it.holds()]).toEqual([['front open', 'tunnel start'], false]);
    h.said.leads = true;
    await h.look();
    expect(await h.moves()).toMatchObject([{ state: 'failed', reason: 'no_link' }]);

    /* A target that knows nothing of the switch never took the go. */
    const none = await hander();
    await none.looks(4);
    none.said.leads = false;
    none.said.state = { state: 'none' };
    await none.looks(2, 1000);
    expect(none.handing()).toMatchObject({ phase: 'aborted', reason: 'no_answer' });
    /* An answer about another switch is no answer. */
    const other = await hander();
    await other.looks(4);
    other.said.state = leading(randomUUID());
    await other.looks(3, 1000);
    expect([other.handing()?.phase, other.did.includes('exit')]).toEqual(['go', false]);
  });

  it('goes on after a restart in each phase', async () => {
    /* Offered, with nobody waiting for the answer any more. */
    const offered = await hander({ handing: {} });
    await offered.look();
    expect(offered.handing()).toMatchObject({ phase: 'aborted', reason: 'no_answer' });
    /* Stopped, and not known to be fenced: the door and the fence again, before W is read. */
    const stopped = await hander({ handing: { phase: 'stopped' } });
    expect(stopped.it.holds()).toBe(true);
    await stopped.look();
    expect([stopped.did, stopped.handing()]).toEqual([['front close', 'fence'], expect.objectContaining({ fenced: true, w: null })]);
    const fenced = await hander({ handing: { phase: 'stopped', fenced: true } });
    await fenced.looks(2);
    expect([fenced.did, fenced.handing()]).toEqual([['tunnel stop'], expect.objectContaining({ phase: 'go', w: W })]);
    /* Go: it asks, and sends the same go again to a target that still holds the offer. */
    const gone = await hander({ handing: { phase: 'go', fenced: true, w: W, copies: [C] } });
    await gone.look();
    expect(gone.sent).toEqual([[D, 'GET', '/peer/switch/state?switch=<switch>', undefined]]);
    gone.said.state = { state: 'offered', switch: gone.request! };
    await gone.looks(2, 1000);
    expect(gone.sent).toContainEqual([D, 'POST', '/peer/switch/go', { switch: '<switch>', w: W, copies: [C] }]);
    /* Followed: it finishes following. */
    const followed = await hander({ handing: { phase: 'followed', fenced: true, w: W, copies: [], slot: 'copy_a0a0a0a0a0a0a0a0_4' } });
    await followed.look();
    expect([followed.did, followed.handing()]).toEqual([['exit'], null]);
    expect(JSON.parse(readFileSync(join(followed.dir, COPY_STATE), 'utf8'))).toMatchObject({ attempt: 4, phase: 'join', slot: 'copy_a0a0a0a0a0a0a0a0_4', leader: D });
  });

  it('holds while it cannot read what it wrote down', async () => {
    /* It gave the go, and the note of that cannot be read: it does not know that the server is still its own. */
    const h = await hander({ handing: { phase: 'go', fenced: true, w: W, copies: [] } });
    expect(h.it.holds()).toBe(true);
    expect(h.it.keepsPeerTunnel()).toBe(true);
    writeFileSync(join(h.dir, HANDING_FILE), '{');
    await h.looks(3);
    expect([h.it.holds(), h.did]).toEqual([true, []]);
    expect(h.it.keepsPeerTunnel()).toBe(false);
    expect(() => readHanding(h.dir)).toThrow(/cannot read/);
    expect(h.lines.filter(line => line.includes('cannot read'))).toHaveLength(1);
    /* A keeper that starts over such a note holds from its start. */
    const again = new Hander({ ...h.it['opts'] });
    expect(again.holds()).toBe(true);
    /* Readable again, it goes on from what it says. */
    writeHanding(h.dir, { switch: h.request!, to: { machine: h.d.id, networkId: D, hostname: 'studio' }, term: TERM, at: START, deadline: START + SWITCH_MS, phase: 'go', fenced: true, w: W, copies: [], slot: null, reason: null });
    await h.look();
    expect(h.it.holds()).toBe(true);
    expect(h.handing()?.phase).toBe('go');
  });

  it('looks often only while a request stands', async () => {
    const idle = await hander({ request: false });
    await idle.look();
    expect(idle.it.pace()).toBe(1000);
    const asked = await hander();
    await asked.look();
    expect(asked.it.pace()).toBe(250);
    const noted = await hander({ request: false, handing: { phase: 'go', fenced: true, w: W, copies: [] } });
    expect(noted.it.pace()).toBe(250);
  });

  it('claims only the request it saw', async () => {
    const h = await hander();
    /* The CEO asked for another machine between the look and the act. */
    const claimed = h.sql.query.bind(h.sql);
    let replaced = false;
    h.sql.query = async (text: string, params?: unknown[]) => {
      if (text.startsWith('UPDATE net.move') && !replaced) {
        replaced = true;
        await h.ask(h.c.id);
      }
      return claimed(text, params);
    };
    await h.look();
    expect([h.handing(), h.sent, await h.moves()]).toEqual([null, [], [expect.objectContaining({ state: 'preparing' })]]);
    /* A request left switching with nothing written down of it: the keeper lost its folder in the middle. */
    const lost = await hander();
    await lost.db.execute(raw`UPDATE net.move SET state = 'switching'`);
    await lost.look();
    expect([lost.handing(), lost.sent, await lost.moves()]).toEqual([null, [], [expect.objectContaining({ state: 'failed', reason: 'no_answer' })]]);
  });

  it('offers nothing while it could not find the new leader afterwards', async () => {
    /* Its database does not hold the link with every secret of it yet: as one that follows it would reach nobody. */
    const h = await hander({ link: false });
    await h.looks(8);
    expect([h.sent, h.handing(), await h.moves()]).toEqual([[], null, [expect.objectContaining({ state: 'preparing' })]]);
    expect(h.lines).toEqual(["The server does not move yet: this machine does not hold the company's link with its keys, which it would find the new server by."]);
  });

  it('fails a stale or empty request', async () => {
    const h = await hander({ request: false });
    await h.looks(2);
    expect([h.sent, h.handing()]).toEqual([[], null]);
    /* A request that prepared for over a day. */
    await h.ask(h.d.id, `to_timestamp(${(START - MOVE_WAIT_MS - 1000) / 1000})`);
    await h.look();
    expect(await h.moves()).toMatchObject([{ state: 'failed', reason: 'expired' }]);
    /* A target that lost its number. */
    await h.db.update(machines).set({ serverOrder: null });
    await h.ask(h.d.id, `to_timestamp(${START / 1000})`);
    await h.look();
    expect(await h.moves()).toMatchObject([{ state: 'failed', reason: 'left' }]);
    /* A failed request is forgotten a day after it ended. */
    await h.looks(4);
    expect(await h.moves()).toHaveLength(1);
    await h.db.execute(raw`UPDATE net.move SET ended_at = to_timestamp(${(START - MOVE_WAIT_MS) / 1000})`);
    await h.look();
    expect(await h.moves()).toEqual([]);
    expect(HANDING_FILE).toBe('handing.json');
  });
});
