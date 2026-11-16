import { createHmac } from 'node:crypto';
import { z } from 'zod';

/* A site's one-time code as an authenticator app keeps it, and the code it shows at a moment. */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const Totp = z.strictObject({
  secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]),
  period: z.number().int().min(15).max(120),
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']),
});
export type Totp = z.infer<typeof Totp>;

/* The code secret as an authenticator app shows it, in groups and any case, or the otpauth://totp/ address of its QR code
   with its digits, period and algorithm; null when it is neither. */
export function parseTotp(raw: string): Totp | null {
  const text = raw.trim();
  let secret = text;
  const found = { digits: 6, period: 30, algorithm: 'SHA1' };
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== 'totp') return null;
    secret = url.searchParams.get('secret') ?? '';
    found.digits = Number(url.searchParams.get('digits') ?? 6);
    found.period = Number(url.searchParams.get('period') ?? 30);
    found.algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  }
  secret = secret.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase();
  const parsed = Totp.safeParse({ secret, ...found });
  return parsed.success ? parsed.data : null;
}

function base32Bytes(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
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

/* The whole seconds the code of the moment at is still taken. */
export const totpSecondsLeft = (totp: Totp, at: number): number => totp.period - (Math.floor(at / 1000) % totp.period);
