import { createHmac } from 'node:crypto';
import { z } from 'zod';

/* A site's one-time code secret as the vault keeps it, and the code it gives at a moment, by RFC 6238. The secret stays on
   the server; only the current code goes to an agent. */

const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const;

export const Totp = z.strictObject({
  secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]),
  period: z.number().int().min(15).max(120),
  algorithm: z.enum(ALGORITHMS),
});
export type Totp = z.infer<typeof Totp>;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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

/* The code of the period that holds the moment at, counted from 1970 in whole periods, and how many seconds it is still
   good for. */
export function totpCode(totp: Totp, at: number): { code: string; validForSeconds: number } {
  const seconds = Math.floor(at / 1000);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(seconds / totp.period)));
  const mac = createHmac(totp.algorithm.toLowerCase(), base32Bytes(totp.secret)).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** totp.digits;
  return { code: String(number).padStart(totp.digits, '0'), validForSeconds: totp.period - (seconds % totp.period) };
}

/* A code secret as an authenticator app shows it, in groups and any case, or the otpauth://totp/ address of its QR code
   with its digits, period and algorithm; null for anything else. */
export function parseTotp(raw: string): Totp | null {
  const text = raw.trim();
  let secret = text;
  let digits = 6;
  let period = 30;
  let algorithm = 'SHA1';
  if (/^otpauth:/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== 'totp') return null;
    secret = url.searchParams.get('secret') ?? '';
    digits = Number(url.searchParams.get('digits') ?? 6);
    period = Number(url.searchParams.get('period') ?? 30);
    algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
  }
  const parsed = Totp.safeParse({ secret: secret.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase(), digits, period, algorithm });
  return parsed.success ? parsed.data : null;
}
