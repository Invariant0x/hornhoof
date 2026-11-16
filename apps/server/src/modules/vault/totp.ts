import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../../errors.js';

const Totp = z.strictObject({
  secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]),
  period: z.number().int().min(15).max(120),
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']),
});
export type Totp = z.infer<typeof Totp>;

const BASE32_PATTERN = /^[A-Z2-7]+$/;
const ALGORITHMS: Record<string, Totp['algorithm']> = { SHA1: 'SHA1', SHA256: 'SHA256', SHA512: 'SHA512' };
const badCode = () => new ApiError(400, 'validation', 'The one-time code secret is not one an authenticator gives. Copy it again from the site, or leave it empty.', 'vault_invalid');

/* The code of a site: its secret as an authenticator app shows it, in groups and any case, or the otpauth://totp/ address
   of its QR code with its digits, period and algorithm. */
export function parseCode(raw: string): Totp {
  const text = raw.trim();
  let secret = text;
  let digits = 6;
  let period = 30;
  let algorithm: Totp['algorithm'] = 'SHA1';
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw badCode();
    }
    if (url.host.toLowerCase() !== 'totp') throw badCode();
    secret = url.searchParams.get('secret') ?? '';
    digits = Number(url.searchParams.get('digits') ?? 6);
    period = Number(url.searchParams.get('period') ?? 30);
    const named = ALGORITHMS[(url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()];
    if (!named) throw badCode();
    algorithm = named;
  }
  secret = secret.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  if (!BASE32_PATTERN.test(secret)) throw badCode();
  const parsed = Totp.safeParse({ secret, digits, period, algorithm });
  if (!parsed.success) throw badCode();
  return parsed.data;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Bytes(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('A one-time code secret is base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* The code of the period that holds the moment at, as RFC 6238 counts it from 1970 in whole periods. */
export function totpCode(totp: Totp, at: number): string {
  const counter = Math.floor(at / 1000 / totp.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(totp.algorithm.toLowerCase(), base32Bytes(totp.secret)).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** totp.digits;
  return String(number).padStart(totp.digits, '0');
}

