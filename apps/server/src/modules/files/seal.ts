import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/* A file as the store keeps it on any machine: a head of the format's name and a salt of its own, then the bytes in
   sealed chunks. Each chunk is AES-256-GCM under the file's key, made from the store key and the salt, with a nonce of
   its number and a flag on the last one, as age's STREAM has it: a chunk lost, moved, changed or cut off, or a file cut
   where a chunk ends, does not open. The last chunk is sealed with the file's name too, the sha256 of its plain bytes,
   which the store knows once they have all passed: a file laid under another name does not open (#2036). A file of the
   format before (HHFILE1) binds no name and still opens; whoever takes one from another machine checks its bytes against
   its name. Only a machine with the store key opens one; a holder keeps and checks the sealed bytes alone. */
export const SEAL_CHUNK = 64 * 1024;
const MAGIC = Buffer.from('HHFILE2\n', 'latin1');
const MAGIC_V1 = Buffer.from('HHFILE1\n', 'latin1');
const SALT = 16;
const TAG = 16;
export const SEAL_HEAD = MAGIC.length + SALT;
const KEY = 32;
const SEALED_CHUNK = SEAL_CHUNK + TAG;
/* How long the sealed form of a file of `size` bytes is: the head, the bytes, and the tag of each chunk, of the last one
   too, which an empty file has as well. */
export const sealedSizeOf = (size: number): number => SEAL_HEAD + size + TAG * Math.max(1, Math.ceil(size / SEAL_CHUNK));

export class SealRefused extends Error {
  constructor() {
    super('This file is not one the store sealed with this key, or it was changed or cut.');
  }
}

function fileKey(key: Buffer, salt: Buffer): Buffer {
  if (key.length !== KEY) throw new Error('The store key is 32 bytes.');
  return Buffer.from(hkdfSync('sha256', key, salt, 'hornhoof file', KEY));
}

function nonce(n: number, last: boolean): Buffer {
  const value = Buffer.alloc(12);
  value.writeUIntBE(n, 5, 6);
  value[11] = last ? 1 : 0;
  return value;
}

/* What the last chunk is sealed with besides its bytes: the format's name and the file's. */
const named = (name: string): Buffer => Buffer.concat([MAGIC, Buffer.from(name, 'latin1')]);

function sealChunk(key: Buffer, n: number, last: boolean, plain: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(n, last));
  cipher.setAAD(data);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(key: Buffer, n: number, last: boolean, sealed: Buffer, data: Buffer): Buffer {
  if (sealed.length < TAG) throw new SealRefused();
  const decipher = createDecipheriv('aes-256-gcm', key, nonce(n, last));
  decipher.setAAD(data);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
  } catch {
    throw new SealRefused();
  }
}

/* Seals what passes through, under the name it gives once every byte passed. A chunk goes out once the next byte came,
   so the last one is known when it is sealed. The same bytes under the same name, key and salt seal the same, so a
   machine that seals a file again under the salt its copies elsewhere have keeps the very bytes they keep; no other
   bytes are ever sealed under that salt, as the name is the sha256 of the bytes. */
export function seal(key: Buffer, name: () => string, salt: Buffer = randomBytes(SALT)): Transform {
  if (salt.length !== SALT) throw new Error('A seal\'s salt is 16 bytes.');
  const k = fileKey(key, salt);
  let held: Buffer = Buffer.alloc(0);
  let n = 0;
  let started = false;
  const start = (out: Transform) => {
    if (!started) out.push(Buffer.concat([MAGIC, salt]));
    started = true;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      start(this);
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
      while (held.length > SEAL_CHUNK) {
        this.push(sealChunk(k, n++, false, held.subarray(0, SEAL_CHUNK), MAGIC));
        held = held.subarray(SEAL_CHUNK);
      }
      done();
    },
    flush(done: TransformCallback) {
      start(this);
      this.push(sealChunk(k, n, true, held, named(name())));
      done();
    },
  });
}

/* The salt a sealed file's head carries, in hex. */
export const saltOf = (head: Buffer): string => head.subarray(MAGIC.length, SEAL_HEAD).toString('hex');

/* How a sealed file opens, from its head: the file's key, and what its chunks and its last one are sealed with. */
type Opening = { k: Buffer; data: Buffer; last: Buffer };
function openingOf(key: Buffer, head: Buffer, name: string): Opening {
  const magic = head.subarray(0, MAGIC.length);
  const k = () => fileKey(key, head.subarray(MAGIC.length, SEAL_HEAD));
  if (magic.equals(MAGIC)) return { k: k(), data: MAGIC, last: named(name) };
  if (magic.equals(MAGIC_V1)) return { k: k(), data: MAGIC_V1, last: MAGIC_V1 };
  throw new SealRefused();
}

/* Opens what passes through, sealed under this name, and fails the stream with SealRefused at the first chunk that does
   not open. A sealed chunk is held until more comes, so the one the stream ends with is opened as the last. */
export function openSealed(key: Buffer, name: string): Transform {
  if (key.length !== KEY) throw new Error('The store key is 32 bytes.');
  let opening: Opening | null = null;
  let held: Buffer = Buffer.alloc(0);
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
      try {
        if (!opening) {
          if (held.length < SEAL_HEAD) return done();
          opening = openingOf(key, held, name);
          held = held.subarray(SEAL_HEAD);
        }
        while (held.length > SEALED_CHUNK) {
          this.push(openChunk(opening.k, n++, false, held.subarray(0, SEALED_CHUNK), opening.data));
          held = held.subarray(SEALED_CHUNK);
        }
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!opening) throw new SealRefused();
        this.push(openChunk(opening.k, n, true, held, opening.last));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
}

/* Where the last chunk of a sealed file this long starts, and its number; none for one too short to be sealed. */
export function lastChunkOf(size: number): { at: number; n: number } | null {
  const body = size - SEAL_HEAD;
  if (body < TAG) return null;
  const n = Math.ceil(body / SEALED_CHUNK) - 1;
  return { at: SEAL_HEAD + n * SEALED_CHUNK, n };
}

/* Checks from its head and its last chunk alone that a sealed file opens under this name, before a byte of it goes out.
   Throws SealRefused when it does not. */
export function checkEnds(key: Buffer, head: Buffer, last: Buffer, n: number, name: string): void {
  if (key.length !== KEY) throw new Error('The store key is 32 bytes.');
  if (head.length < SEAL_HEAD) throw new SealRefused();
  const opening = openingOf(key, head, name);
  openChunk(opening.k, n, true, last, opening.last);
}
