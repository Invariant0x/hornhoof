import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

/* A file as the store sealed it before its name was bound into the seal (HHFILE1, #2021): every chunk under the file's
   key with the format's name alone as its associated data. Made here by hand, as the store writes only the new format. */
const MAGIC = Buffer.from('HHFILE1\n', 'latin1');
const CHUNK = 64 * 1024;

export function sealV1(key: Buffer, plain: Buffer): Buffer {
  const salt = randomBytes(16);
  const fileKey = Buffer.from(hkdfSync('sha256', key, salt, 'hornhoof file', 32));
  const out = [MAGIC, salt];
  const count = Math.max(1, Math.ceil(plain.length / CHUNK));
  for (let n = 0; n < count; n++) {
    const nonce = Buffer.alloc(12);
    nonce.writeUIntBE(n, 5, 6);
    nonce[11] = n === count - 1 ? 1 : 0;
    const cipher = createCipheriv('aes-256-gcm', fileKey, nonce);
    cipher.setAAD(MAGIC);
    out.push(cipher.update(plain.subarray(n * CHUNK, (n + 1) * CHUNK)), cipher.final(), cipher.getAuthTag());
  }
  return Buffer.concat(out);
}
