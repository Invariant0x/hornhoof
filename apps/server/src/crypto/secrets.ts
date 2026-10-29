import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/* AES-256-GCM, stored as v1.<iv>.<tag>.<data> in base64. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decryptSecret(enc: string, key: Buffer): string {
  const [version, iv, tag, data] = enc.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unknown secret format.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
