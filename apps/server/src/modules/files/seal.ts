import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/* A file as the store keeps it on any machine: a head of the format's name and a salt of its own, then the bytes in
   sealed chunks. Each chunk is AES-256-GCM under the file's key, made from the store key and the salt, with a nonce of
   its number and a flag on the last one, as age's STREAM has it: a chunk lost, moved, changed or cut off, or a file cut
   where a chunk ends, does not open. Only a machine with the store key opens one; a holder keeps and checks the sealed
   bytes alone. */
export const SEAL_CHUNK = 64 * 1024;
const MAGIC = Buffer.from('HHFILE1\n', 'latin1');
const SALT = 16;
const TAG = 16;
export const SEAL_HEAD = MAGIC.length + SALT;
const KEY = 32;
const SEALED_CHUNK = SEAL_CHUNK + TAG;

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

function sealChunk(key: Buffer, n: number, last: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(n, last));
  cipher.setAAD(MAGIC);
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(key: Buffer, n: number, last: boolean, sealed: Buffer): Buffer {
  if (sealed.length < TAG) throw new SealRefused();
  const decipher = createDecipheriv('aes-256-gcm', key, nonce(n, last));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
  } catch {
    throw new SealRefused();
  }
}

/* Seals what passes through. A chunk goes out once the next byte came, so the last one is known when it is sealed. */
export function seal(key: Buffer): Transform {
  const salt = randomBytes(SALT);
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
        this.push(sealChunk(k, n++, false, held.subarray(0, SEAL_CHUNK)));
        held = held.subarray(SEAL_CHUNK);
      }
      done();
    },
    flush(done: TransformCallback) {
      start(this);
      this.push(sealChunk(k, n, true, held));
      done();
    },
  });
}

/* Opens what passes through, and fails the stream with SealRefused at the first chunk that does not open. A sealed chunk
   is held until more comes, so the one the stream ends with is opened as the last. */
export function openSealed(key: Buffer): Transform {
  if (key.length !== KEY) throw new Error('The store key is 32 bytes.');
  let k: Buffer | null = null;
  let held: Buffer = Buffer.alloc(0);
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      held = held.length ? Buffer.concat([held, chunk]) : chunk;
      try {
        if (!k) {
          if (held.length < SEAL_HEAD) return done();
          if (!held.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealRefused();
          k = fileKey(key, held.subarray(MAGIC.length, SEAL_HEAD));
          held = held.subarray(SEAL_HEAD);
        }
        while (held.length > SEALED_CHUNK) {
          this.push(openChunk(k, n++, false, held.subarray(0, SEALED_CHUNK)));
          held = held.subarray(SEALED_CHUNK);
        }
        done();
      } catch (err) {
        done(err as Error);
      }
    },
    flush(done: TransformCallback) {
      try {
        if (!k) throw new SealRefused();
        this.push(openChunk(k, n, true, held));
        done();
      } catch (err) {
        done(err as Error);
      }
    },
  });
}
