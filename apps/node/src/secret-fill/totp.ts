import { createHmac } from 'node:crypto';
import type { FillTotp } from '@hornhoof/protocol';

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
export function totpCode(totp: FillTotp, at: number): string {
  const counter = Math.floor(at / 1000 / totp.period);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(totp.algorithm.toLowerCase(), base32Bytes(totp.secret)).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** totp.digits;
  return String(number).padStart(totp.digits, '0');
}

/* The codes a site may still take around the moment at: the period before, the current one and the next. */
export function totpCodesAround(totp: FillTotp, at: number): string[] {
  const step = totp.period * 1000;
  return [at - step, at, at + step].map(t => totpCode(totp, t));
}
