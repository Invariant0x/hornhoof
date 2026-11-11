import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import * as age from 'age-encryption';
import { describe, expect, it } from 'vitest';
import { headLine, sealBundle, type Manifest } from '../src/modules/backups/bundle.js';
import type { HolderView } from '../src/modules/backups/types.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import { HolderKeeper, HOLD_EVERY_MS, ROOM, type HolderLink } from '../src/modules/keeper/holder.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { issueCertificate, makeAuthority, type Authority } from '../src/modules/network/authority.js';

const COMPANY = randomUUID();
const GIB = 1024 ** 3;
/* A bundle is made while its signer's certificate holds, so the bundles here are made from now on. */
const T0 = Date.now() + 60_000;
const HOUR = 3_600_000;

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
  const recipient = await age.identityToRecipient(await age.generateX25519Identity());
  const elsewhere = mkdtempSync(join(tmpdir(), 'hh-sealed-'));
  /* A bundle as the company's data machine makes it, made `hours` after the first. */
  const seal = async (hours: number, by = data): Promise<Sealed> => {
    const id = randomUUID();
    const out = join(elsewhere, `${id}.age`);
    const made = await sealBundle({
      dump: Readable.from([randomBytes(48 * 1024)]), id, company: COMPANY, dumpedAt: new Date(T0 + hours * HOUR), now: new Date(T0 + hours * HOUR), reason: 'timer', migrations: 106,
      secrets: { HORNHOOF_SECRET: 's', NODE_KEY: 'n', RELAY_URL: 'r' }, recipients: [recipient], recovery: recipient, recoveryLink: null, key: by.key, held: by.held, out,
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
  const keeper = new HolderKeeper({ dir, link, held: () => me.held, log: line => lines.push(line), diskFree: () => said.free });
  const view = (over: Partial<HolderView>) => void (said.answer = { status: 200, body: { keeps: true, hold: [], want: [], ...over } });
  /* The leader names these bundles and serves each whole. */
  const names = (...bundles: Sealed[]) => {
    for (const bundle of bundles) said.serves.set(bundle.id, bundle.whole);
    view({ hold: bundles.map(bundle => bundle.entry) });
  };
  const files = () => readdirSync(join(dir, 'bundles')).sort();
  return { authority, data, other, me, seal, keeper, said, asked, put, lines, view, names, files, dir };
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
    /* A keeper killed in the middle of a fetch leaves its part, and one killed between the two files a sealed part with
       no head. */
    const bundles = join(s.dir, 'bundles');
    const [part, headless] = [`${randomUUID()}.0a1b2c3d4e5f.part`, `${randomUUID()}.age`];
    for (const name of [part, headless]) writeFileSync(join(bundles, name), 'left');
    s.said.leader = false;
    await s.keeper.round();
    expect(s.files()).toEqual([`${a.id}.age`, `${a.id}.head`]);
    expect(s.keeper.held()).toEqual([a.id]);
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
