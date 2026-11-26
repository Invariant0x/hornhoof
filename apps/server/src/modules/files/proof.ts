import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/* That a machine keeps the sealed bytes it was given, not only says so: when the leading keeper has given a file whole it
   picks a few slices of it and a nonce, and keeps their HMAC under the nonce. The machine shows it keeps the file by
   reading those slices of its own copy and sending the same HMAC back. It reads at most four slices of 64 KiB, so a
   proof costs little however long the file is, and it never needs the store's key. */

export const PROOF_SLICES = 4;
export const PROOF_SLICE_BYTES = 64 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
export const Slice = z.strictObject({ offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), length: z.number().int().min(1).max(PROOF_SLICE_BYTES) });
export type Slice = z.infer<typeof Slice>;
export const Challenge = z.strictObject({ sha256: z.string().regex(HEX64), nonce: z.string().regex(HEX64), slices: z.array(Slice).min(1).max(PROOF_SLICES) });
export type Challenge = z.infer<typeof Challenge>;
export const Proof = z.strictObject({ sha256: z.string().regex(HEX64), nonce: z.string().regex(HEX64), mac: z.string().regex(HEX64) });
export type Proof = z.infer<typeof Proof>;

/* A nonce and slices to ask of a sealed file of `size` bytes: four slices at random places, each as long as the file
   allows up to 64 KiB. */
export function challengeOf(size: number): { nonce: string; slices: Slice[] } {
  const length = Math.max(1, Math.min(PROOF_SLICE_BYTES, size));
  const slices = Array.from({ length: PROOF_SLICES }, () => ({ offset: randomInt(0, Math.max(1, size - length + 1)), length }));
  return { nonce: randomBytes(32).toString('hex'), slices };
}

/* The HMAC of the slices read, under the nonce. */
export const macOf = (nonce: string, bytes: Buffer): string => createHmac('sha256', Buffer.from(nonce, 'hex')).update(bytes).digest('hex');

/* Whether a MAC sent back is the one kept, compared in constant time. */
export function sameMac(sent: string, kept: string): boolean {
  if (!HEX64.test(sent) || !HEX64.test(kept)) return false;
  return timingSafeEqual(Buffer.from(sent, 'hex'), Buffer.from(kept, 'hex'));
}
