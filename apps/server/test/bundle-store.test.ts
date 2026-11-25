import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import * as age from 'age-encryption';
import { describe, expect, it } from 'vitest';
import { BundleRefused, checkHead, headLine, sealBundle, type Manifest } from '../src/modules/backups/bundle.js';
import { BundleStore } from '../src/modules/backups/store.js';
import { issueCertificate, makeAuthority } from '../src/modules/network/authority.js';
import { until } from './helpers-basic.js';

const COMPANY = randomUUID();
const folder = () => mkdtempSync(join(tmpdir(), 'hh-store-'));
const reasonOf = async (work: Promise<unknown>): Promise<string> => work.then(() => 'accepted', err => (err instanceof BundleRefused ? err.reason : `not refused: ${String(err)}`));

/* A data machine that seals bundles, and each bundle as it travels: its two lines, then its sealed part. */
async function sealer() {
  const authority = await makeAuthority(COMPANY);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const key = { privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string };
  const machineId = randomUUID();
  /* Its certificate is a day old, so a bundle of an hour ago was made while it held. */
  const issued = await issueCertificate(authority, { machineId, role: 'data', signKey: key.publicPem, now: new Date(Date.now() - 86_400_000) });
  const held = { machine: machineId, role: 'data' as const, certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() };
  const recipient = await age.identityToRecipient(await age.generateX25519Identity());
  const dir = folder();
  const check = (head: string): Manifest => checkHead(head, { authorityPem: authority.certPem, company: COMPANY });
  const seal = async (madeAt: Date, bytes = 200_000) => {
    const id = randomUUID();
    const out = join(dir, `${id}.age`);
    const { head, manifest } = await sealBundle({ dump: Readable.from([randomBytes(bytes)]), id, company: COMPANY, dumpedAt: madeAt, now: madeAt, reason: 'timer', migrations: 61, secrets: { HORNHOOF_SECRET: 's', NODE_KEY: 'n', RELAY_URL: 'r' }, recipients: [recipient], recovery: null, recoveryLink: null, key, held, out });
    const sealed = readFileSync(out);
    return { id, head, manifest, out, sealed, whole: Buffer.concat([Buffer.from(headLine(head)), sealed]) };
  };
  return { check, seal };
}

describe('a store of bundles', () => {
  it('keeps complete bundles only, newest first, and reads them back as they came', async () => {
    const s = await sealer();
    const store = new BundleStore(folder());
    const [older, newer] = [await s.seal(new Date(Date.now() - 3_600_000)), await s.seal(new Date())];
    /* One that ends half way leaves nothing. */
    expect(await reasonOf(store.take(Readable.from([older.whole.subarray(0, older.whole.length - 1000)]), s.check))).toBe('size');
    expect(store.list()).toEqual([]);
    expect(readdirSync((store as unknown as { dir: string }).dir)).toEqual([]);

    expect(await store.take(Readable.from([older.whole]), s.check)).toMatchObject({ id: older.id, size: older.sealed.length });
    await store.take(Readable.from([newer.whole]), s.check, { id: newer.id });
    expect(store.list().map(bundle => bundle.id)).toEqual([newer.id, older.id]);
    expect([store.has(older.id), store.has(randomUUID()), store.has('../x')]).toEqual([true, false, false]);
    const opened = store.open(older.id)!;
    expect(opened.length).toBe(older.whole.length);
    expect((await buffer(opened.stream())).equals(older.whole)).toBe(true);
    expect(store.open(randomUUID())).toBeNull();
    /* A bundle held already is answered as it is held, and nothing is written. */
    const before = readFileSync(store.ageFile(older.id));
    expect((await store.take(Readable.from([older.whole]), s.check)).id).toBe(older.id);
    expect(readFileSync(store.ageFile(older.id)).equals(before)).toBe(true);
    /* Asked for one bundle and given another. */
    const third = await s.seal(new Date());
    expect(await reasonOf(store.take(Readable.from([third.whole]), s.check, { id: older.id }))).toBe('format');
    store.keepOnly([newer.id]);
    expect(store.list().map(bundle => bundle.id)).toEqual([newer.id]);
    store.remove(newer.id);
    expect(store.list()).toEqual([]);
  });

  it('leaves no file behind of a bundle it cuts at its first piece', async () => {
    const s = await sealer();
    const store = new BundleStore(folder());
    const dir = (store as unknown as { dir: string }).dir;
    /* Longer than signed, and all there at once: it is cut before its file is even open. */
    for (let n = 0; n < 5; n += 1) {
      const long = await s.seal(new Date(), 2000);
      expect(await reasonOf(store.take(Readable.from([Buffer.concat([long.whole, randomBytes(64)])]), s.check))).toBe('size');
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it('takes each bundle once, whole', async () => {
    const s = await sealer();
    const store = new BundleStore(folder());
    const b = await s.seal(new Date());
    /* Two takes of one bundle at once: the first whole, the second with the same head and another sealed part that
       goes on coming after the first has answered. */
    const slow = new PassThrough();
    slow.write(Buffer.from(headLine(b.head)));
    slow.write(randomBytes(1000));
    const second = reasonOf(store.take(slow, s.check));
    await store.take(Readable.from([b.whole]), s.check);
    slow.end(randomBytes(b.sealed.length - 1000));
    /* What the second brought is not what was signed, and what the first published stays as it is. */
    expect(await second).toBe('hash');
    expect((await store.verify(b.id)).id).toBe(b.id);
    expect(readFileSync(store.ageFile(b.id)).equals(b.sealed)).toBe(true);
    const dir = (store as unknown as { dir: string }).dir;
    expect(readdirSync(dir).filter(name => name.endsWith('.part'))).toEqual([]);

    /* One that goes on past its signed size is cut soon after it. */
    const long = await s.seal(new Date());
    let read = 0;
    const endless = new Readable({
      read() {
        const chunk = read === 0 ? long.whole : randomBytes(64 * 1024);
        read += chunk.length;
        this.push(chunk);
      },
    });
    expect(await reasonOf(store.take(endless, s.check))).toBe('size');
    expect(read).toBeLessThanOrEqual(long.whole.length + 2 * 1024 * 1024);

    /* Too little room: refused before the sealed part is read. */
    const big = await s.seal(new Date());
    let pulled = 0;
    const counted = new Readable({
      read() {
        this.push(pulled === 0 ? Buffer.from(headLine(big.head)) : pulled === 1 ? big.sealed : null);
        pulled += 1;
      },
    });
    expect(await reasonOf(store.take(counted, s.check, { free: () => Math.floor(2.9 * big.manifest.size) }))).toBe('room');
    expect(pulled).toBeLessThanOrEqual(2);
    expect(store.has(big.id)).toBe(false);

    /* One that stops coming. */
    const stalled = new PassThrough();
    stalled.write(big.whole.subarray(0, big.whole.length - 1000));
    expect(await reasonOf(store.take(stalled, s.check, { idleMs: 100 }))).toBe('idle');

    /* Tidying while a take still writes leaves its file. */
    const writing = new PassThrough();
    writing.write(big.whole.subarray(0, big.whole.length - 1000));
    const taking = store.take(writing, s.check);
    await until(() => readdirSync(dir).some(name => name.endsWith('.part')));
    store.keepOnly([b.id]);
    writing.end(big.whole.subarray(big.whole.length - 1000));
    expect((await taking).id).toBe(big.id);
    /* What a take that died left is tidied away. */
    writeFileSync(join(dir, `${randomUUID()}.abcdef.part`), 'left over');
    store.keepOnly([b.id, big.id]);
    expect(readdirSync(dir).filter(name => name.endsWith('.part'))).toEqual([]);

    /* A stored part that changed is found by its hash. */
    const stored = readFileSync(store.ageFile(b.id));
    stored[stored.length - 1] = stored[stored.length - 1]! ^ 1;
    writeFileSync(store.ageFile(b.id), stored);
    expect(await reasonOf(store.verify(b.id))).toBe('hash');
    expect(await reasonOf(store.verify(randomUUID()))).toBe('format');
  });

  it('tidies an orphan head only when no writer holds its bundle', async () => {
    const s = await sealer();
    const dir = folder();
    const store = new BundleStore(dir);
    const kept = await s.seal(new Date());
    await store.take(Readable.from([kept.whole]), s.check);
    const [orphan, busy] = [randomUUID(), randomUUID()];
    writeFileSync(join(dir, `${orphan}.head`), '{"manifest":"{}"}', { mode: 0o600 });
    writeFileSync(join(dir, `${busy}.head`), '{"manifest":"{}"}', { mode: 0o600 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const writing = store.alone(busy, () => gate);
    store.tidy();
    expect(readdirSync(dir).sort()).toEqual([`${busy}.head`, `${kept.id}.age`, `${kept.id}.head`].sort());
    release();
    await writing;
    await new Promise<void>(resolve => setImmediate(resolve));
    store.tidy();
    expect(readdirSync(dir).sort()).toEqual([`${kept.id}.age`, `${kept.id}.head`]);
  });
});
