import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { SEAL_CHUNK, SEAL_HEAD, SealRefused, openSealed, seal, sealedSizeOf } from '../src/modules/files/seal.js';
import { sealV1 } from './seal-v1.js';

const key = randomBytes(32);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/* A file is sealed under its name, the sha256 of its plain bytes, as the store names it. */
const NAME = sha(Buffer.from('a file'));
const sealed = async (plain: Buffer, k = key, name = NAME): Promise<Buffer> => buffer(Readable.from([plain]).pipe(seal(k, () => name)));
const opened = async (bytes: Buffer, k = key, name = NAME): Promise<Buffer> => {
  const out: Buffer[] = [];
  await pipeline(Readable.from([bytes]), openSealed(k, name), async function* (source) {
    for await (const chunk of source) out.push(chunk as Buffer);
  });
  return Buffer.concat(out);
};
const refused = (bytes: Buffer, k = key, name = NAME) => opened(bytes, k, name).then(() => 'opened', (err: unknown) => (err instanceof SealRefused ? 'refused' : `failed otherwise: ${String(err)}`));
const SEALED_CHUNK = SEAL_CHUNK + 16;

describe('a file sealed for the store', () => {
  it('opens to its bytes at every length around a chunk, and two seals of the same bytes differ', async () => {
    for (const length of [0, 1, SEAL_CHUNK - 1, SEAL_CHUNK, SEAL_CHUNK + 1, 3 * SEAL_CHUNK, 5 * SEAL_CHUNK + 77]) {
      const plain = randomBytes(length);
      const one = await sealed(plain);
      expect(one.length, `length ${length}`).toBe(SEAL_HEAD + length + 16 * Math.max(1, Math.ceil(length / SEAL_CHUNK)));
      expect(sealedSizeOf(length), `length ${length}`).toBe(one.length);
      expect((await opened(one)).equals(plain), `length ${length}`).toBe(true);
      if (length >= 32) expect(one.includes(plain.subarray(0, 32))).toBe(false);
      const two = await sealed(plain);
      expect(two.equals(one)).toBe(false);
      expect((await opened(two)).equals(plain)).toBe(true);
    }
  });

  it('opens bytes that come in pieces of any size', async () => {
    const plain = randomBytes(4 * SEAL_CHUNK + 5);
    const one = await sealed(plain);
    const pieces: Buffer[] = [];
    for (let at = 0, n = 1; at < one.length; at += n, n = (n * 7 + 3) % 70_001 || 1) pieces.push(one.subarray(at, at + n));
    const out: Buffer[] = [];
    await pipeline(Readable.from(pieces), openSealed(key, NAME), async function* (source) {
      for await (const chunk of source) out.push(chunk as Buffer);
    });
    expect(Buffer.concat(out).equals(plain)).toBe(true);
  });

  it('refuses another key, a changed byte anywhere, a cut, a lost or swapped chunk, and bytes past the end', async () => {
    const plain = randomBytes(3 * SEAL_CHUNK + 100);
    const one = await sealed(plain);
    const flip = (at: number) => { const copy = Buffer.from(one); copy[at] ^= 1; return copy; };
    const chunk = (n: number) => one.subarray(SEAL_HEAD + n * SEALED_CHUNK, SEAL_HEAD + (n + 1) * SEALED_CHUNK);
    const head = one.subarray(0, SEAL_HEAD);
    expect(await refused(one, randomBytes(32))).toBe('refused');
    expect(await refused(flip(0))).toBe('refused');
    expect(await refused(flip(SEAL_HEAD - 1))).toBe('refused');
    expect(await refused(flip(SEAL_HEAD + 10))).toBe('refused');
    expect(await refused(flip(one.length - 1))).toBe('refused');
    expect(await refused(one.subarray(0, one.length - 1))).toBe('refused');
    /* Cut where a chunk ends: what is left looks whole, but its last chunk was not sealed as the last one. */
    expect(await refused(one.subarray(0, SEAL_HEAD + 3 * SEALED_CHUNK))).toBe('refused');
    expect(await refused(one.subarray(0, SEAL_HEAD + 2))).toBe('refused');
    expect(await refused(Buffer.concat([head, chunk(0), chunk(2), one.subarray(SEAL_HEAD + 3 * SEALED_CHUNK)]))).toBe('refused');
    expect(await refused(Buffer.concat([head, chunk(1), chunk(0), chunk(2), one.subarray(SEAL_HEAD + 3 * SEALED_CHUNK)]))).toBe('refused');
    expect(await refused(Buffer.concat([one, Buffer.from([0])]))).toBe('refused');
    expect(await refused(Buffer.alloc(0))).toBe('refused');
    expect((await opened(one)).equals(plain)).toBe(true);
  });

  it('opens only under the name it was sealed with, and a file sealed before names were bound under any', async () => {
    for (const length of [0, 100, SEAL_CHUNK, 2 * SEAL_CHUNK + 9]) {
      const plain = randomBytes(length);
      const one = await sealed(plain, key, sha(plain));
      expect((await opened(one, key, sha(plain))).equals(plain), `length ${length}`).toBe(true);
      expect(await refused(one, key, sha(randomBytes(8))), `length ${length}`).toBe('refused');
      const old = sealV1(key, plain);
      expect((await opened(old, key, sha(randomBytes(8)))).equals(plain), `length ${length}`).toBe(true);
      expect(await refused(old, randomBytes(32), sha(plain)), `length ${length}`).toBe('refused');
    }
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => seal(randomBytes(16), () => NAME)).toThrow();
    expect(() => openSealed(randomBytes(31), NAME)).toThrow();
  });
});
