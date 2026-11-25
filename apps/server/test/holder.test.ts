import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import * as age from 'age-encryption';
import { describe, expect, it } from 'vitest';
import { answerChallenge, answerProof, checkHead, headLine, sealBundle, type Manifest } from '../src/modules/backups/bundle.js';
import type { HolderView } from '../src/modules/backups/types.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import { HolderKeeper, HOLD_EVERY_MS, ROOM, SENT_FOR_MS, SURVIVOR_MS, type HolderLink } from '../src/modules/keeper/holder.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { issueCertificate, makeAuthority, type Authority } from '../src/modules/network/authority.js';

const COMPANY = randomUUID();
const GIB = 1024 ** 3;
/* A bundle is made while its signer's certificate holds, so the bundles here are made from now on. */
const T0 = Date.now() + 60_000;
const HOUR = 3_600_000;
/* The link the lost company was reached by when its recovery file was saved. */
const LINK = { name: 'acme', url: 'https://acme.hornhoof.test' };

function machineKey(): MachineKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

async function machine(authority: Authority, role: 'data' | 'worker'): Promise<{ key: MachineKey; held: HeldCertificate }> {
  const key = machineKey();
  const id = randomUUID();
  const issued = await issueCertificate(authority, { machineId: id, role, signKey: key.publicPem });
  return { key, held: { machine: id, role, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() } };
}

type Sealed = { id: string; manifest: Manifest; whole: Buffer; sealed: Buffer; entry: { id: string; size: number; sha256: string } };
type Answer = { status: number; body: unknown } | Error;

/* A worker that may keep bundles, with a leader the test plays: what it answers, and the bundles it serves. */
async function stand() {
  const authority = await makeAuthority(COMPANY);
  const [data, other, me] = [await machine(authority, 'data'), await machine(authority, 'worker'), await machine(authority, 'worker')];
  /* The recovery key the bundles are sealed for; its private half is the lost company's recovery file's. */
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  const elsewhere = mkdtempSync(join(tmpdir(), 'hh-sealed-'));
  /* A bundle as the company's data machine makes it, made `hours` after the first. */
  const seal = async (hours: number, by = data): Promise<Sealed> => {
    const id = randomUUID();
    const out = join(elsewhere, `${id}.age`);
    const made = await sealBundle({
      dump: Readable.from([randomBytes(48 * 1024)]), id, company: COMPANY, dumpedAt: new Date(T0 + hours * HOUR), now: new Date(T0 + hours * HOUR), reason: 'timer', migrations: 106,
      secrets: { HORNHOOF_SECRET: 's', NODE_KEY: 'n', RELAY_URL: 'r' }, recipients: [recipient], recovery: recipient, recoveryLink: LINK, key: by.key, held: by.held, out,
    });
    const sealed = readFileSync(out);
    return { id, manifest: made.manifest, sealed, whole: Buffer.concat([Buffer.from(headLine(made.head)), sealed]), entry: { id, size: made.manifest.size, sha256: made.manifest.sha256 } };
  };
  const dir = mkdtempSync(join(tmpdir(), 'hh-holder-'));
  const lines: string[] = [];
  /* serves: what a GET of a bundle gives, its bytes or a stream the test makes. */
  const said = { leader: true, answer: { status: 200, body: { keeps: true, hold: [], want: [] } } as Answer, free: 100 * GIB, serves: new Map<string, Buffer | (() => Readable)>() };
  const asked: string[] = [];
  const put: { path: string; body: Buffer }[] = [];
  const link: HolderLink = {
    leader: () => (said.leader ? { machine: data.held.machine } : null),
    request: (method, path) => {
      asked.push(`${method} ${path}`);
      return said.answer instanceof Error ? Promise.reject(said.answer) : Promise.resolve(said.answer);
    },
    stream: async (method, path, body) => {
      asked.push(`${method} ${path}`);
      if (method === 'PUT') {
        put.push({ path, body: await buffer(body!) });
        return { status: 201, length: 0, body: Readable.from([]) };
      }
      const served = said.serves.get(path.slice('/peer/backups/'.length));
      if (!served) return { status: 404, length: null, body: Readable.from([]) };
      return Buffer.isBuffer(served) ? { status: 200, length: served.length, body: Readable.from([served]) } : { status: 200, length: null, body: served() };
    },
  };
  /* The servers a survivor may find: each answers a challenge as the test says, and keeps what it is sent. */
  let clock = Date.now();
  const servers = new Map<string, { answers: 'right' | 'wrong' | 404 | 'down' | 'stalls'; puts: { id: string; proof: string; body: Buffer }[]; challenges: number; names: string[] }>();
  const server = (origin: string, answers: 'right' | 'wrong' | 404 | 'down' | 'stalls' = 'right') => {
    servers.set(origin, { answers, puts: [], challenges: 0, names: [] });
    return servers.get(origin)!;
  };
  const fetched: string[] = [];
  const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const there = servers.get(url.origin);
    fetched.push(`${init.method ?? 'GET'} ${url.origin}${url.pathname}`);
    if (!there || there.answers === 'down') throw new TypeError('fetch failed');
    const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/recovery/challenge') {
      there.challenges += 1;
      if (there.answers === 404) return json(404, { error: { code: 'not_found' } });
      /* Under whichever name it was asked: the test reads which. */
      const file = new Uint8Array(init.body as ArrayBuffer);
      for (const asked of [LINK.name, '']) {
        const nonce = await answerChallenge(file, identity, asked);
        if (!nonce) continue;
        there.names.push(asked);
        return json(200, { proof: there.answers === 'wrong' ? answerProof('A'.repeat(43)) : answerProof(nonce) });
      }
      return json(400, { error: { reason: 'challenge_refused' } });
    }
    const id = url.pathname.split('/').pop()!;
    const proof = new Headers(init.headers).get('x-hornhoof-recovery') ?? '';
    if (there.answers === 'stalls') return new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const body = Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer());
    there.puts.push({ id, proof, body });
    return json(there.puts.filter(put => put.id === id).length > 1 ? 409 : 201, { id });
  }) as typeof fetch;
  const view = { data: [{ addresses: ['192.0.2.10', '192.0.2.11'], webPort: 8080 }], link: { url: 'https://renamed.hornhoof.test' } as { url: string } | null };
  const keeper = new HolderKeeper({
    dir, link, held: () => me.held, log: line => lines.push(line), diskFree: () => said.free,
    survivor: { view: () => view, joinServer: 'http://192.0.2.10:8080/', fetch: fakeFetch, afterMs: SURVIVOR_MS, idleMs: 100, now: () => clock },
  });
  const viewOf = (over: Partial<HolderView>) => void (said.answer = { status: 200, body: { keeps: true, hold: [], want: [], ...over } });
  /* The leader names these bundles and serves each whole. */
  const names = (...bundles: Sealed[]) => {
    for (const bundle of bundles) said.serves.set(bundle.id, bundle.whole);
    viewOf({ hold: bundles.map(bundle => bundle.entry) });
  };
  const files = () => readdirSync(join(dir, 'bundles')).sort();
  return { authority, data, other, me, seal, keeper, link, said, asked, put, lines, view: viewOf, names, files, dir, server, servers, fetched, survivorView: view, advance: (ms: number) => void (clock += ms) };
}

describe('a machine that keeps the company\'s backups', () => {
  it('holds what its leader names', async () => {
    const s = await stand();
    const [a, b] = [await s.seal(0), await s.seal(6)];
    s.names(b, a);
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([b.id, a.id]);
    expect(s.asked).toEqual(['GET /api/network/backups', `GET /peer/backups/${b.id}`, `GET /peer/backups/${a.id}`]);
    expect((await buffer(s.keeper.store().open(a.id)!.stream())).equals(a.whole)).toBe(true);
    /* What it holds is not fetched again. */
    await s.keeper.round();
    expect(s.asked.filter(call => call.startsWith('GET /peer/backups/'))).toHaveLength(2);
    expect([HOLD_EVERY_MS, ROOM]).toEqual([60_000, 3]);
  });

  it('deletes only after the new ones are complete', async () => {
    const s = await stand();
    const [a, b, c] = [await s.seal(0), await s.seal(6), await s.seal(12)];
    s.names(b, a);
    await s.keeper.round();
    /* The leader now names B and C, and C breaks off half way. */
    s.names(c, b);
    s.said.serves.set(c.id, () => Readable.from((async function* () {
      yield c.whole.subarray(0, c.whole.length / 2);
      throw new Error('the connection broke');
    })()));
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([b.id, a.id]);
    expect(s.files().filter(name => name.endsWith('.part'))).toEqual([]);
    s.said.serves.set(c.id, c.whole);
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([c.id, b.id]);
  });

  it('keeps its bundles without an answer', async () => {
    const s = await stand();
    const [a, b] = [await s.seal(0), await s.seal(6)];
    s.names(b, a);
    await s.keeper.round();
    const silences: (() => void)[] = [
      () => void (s.said.leader = false),
      () => void (s.said.answer = new Error('the leader hung up')),
      () => void (s.said.answer = { status: 404, body: { error: { code: 'not_found' } } }),
      () => void (s.said.answer = { status: 503, body: null }),
      () => void (s.said.answer = { status: 200, body: { hold: 'everything' } }),
      () => void (s.said.answer = { status: 200, body: null }),
    ];
    for (const silence of silences) {
      s.said.leader = true;
      silence();
      await s.keeper.round();
      expect(s.keeper.held()).toEqual([b.id, a.id]);
    }
  });

  it('keeps its bundles through an empty answer', async () => {
    const s = await stand();
    const [c, a, b, d] = [await s.seal(0), await s.seal(6), await s.seal(12), await s.seal(18)];
    s.names(b, a);
    await s.keeper.round();
    /* A restored database before its first bundle names none. */
    s.view({ hold: [] });
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([b.id, a.id]);
    /* One older than both, as a restored database may name: fetched, and nothing newer goes for it. */
    s.names(c);
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([b.id, a.id, c.id]);
    /* A newer one takes the place of all that came before it, once it is whole. */
    s.names(d);
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([d.id]);
    /* Its owner unticked "Keep company backups". */
    s.view({ keeps: false, hold: [d.entry] });
    await s.keeper.round();
    expect([s.keeper.held(), s.files()]).toEqual([[], []]);
  });

  it('fetches only with room', async () => {
    const s = await stand();
    const a = await s.seal(0);
    s.names(a);
    s.said.free = Math.floor(2.9 * a.entry.size);
    await s.keeper.round();
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([]);
    expect(s.asked.filter(call => call.startsWith('GET /peer/backups/'))).toEqual([]);
    expect(s.lines.filter(line => line.includes('too little free disk'))).toHaveLength(1);
    s.said.free = 3 * a.entry.size;
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([a.id]);
  });

  it('refuses a bundle it cannot trust', async () => {
    const s = await stand();
    /* Signed by a machine that holds no data; of another company's authority; and one that is whole and signed, but
       not the bundle the leader's record names. */
    const byWorker = await s.seal(0, s.other);
    const strangers = await makeAuthority(randomUUID());
    const foreign = await s.seal(0, await machine(strangers, 'data'));
    const [named, swapped] = [await s.seal(6), await s.seal(6)];
    s.names(byWorker, foreign, named);
    s.said.serves.set(named.id, swapped.whole);
    await s.keeper.round();
    expect([s.keeper.held(), s.files()]).toEqual([[], []]);
    /* The record's hash is not this bundle's, though the bundle holds together by itself. */
    s.view({ hold: [{ ...named.entry, sha256: swapped.entry.sha256 }] });
    s.said.serves.set(named.id, named.whole);
    await s.keeper.round();
    expect([s.keeper.held(), s.files()]).toEqual([[], []]);
    s.names(named);
    await s.keeper.round();
    expect(s.keeper.held()).toEqual([named.id]);
  });

  it('clears what a fetch that died left, with or without a leader', async () => {
    const s = await stand();
    const a = await s.seal(0);
    s.names(a);
    await s.keeper.round();
    /* A keeper killed in the middle of a fetch leaves its part, and one killed between the two files leaves a sealed
       part with no head or an orphan head with no sealed part. */
    const bundles = join(s.dir, 'bundles');
    const [part, headless, ageless] = [`${randomUUID()}.0a1b2c3d4e5f.part`, `${randomUUID()}.age`, `${randomUUID()}.head`];
    for (const name of [part, headless, ageless]) writeFileSync(join(bundles, name), 'left');
    s.said.leader = false;
    await s.keeper.round();
    expect(s.files()).toEqual([`${a.id}.age`, `${a.id}.head`]);
    expect(s.keeper.held()).toEqual([a.id]);
  });

  it("leaves a data machine's own bundles unpruned while still sending what the leader wants", async () => {
    const s = await stand();
    const [a, b, c] = [await s.seal(0), await s.seal(6), await s.seal(12)];
    const check = (head: string): Manifest => checkHead(head, { authorityPem: s.authority.certPem, company: COMPANY });
    const dataKeeper = new HolderKeeper({ dir: s.dir, link: s.link, held: () => s.data.held, log: line => s.lines.push(line), diskFree: () => s.said.free });
    await dataKeeper.store().take(Readable.from([a.whole]), check);
    await dataKeeper.store().take(Readable.from([b.whole]), check);
    /* Even when keeps is false, a data machine never wipes its bundles, and still sends any bundle the leader wants. */
    s.view({ keeps: false, hold: [], want: [a.id] });
    await dataKeeper.round();
    expect(dataKeeper.held()).toEqual([b.id, a.id]);
    expect(s.put.map(sent => sent.path)).toEqual([`/peer/backups/${a.id}`]);
    expect(s.put[0]!.body.equals(a.whole)).toBe(true);
    /* Nor does a data machine fetch worker holder slots or prune older local bundles when newer ones are named. */
    s.names(c);
    await dataKeeper.round();
    expect(dataKeeper.held()).toEqual([b.id, a.id]);
    expect(s.asked.filter(call => call.startsWith('GET /peer/backups/'))).toEqual([]);
  });

  it('sends what its leader wants', async () => {
    const s = await stand();
    const [a, b] = [await s.seal(0), await s.seal(6)];
    s.names(b, a);
    await s.keeper.round();
    s.view({ hold: [b.entry, a.entry], want: [a.id, randomUUID()] });
    await s.keeper.round();
    expect(s.put.map(sent => sent.path)).toEqual([`/peer/backups/${a.id}`]);
    expect(s.put[0]!.body.equals(a.whole)).toBe(true);
  });

  it('does nothing before it has its certificate', async () => {
    const s = await stand();
    const keeper = new HolderKeeper({ dir: s.dir, link: { leader: () => ({}), request: () => Promise.reject(new Error('asked')), stream: () => Promise.reject(new Error('asked')) }, held: () => null, log: line => s.lines.push(line) });
    await keeper.round();
    expect(s.lines).toEqual([]);
  });
});

describe('a machine that survived the loss of its server', () => {
  /* It holds two bundles of the company, and its leader is gone. */
  async function survivor() {
    const s = await stand();
    const [a, b] = [await s.seal(0), await s.seal(6)];
    s.names(b, a);
    await s.keeper.round();
    s.said.leader = false;
    s.asked.length = 0;
    /* It sees that its leader is gone: from here the wait counts. */
    await s.keeper.survive();
    return { ...s, a, b };
  }

  it('waits for its leader before it challenges anyone', async () => {
    const s = await survivor();
    s.server('https://acme.hornhoof.test');
    await s.keeper.survive();
    s.advance(SURVIVOR_MS - 1000);
    await s.keeper.survive();
    expect(s.fetched).toEqual([]);
    /* A leader that came back in between starts the wait anew. */
    s.said.leader = true;
    await s.keeper.survive();
    s.said.leader = false;
    s.advance(2000);
    await s.keeper.survive();
    expect(s.fetched).toEqual([]);
    s.advance(SURVIVOR_MS);
    await s.keeper.survive();
    /* The link the recovery file was saved with comes first, asked under its name, whatever the link is called now. */
    expect(s.fetched[0]).toBe('POST https://acme.hornhoof.test/api/recovery/challenge');
    expect(s.servers.get('https://acme.hornhoof.test')!.names).toEqual(['acme']);
    expect(SURVIVOR_MS).toBe(600_000);
  });

  it('sends its bundles to whoever answers the challenge, once', async () => {
    const s = await survivor();
    const found = s.server('https://acme.hornhoof.test');
    s.advance(SURVIVOR_MS);
    await s.keeper.survive();
    /* Newest first, each whole, each with a proof made for that very bundle. */
    expect(found.puts.map(put => put.id)).toEqual([s.b.id, s.a.id]);
    expect(found.puts.map(put => put.body.equals(put.id === s.b.id ? s.b.whole : s.a.whole))).toEqual([true, true]);
    expect(new Set(found.puts.map(put => put.proof)).size).toBe(2);
    for (const put of found.puts) expect(put.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    /* One line for the challenge, which names the server and holds no number and no proof. */
    expect(s.lines.filter(line => line.startsWith('survivor:'))).toEqual(['survivor: https://acme.hornhoof.test answered']);
    expect(s.lines.filter(line => found.puts.some(put => line.includes(put.proof)))).toEqual([]);
    /* The next round sends nothing more and asks nobody. */
    const before = s.fetched.length;
    s.advance(SURVIVOR_MS);
    await s.keeper.survive();
    expect(s.fetched).toHaveLength(before);
    /* A bundle it comes to hold after that goes there without a new challenge, with a proof of the same number. */
    const c = await s.seal(12);
    s.said.leader = true;
    s.names(c, s.b);
    await s.keeper.round();
    s.said.leader = false;
    s.advance(SURVIVOR_MS + 1000);
    await s.keeper.survive();
    s.advance(SURVIVOR_MS);
    await s.keeper.survive();
    expect([found.challenges, found.puts.map(put => put.id)]).toEqual([1, [s.b.id, s.a.id, c.id]]);
    /* After fifty minutes it is asked again. */
    s.advance(SENT_FOR_MS);
    await s.keeper.survive();
    expect(found.challenges).toBe(2);
  });

  it('sends nothing to a server that cannot answer, and tries the next', async () => {
    const s = await survivor();
    /* The link of the file answers with a proof of another number, the link the view names says it recovers nothing,
       the join server is down, and the old address of the data machine has the new server. */
    const [wrong, none, right] = [s.server('https://acme.hornhoof.test', 'wrong'), s.server('https://renamed.hornhoof.test', 404), s.server('http://192.0.2.11:8080')];
    s.advance(SURVIVOR_MS);
    await s.keeper.survive();
    expect(s.fetched.filter(call => call.startsWith('POST'))).toEqual([
      'POST https://acme.hornhoof.test/api/recovery/challenge', 'POST https://renamed.hornhoof.test/api/recovery/challenge',
      'POST http://192.0.2.10:8080/api/recovery/challenge', 'POST http://192.0.2.11:8080/api/recovery/challenge',
    ]);
    expect([wrong.puts, none.puts, right.puts.map(put => put.id)]).toEqual([[], [], [s.b.id, s.a.id]]);
    expect(s.lines.filter(line => line.startsWith('survivor:'))).toEqual([
      'survivor: https://acme.hornhoof.test refused', 'survivor: https://renamed.hornhoof.test refused', 'survivor: http://192.0.2.10:8080 unreachable', 'survivor: http://192.0.2.11:8080 answered',
    ]);
    /* A view that names no link, and a bundle made with none: the old addresses alone, asked under no name. */
    const plain = await survivor();
    plain.survivorView.link = null;
    const there = plain.server('http://192.0.2.10:8080');
    plain.server('https://acme.hornhoof.test', 'down');
    plain.advance(SURVIVOR_MS);
    await plain.keeper.survive();
    expect(there.puts).toHaveLength(2);
  });

  it('goes on when a send stalls', async () => {
    const s = await survivor();
    const [stalls, right] = [s.server('https://acme.hornhoof.test', 'stalls'), s.server('http://192.0.2.10:8080')];
    s.advance(SURVIVOR_MS);
    await s.keeper.survive();
    expect([stalls.challenges, stalls.puts, right.puts.map(put => put.id)]).toEqual([1, [], [s.b.id, s.a.id]]);
    /* The one that took them is the one it goes back to. */
    const c = await s.seal(12);
    s.said.leader = true;
    s.names(c, s.b);
    await s.keeper.round();
    s.said.leader = false;
    s.advance(SURVIVOR_MS + 1000);
    await s.keeper.survive();
    s.advance(SURVIVOR_MS);
    await s.keeper.survive();
    expect([stalls.challenges, right.puts.map(put => put.id)]).toEqual([1, [s.b.id, s.a.id, c.id]]);
  });

  it('challenges nobody while it holds nothing a recovery file opens, or has a leader', async () => {
    const s = await stand();
    s.server('https://acme.hornhoof.test');
    s.said.leader = false;
    s.advance(2 * SURVIVOR_MS);
    await s.keeper.survive();
    expect(s.fetched).toEqual([]);
    const held = await survivor();
    held.server('https://acme.hornhoof.test');
    held.said.leader = true;
    held.advance(2 * SURVIVOR_MS);
    await held.keeper.survive();
    expect(held.fetched).toEqual([]);
  });
});
