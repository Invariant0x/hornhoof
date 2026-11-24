import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import { SealRefused } from '../src/modules/files/seal.js';
import { FileStore, StoreRefused } from '../src/modules/files/store.js';
import { sealV1 } from './seal-v1.js';

const key = randomBytes(32);
const folder = () => mkdtempSync(join(tmpdir(), 'hh-files-'));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const reasonOf = (work: Promise<unknown>) => work.then(() => 'kept', (err: unknown) => (err instanceof StoreRefused ? err.reason : `refused otherwise: ${String(err)}`));
/* Every file under the store's folder, temporary ones too. */
const everything = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);

describe('the file store of one machine', () => {
  it('keeps a file sealed under the hash of its bytes, once, and gives the bytes back', async () => {
    const store = new FileStore(folder());
    const bytes = randomBytes(300_000);
    const kept = await store.put(Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]), key);
    expect(kept).toMatchObject({ sha256: sha(bytes), size: bytes.length, fresh: true });
    expect(store.has(kept.sha256)).toBe(true);
    const onDisk = readFileSync(store.path(kept.sha256));
    expect(onDisk.includes(bytes.subarray(0, 64))).toBe(false);
    expect(kept).toMatchObject({ sealedSha256: sha(onDisk), sealedSize: onDisk.length });
    expect((await buffer(store.open(kept.sha256, key))).equals(bytes)).toBe(true);

    /* The same bytes again keep the file there, and say what it is. */
    const again = await store.put(Readable.from([bytes]), key);
    expect(again).toEqual({ ...kept, fresh: false });
    expect(readFileSync(store.path(kept.sha256)).equals(onDisk)).toBe(true);
    expect(everything(store.dir)).toEqual([kept.sha256]);
    expect((await store.list()).map(file => file.sha256)).toEqual([kept.sha256]);
  });

  it('keeps nothing of a file past its room, or of one that stops coming', async () => {
    const store = new FileStore(folder(), 50);
    const room = { bytes: 1000, full: () => new Error('no room') };
    await expect(store.put(Readable.from([randomBytes(600), randomBytes(600)]), key, room)).rejects.toThrow('no room');
    const stalled = new PassThrough();
    stalled.write(randomBytes(10));
    expect(await reasonOf(store.put(stalled, key))).toBe('idle');
    expect(everything(store.dir)).toEqual([]);
    expect(await store.put(Readable.from([randomBytes(1000)]), key, room)).toMatchObject({ size: 1000 });
  });

  it("takes another machine's sealed file only as long and with the hash it was said to have", async () => {
    const [one, two] = [new FileStore(folder()), new FileStore(folder())];
    const bytes = randomBytes(200_000);
    const kept = await one.put(Readable.from([bytes]), key);
    const sealed = () => one.sealed(kept.sha256)!.stream();
    const said = { sealedSha256: kept.sealedSha256, sealedSize: kept.sealedSize };
    expect(await reasonOf(two.take(kept.sha256, sealed(), { ...said, sealedSize: said.sealedSize + 1 }))).toBe('size');
    expect(await reasonOf(two.take(kept.sha256, sealed(), { ...said, sealedSize: said.sealedSize - 1 }))).toBe('size');
    expect(await reasonOf(two.take(kept.sha256, sealed(), { ...said, sealedSha256: sha(Buffer.from('other')) }))).toBe('hash');
    expect(await reasonOf(two.take('../etc/passwd', sealed(), said))).toBe('name');
    expect(everything(two.dir)).toEqual([]);

    expect(await two.take(kept.sha256, sealed(), said)).toBe(true);
    expect((await buffer(two.open(kept.sha256, key))).equals(bytes)).toBe(true);
    expect(await two.take(kept.sha256, sealed(), said)).toBe(false);
    expect(two.sealed('x'.repeat(64))).toBeNull();
  });

  it('opens no copy under another name than its own, and takes no sealed file that opens to other bytes than its name', async () => {
    const store = new FileStore(folder());
    const [a, b] = [randomBytes(100_000), randomBytes(5000)];
    const [keptA, keptB] = [await store.put(Readable.from([a]), key), await store.put(Readable.from([b]), key)];
    /* The copy of one file laid under the name of another, as a hand on the disk could: refused before a byte goes out. */
    copyFileSync(store.path(keptA.sha256), store.path(keptB.sha256));
    expect(() => store.open(keptB.sha256, key)).toThrow(SealRefused);
    expect((await buffer(store.open(keptA.sha256, key))).equals(a)).toBe(true);
    /* A sealed file that opens with the key, but to other bytes than its name, of either format, is not kept. */
    const other = new FileStore(folder());
    const sealedA = readFileSync(store.path(keptA.sha256));
    expect(await reasonOf(other.takeOpened(sha(b), Readable.from([sealedA]), key, 10_000_000))).toBe('hash');
    expect(await reasonOf(other.takeOpened(sha(b), Readable.from([sealV1(key, a)]), key, 10_000_000))).toBe('hash');
    expect(everything(other.dir)).toEqual([]);
    /* One of the format before, under its own name, is kept and opens. */
    expect(await other.takeOpened(sha(a), Readable.from([sealV1(key, a)]), key, 10_000_000)).toBe(true);
    expect((await buffer(other.open(sha(a), key))).equals(a)).toBe(true);
  });

  it('removes a file, and tidies only temporary files left an hour ago', async () => {
    const store = new FileStore(folder());
    const kept = await store.put(Readable.from([randomBytes(10)]), key);
    const left = join(store.dir, 'tmp', 'left.part');
    const fresh = join(store.dir, 'tmp', 'fresh.part');
    writeFileSync(left, 'x');
    writeFileSync(fresh, 'x');
    const hourAgo = new Date(Date.now() - 3_700_000);
    utimesSync(left, hourAgo, hourAgo);
    await store.tidy();
    expect(everything(store.dir).sort()).toEqual([kept.sha256, 'fresh.part'].sort());
    await store.remove(kept.sha256);
    await store.remove('not a name');
    expect(store.has(kept.sha256)).toBe(false);
    expect(() => store.open(kept.sha256, key)).toThrow(StoreRefused);
  });
});
